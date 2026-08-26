/**
 * `trellis restore <bundle-directory> [--replace]` — restore the event store
 * from a verifiable backup bundle. Safety-critical: destructive operation
 * that replaces the live database.
 *
 * Flow: validate bundle → verify integrity → stage → migrate → replay →
 * verify staging → (optional: lock + recovery bundle) → atomic rename →
 * final check → release lock.
 */

import { existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { renameSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { hashPayload } from '../../store/events.js';
import { decodeEventPayload } from '../../store/eventValidation.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../../store/migrations/index.js';
import { rebuildProjection } from '../../store/projectionBuilder.js';
import { verifyProjectionIntegrity } from '../../store/projectionIntegrity.js';
import { computeProjectionChecksum, CURRENT_PROJECTION_VERSION } from '../../store/checkpoints.js';
import { computeEventLogDigest, computeFileSha256 } from '../../store/archiveDigest.js';
import { ALL_HANDLERS } from '../runtime.js';
import { UsageError, printResult, EXIT_CODES } from '../output.js';
import { ArchiveIncompatibleError, DatabaseInUseError } from '../output.js';
import { initDb, closeDb } from '../../store/db.js';
import { rebuildKnowledgeReadModel } from '../../store/readModel/rebuild.js';
import { verifyKnowledgeReadModel } from '../../store/readModel/integrity.js';
import { TRELLIS_VERSION } from '../../version.js';
import type { EventRow } from '../../store/index.js';

/** Error class for archive integrity failures — maps to exit code 3. */
export class ArchiveIntegrityError extends Error {
  readonly code = 'ARCHIVE_INTEGRITY_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveIntegrityError';
  }
}

// ── Manifest types ─────────────────────────────────────────────────

interface BackupManifest {
  format: string;
  formatVersion: number;
  createdAt: string;
  trellisVersion: string;
  sqliteVersion: string;
  schemaVersion: number;
  migrations: { version: number; name: string; checksum: string }[];
  eventLog: {
    count: number;
    firstSeq: number | null;
    latestSeq: number | null;
    latestEventId: string | null;
    latestPayloadHash: string | null;
    digestVersion: number;
    sha256: string;
  };
  projection: {
    version: number;
    checksum: string;
  };
  database: {
    file: string;
    sizeBytes: number;
    sha256: string;
  };
  derivedState: {
    included: boolean;
    authoritative: boolean;
  };
}

// ── Shared validation helpers ──────────────────────────────────────

/**
 * Validate a backup DB file — shared logic between backup verification
 * and restore pre-checks. Opens DB read-only, checks integrity, migration
 * prefix, payload hashes, and codec decoding.
 */
function validateBundleDb(dbPath: string): {
  eventLogDigest: string;
  eventCount: number;
  firstSeq: number | null;
  latestSeq: number | null;
  latestEventId: string | null;
  latestPayloadHash: string | null;
  migrationInfo: { version: number; name: string; checksum: string }[];
  sqliteVersion: string;
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // 1. PRAGMA integrity_check
    const integrityResult = db.pragma('integrity_check', { simple: true });
    if (integrityResult !== 'ok') {
      throw new ArchiveIntegrityError(`Integrity check failed: ${String(integrityResult)}`);
    }

    // 2. Migration prefix check
    const migrationInfo = db
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
      .all() as { version: number; name: string; checksum: string }[];
    const registeredVersions = MIGRATIONS.map((m) => m.version);
    if (migrationInfo.length > registeredVersions.length) {
      throw new ArchiveIntegrityError(
        `Bundle has ${String(migrationInfo.length)} migrations but only ${String(registeredVersions.length)} registered`,
      );
    }
    for (let i = 0; i < migrationInfo.length; i++) {
      const mi = migrationInfo[i];
      const reg = MIGRATIONS[i];
      if (mi === undefined || reg === undefined) continue;
      if (mi.version !== reg.version) {
        throw new ArchiveIntegrityError(
          `Migration version mismatch at index ${String(i)}: bundle has ${String(mi.version)}, expected ${String(reg.version)}`,
        );
      }
      if (mi.checksum !== reg.checksum) {
        throw new ArchiveIntegrityError(
          `Migration checksum mismatch for version ${String(mi.version)}`,
        );
      }
    }

    // 3. Event payload hash verification + codec decode
    const rows = db.prepare('SELECT * FROM events ORDER BY seq ASC').all() as EventRow[];
    for (const row of rows) {
      if (hashPayload(row.payload) !== row.payload_hash) {
        throw new ArchiveIntegrityError(`Payload hash mismatch at seq ${String(row.seq)}`);
      }
      try {
        decodeEventPayload(row.event_type, row.event_version, JSON.parse(row.payload));
      } catch (err) {
        throw new ArchiveIntegrityError(
          `Codec decode failed at seq ${String(row.seq)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 4. Event log digest
    const eventLogDigest = computeEventLogDigest(rows);
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];

    // 5. SQLite version
    const sqliteVersion = (db.prepare('SELECT sqlite_version() as v').get() as { v: string }).v;

    return {
      eventLogDigest,
      eventCount: rows.length,
      firstSeq: firstRow?.seq ?? null,
      latestSeq: lastRow?.seq ?? null,
      latestEventId: lastRow?.id ?? null,
      latestPayloadHash: lastRow?.payload_hash ?? null,
      migrationInfo,
      sqliteVersion,
    };
  } finally {
    db.close();
  }
}

// ── Manifest parsing & validation ──────────────────────────────────

function parseManifest(bundleDir: string): BackupManifest {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new UsageError(`Bundle missing manifest.json: ${bundleDir}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new UsageError('Bundle manifest.json is not valid JSON');
  }

  if (raw === null || typeof raw !== 'object') {
    throw new UsageError('Bundle manifest.json is not an object');
  }

  const m = raw as Record<string, unknown>;

  // Validate required top-level fields
  if (m.format !== 'trellis-sqlite-backup') throw new UsageError('Bundle manifest has unknown format');
  if (m.formatVersion !== 1) throw new UsageError('Bundle manifest has unsupported formatVersion');
  if (typeof m.schemaVersion !== 'number') throw new UsageError('Bundle manifest missing schemaVersion');
  if (!Array.isArray(m.migrations)) throw new UsageError('Bundle manifest missing migrations array');
  if (m.eventLog === null || typeof m.eventLog !== 'object') throw new UsageError('Bundle manifest missing eventLog');
  if (m.database === null || typeof m.database !== 'object') throw new UsageError('Bundle manifest missing database');
  if (m.projection === null || typeof m.projection !== 'object') throw new UsageError('Bundle manifest missing projection');
  if (m.derivedState === null || typeof m.derivedState !== 'object') throw new UsageError('Bundle manifest missing derivedState');

  // Reject unknown top-level keys
  const KNOWN_KEYS = new Set(['format', 'formatVersion', 'createdAt', 'trellisVersion', 'sqliteVersion', 'schemaVersion', 'migrations', 'eventLog', 'projection', 'database', 'derivedState']);
  for (const key of Object.keys(m)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new UsageError(`Bundle manifest has unknown field: ${key}`);
    }
  }

  const eventLog = m.eventLog as Record<string, unknown>;
  if (typeof eventLog.count !== 'number') throw new UsageError('Bundle manifest eventLog.count missing');
  if (typeof eventLog.sha256 !== 'string') throw new UsageError('Bundle manifest eventLog.sha256 missing');
  if (typeof eventLog.latestEventId !== 'string' && eventLog.latestEventId !== null) throw new UsageError('Bundle manifest eventLog.latestEventId invalid');
  if (typeof eventLog.latestPayloadHash !== 'string' && eventLog.latestPayloadHash !== null) throw new UsageError('Bundle manifest eventLog.latestPayloadHash invalid');

  const database = m.database as Record<string, unknown>;
  if (typeof database.file !== 'string') throw new UsageError('Bundle manifest database.file missing');
  if (typeof database.sha256 !== 'string') throw new UsageError('Bundle manifest database.sha256 missing');
  if (typeof database.sizeBytes !== 'number') throw new UsageError('Bundle manifest database.sizeBytes missing');

  const derivedState = m.derivedState as Record<string, unknown>;
  if (typeof derivedState.included !== 'boolean') throw new UsageError('Bundle manifest derivedState.included missing');
  if (typeof derivedState.authoritative !== 'boolean') throw new UsageError('Bundle manifest derivedState.authoritative missing');

  return m as unknown as BackupManifest;
}

// ── Bundle validation (steps 1–5) ─────────────────────────────────

async function validateBundle(
  bundleDir: string,
  targetDbPath: string,
  ioErr: NodeJS.WritableStream,
): Promise<BackupManifest> {
  // Step 1: Validate destination semantics
  const dbFile = path.join(bundleDir, 'trellis.sqlite3');
  const manifestFile = path.join(bundleDir, 'manifest.json');
  if (!existsSync(dbFile)) {
    throw new UsageError(`Bundle missing trellis.sqlite3: ${bundleDir}`);
  }
  if (!existsSync(manifestFile)) {
    throw new UsageError(`Bundle missing manifest.json: ${bundleDir}`);
  }

  // Reject symlinks for bundle database
  const dbStat = lstatSync(dbFile);
  if (dbStat.isSymbolicLink()) {
    throw new UsageError('Bundle database file is a symlink — rejected for safety');
  }

  // Reject if target is a symlink — could point back at the bundle
  if (existsSync(targetDbPath)) {
    const targetStat = lstatSync(targetDbPath);
    if (targetStat.isSymbolicLink()) {
      throw new UsageError('Target database path is a symlink — rejected for safety');
    }
  }

  // Reject if bundle DB and target alias to the same file (uses realpathSync to resolve symlinks)
  const resolvedBundleDb = realpathSync(dbFile);
  // For target: if it doesn't exist yet, resolve its parent directory instead
  let resolvedTargetDb: string;
  if (existsSync(targetDbPath)) {
    resolvedTargetDb = realpathSync(targetDbPath);
  } else {
    const targetDir = path.dirname(targetDbPath);
    resolvedTargetDb = path.join(realpathSync(targetDir), path.basename(targetDbPath));
  }
  if (resolvedBundleDb === resolvedTargetDb) {
    throw new UsageError('Bundle database file and target --db path resolve to the same file');
  }

  // Reject if target resolves into the bundle directory (e.g. --db <bundle-dir>)
  const resolvedBundleDir = realpathSync(bundleDir);
  if (path.dirname(resolvedTargetDb) === resolvedBundleDir || resolvedTargetDb === resolvedBundleDir) {
    throw new UsageError('Bundle directory and target --db path resolve to overlapping locations');
  }

  // Step 2: Parse manifest strictly
  const manifest = parseManifest(bundleDir);

  // Step 3: Verify bundle file hash BEFORE opening as DB
  const dbSha256 = await computeFileSha256(dbFile);
  if (dbSha256 !== manifest.database.sha256) {
    throw new ArchiveIntegrityError(
      `Bundle database hash mismatch: expected ${manifest.database.sha256}, got ${dbSha256}`,
    );
  }

  // Step 4: Open bundle DB read-only and validate
  ioErr.write('restore: validating bundle integrity\n');
  const validation = validateBundleDb(dbFile);

  // Verify event log digest matches manifest
  if (validation.eventLogDigest !== manifest.eventLog.sha256) {
    throw new ArchiveIntegrityError(
      `Bundle event log digest mismatch: expected ${manifest.eventLog.sha256}, got ${validation.eventLogDigest}`,
    );
  }

  // Verify event count matches manifest
  if (validation.eventCount !== manifest.eventLog.count) {
    throw new ArchiveIntegrityError(
      `Bundle event count mismatch: manifest says ${String(manifest.eventLog.count)}, actual ${String(validation.eventCount)}`,
    );
  }

  if (validation.latestEventId !== manifest.eventLog.latestEventId || validation.latestPayloadHash !== manifest.eventLog.latestPayloadHash) {
    throw new ArchiveIntegrityError('Bundle latest event identity does not match manifest');
  }

  // Step 5: Reject incompatible schema
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new ArchiveIncompatibleError(
      `Bundle requires schema version ${String(manifest.schemaVersion)} but current version is ${String(SCHEMA_VERSION)} — cannot downgrade from newer version`,
    );
  }

  return manifest;
}

// ── Staging (steps 6–11) ──────────────────────────────────────────

async function createAndValidateStaging(
  bundleDir: string,
  targetDbPath: string,
  manifest: BackupManifest,
  ioErr: NodeJS.WritableStream,
): Promise<string> {
  const dbFile = path.join(bundleDir, 'trellis.sqlite3');

  // Step 6: Create staging DB via Database.backup() from bundle → unique staging path
  const stagingPath = `${targetDbPath}.trellis-restore-staging-${crypto.randomUUID()}`;
  try {

  ioErr.write('restore: creating staging copy from bundle\n');
  const bundleDb = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    await bundleDb.backup(stagingPath);
  } finally {
    bundleDb.close();
  }

  // Step 7: Open staging writable, apply forward migrations
  const stagingDb = new Database(stagingPath);
  try {
    stagingDb.pragma('journal_mode = WAL');
    stagingDb.pragma('busy_timeout = 5000');

    const appliedVersions = new Set(
      (stagingDb.prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
        .all() as { version: number }[]).map((r) => r.version),
    );
    const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version));
    if (pending.length > 0) {
      ioErr.write(`restore: applying ${String(pending.length)} forward migration(s)\n`);
      const applyMigrations = stagingDb.transaction(() => {
        for (const migration of pending) {
          migration.up(stagingDb);
          stagingDb.prepare(
            'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
          ).run(migration.version, migration.name, new Date().toISOString(), migration.checksum);
        }
      });
      applyMigrations();
    }

    // Step 8: Discard copied derived state
    ioErr.write('restore: discarding copied derived state\n');
    stagingDb.exec("DELETE FROM projection_checkpoints");
    stagingDb.exec("DELETE FROM rm_evidence; DELETE FROM rm_claim_relations; DELETE FROM rm_claim_observations; DELETE FROM rm_claims; DELETE FROM rm_sources;");
    stagingDb.prepare("UPDATE rm_state SET status='dirty', updated_at=? WHERE model_name='knowledge'").run(
      new Date().toISOString());
  } finally {
    stagingDb.close();
  }

  // Step 9: Force-genesis replay on staging
  // We need to use the global singleton DB for projectionBuilder/queries
  ioErr.write('restore: rebuilding projection from event log\n');
  initDb(stagingPath);
  try {
    rebuildProjection(ALL_HANDLERS, { forceGenesis: true, writeCheckpoint: true });
  } finally {
    closeDb();
  }

  // Step 10: Rebuild read model on staging
  ioErr.write('restore: rebuilding read model\n');
  initDb(stagingPath);
  try {
    rebuildKnowledgeReadModel(ALL_HANDLERS);
  } finally {
    closeDb();
  }

  // Step 11: Verify staging — projection checksum stability + manifest match + integrity + read model
  ioErr.write('restore: verifying staging integrity\n');
  initDb(stagingPath, { readonly: true });
  try {
    // Replay twice, compare checksums
    const state1 = rebuildProjection(ALL_HANDLERS, { forceGenesis: true, writeCheckpoint: false });
    const checksum1 = computeProjectionChecksum(state1);

    const state2 = rebuildProjection(ALL_HANDLERS, { forceGenesis: true, writeCheckpoint: false });
    const checksum2 = computeProjectionChecksum(state2);

    if (checksum1 !== checksum2) {
      throw new ArchiveIntegrityError(
        `Projection checksum not stable: ${checksum1} vs ${checksum2}`,
      );
    }

    // Compare against manifest's declared projection checksum
    if (manifest.projection.checksum !== '' && checksum1 !== manifest.projection.checksum) {
      throw new ArchiveIntegrityError(
        `Projection checksum mismatch: manifest declares ${manifest.projection.checksum}, actual ${checksum1}`,
      );
    }

    const integrity = verifyProjectionIntegrity(state2);
    if (!integrity.matches) {
      throw new ArchiveIntegrityError(
        `Projection integrity failed on staging: ${integrity.mismatches.slice(0, 3).join('; ')}`,
      );
    }

    // Verify read model parity
    const readModelResult = verifyKnowledgeReadModel(state2);
    if (!readModelResult.matches) {
      throw new ArchiveIntegrityError(
        `Read model integrity failed on staging: ${readModelResult.mismatches.slice(0, 3).join('; ')}`,
      );
    }
  } finally {
    closeDb();
  }

    return stagingPath;
  } catch (err) {
    try { unlinkSync(stagingPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

// ── Lock management ────────────────────────────────────────────────

function acquireRestoreLock(targetDbPath: string): string {
  const lockPath = targetDbPath + '.restore-lock';
  try {
    const fd = openSync(lockPath, 'wx');
    closeSync(fd);
    return lockPath;
  } catch {
    throw new DatabaseInUseError(
      `Cannot acquire restore lock — another operation may be in progress: ${lockPath}`,
    );
  }
}

function releaseRestoreLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* best-effort */ }
}

function checkDatabaseInUse(dbPath: string): void {
  // Non-mutating probe: open read-only and run a trivial read.
  // A read-only open never checkpoints WAL, so no bytes of the target are
  // mutated. If another process holds an exclusive lock the open will fail.
  // The lock file (acquired above) is the authoritative concurrency guard;
  // this is a best-effort secondary check.
  try {
    const probe = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      probe.prepare('SELECT 1').get();
    } finally {
      probe.close();
    }
  } catch {
    throw new DatabaseInUseError(
      `Database appears to be in use by another process: ${dbPath}`,
    );
  }
}

// ── Recovery bundle (step 12 partial) ──────────────────────────────

function computeFileSha256Sync(filePath: string): string {
  const data = readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function createRecoveryBundle(
  currentTargetPath: string,
  timestamp: string,
  ioErr: NodeJS.WritableStream,
): Promise<string> {
  const parentDir = path.dirname(currentTargetPath);
  const recoveryDir = path.join(
    parentDir,
    `.trellis-restore-recovery-${timestamp}`,
  );
  mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });

  const dbFileName = 'trellis.sqlite3';
  const recoveryDbPath = path.join(recoveryDir, dbFileName);

  // Use Database.backup() for the recovery copy
  const currentDb = new Database(currentTargetPath, { fileMustExist: true });
  try {
    await currentDb.backup(recoveryDbPath);
  } finally {
    currentDb.close();
  }

  // Validate recovery copy — reuses the same validation path as bundle restore
  const validation = validateBundleDb(recoveryDbPath);

  // Compute file SHA-256
  const dbSha256 = computeFileSha256Sync(recoveryDbPath);
  const stats = statSync(recoveryDbPath);

  // Compute projection checksum via force-genesis replay
  initDb(recoveryDbPath, { readonly: true });
  let projectionChecksum: string;
  try {
    const state = rebuildProjection(ALL_HANDLERS, { forceGenesis: true, writeCheckpoint: false });
    projectionChecksum = computeProjectionChecksum(state);
  } finally {
    closeDb();
  }

  // Build a FULLY VALID manifest — same shape as backup.ts produces
  const manifest = {
    format: 'trellis-sqlite-backup',
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    trellisVersion: TRELLIS_VERSION,
    sqliteVersion: validation.sqliteVersion,
    schemaVersion: SCHEMA_VERSION,
    migrations: validation.migrationInfo,
    eventLog: {
      count: validation.eventCount,
      firstSeq: validation.firstSeq,
      latestSeq: validation.latestSeq,
      latestEventId: validation.latestEventId,
      latestPayloadHash: validation.latestPayloadHash,
      digestVersion: 1,
      sha256: validation.eventLogDigest,
    },
    projection: {
      version: CURRENT_PROJECTION_VERSION,
      checksum: projectionChecksum,
    },
    database: { file: dbFileName, sizeBytes: stats.size, sha256: dbSha256 },
    derivedState: { included: true, authoritative: false },
  };

  writeFileSync(path.join(recoveryDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  ioErr.write(`restore: recovery bundle created at ${recoveryDir}\n`);
  return recoveryDir;
}

// ── Main command ───────────────────────────────────────────────────

export async function runRestore(ctx: {
  io: { out: NodeJS.WritableStream; err: NodeJS.WritableStream; json: boolean };
  rt?: unknown;
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  positionals: string[];
}): Promise<number> {
  const bundleArg = ctx.positionals[0];
  if (bundleArg === undefined || ctx.positionals.length > 1) {
    throw new UsageError('Usage: trellis restore <bundle-directory> [--replace]');
  }

  const bundleDir = path.resolve(bundleArg);
  const replaceFlag = ctx.values.replace === true;

  // Resolve target DB path from --db or default config
  let targetDbPath: string;
  if (typeof ctx.values.db === 'string') {
    targetDbPath = path.resolve(ctx.values.db);
  } else {
    const { loadConfig } = await import('../../config/index.js');
    const config = loadConfig();
    targetDbPath = path.resolve(config.storage.dbPath);
  }

  let stagingPath: string | undefined;
  const lockPath = acquireRestoreLock(targetDbPath);
  let recoveryBundlePath: string | undefined;
  const targetExists = existsSync(targetDbPath);
  try {
    // Steps 1-5: Validate bundle (no mutation of target)
    const manifest = await validateBundle(bundleDir, targetDbPath, ctx.io.err);

    // Steps 6-11: Create and validate staging while lock is held
    stagingPath = await createAndValidateStaging(bundleDir, targetDbPath, manifest, ctx.io.err);

    if (targetExists && !replaceFlag) {
      throw new UsageError(
        `Target database already exists: ${targetDbPath} — use --replace to overwrite`,
      );
    }

    // Step 12: Check target and create recovery bundle while lock is held
    if (targetExists) {
      checkDatabaseInUse(targetDbPath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      recoveryBundlePath = await createRecoveryBundle(targetDbPath, timestamp, ctx.io.err);
    }

    // Step 13: Fsync staging file + atomic rename staging → target
    ctx.io.err.write('restore: performing atomic rename\n');
    const stagingFd = openSync(stagingPath, 'r');
    try { fsyncSync(stagingFd); } finally { closeSync(stagingFd); }
    try {
      const dirFd = openSync(path.dirname(stagingPath), 'r');
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch { /* directory fsync unsupported on this platform — degrade gracefully */ }
    renameSync(stagingPath, targetDbPath);

    // Step 14: Reopen restored target read-only and run quick_check
    ctx.io.err.write('restore: running final verification\n');
    const finalDb = new Database(targetDbPath, { readonly: true, fileMustExist: true });
    try {
      const quickCheck = finalDb.pragma('quick_check', { simple: true });
      if (quickCheck !== 'ok') throw new ArchiveIntegrityError(`Post-restore quick_check failed: ${String(quickCheck)} — database may be corrupt`);
    } finally { finalDb.close(); }

    const data: Record<string, unknown> = { target: targetDbPath, schemaVersion: SCHEMA_VERSION, eventCount: manifest.eventLog.count, latestSeq: manifest.eventLog.latestSeq };
    if (recoveryBundlePath !== undefined) data.recoveryBundle = recoveryBundlePath;
    printResult(ctx.io, data, 'restore');
    return EXIT_CODES.OK;
  } finally {
    if (stagingPath !== undefined) try { unlinkSync(stagingPath); } catch { /* already renamed */ }
    releaseRestoreLock(lockPath);
  }
}
