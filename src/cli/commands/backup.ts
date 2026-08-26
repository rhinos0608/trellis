/**
 * `trellis backup <bundle-directory>` — read-only snapshot of the event store.
 *
 * Produces a bundle directory containing a SQLite backup copy and a manifest
 * with integrity metadata. All validation runs against the backup copy, never
 * the live database.
 */

import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPayload } from '../../store/events.js';
import { decodeEventPayload } from '../../store/eventValidation.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../../store/migrations/index.js';
import { rebuildProjection } from '../../store/projectionBuilder.js';
import { verifyProjectionIntegrity } from '../../store/projectionIntegrity.js';
import { computeProjectionChecksum, CURRENT_PROJECTION_VERSION } from '../../store/checkpoints.js';
import { computeEventLogDigest, computeFileSha256 } from '../../store/archiveDigest.js';
import { ALL_HANDLERS, requireCliRuntime } from '../runtime.js';
import type { CommandContext } from '../runtime.js';
import type { EventRow } from '../../store/index.js';
import { UsageError, printResult, EXIT_CODES } from '../output.js';
import { TRELLIS_VERSION } from '../../version.js';
import Database from 'better-sqlite3';
import { initDb, closeDb } from '../../store/db.js';

/** Error class for archive integrity failures — maps to exit code 3. */
export class ArchiveIntegrityError extends Error {
  readonly code = 'ARCHIVE_INTEGRITY_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveIntegrityError';
  }
}

/** Error class for destination-already-exists — maps to exit code 4. */
export class DestinationExistsError extends Error {
  readonly code = 'DESTINATION_EXISTS';
  constructor(message: string) {
    super(message);
    this.name = 'DestinationExistsError';
  }
}

function validateBackupDb(backupDbPath: string): {
  migrationInfo: { version: number; name: string; checksum: string }[];
  eventLogDigest: string;
  eventCount: number;
  firstSeq: number | null;
  latestSeq: number | null;
  latestEventId: string | null;
  latestPayloadHash: string | null;
  projectionChecksum: string;
  sqliteVersion: string;
} {
  const backupDb = new Database(backupDbPath, { readonly: true, fileMustExist: true });
  let backupDbClosed = false;

  try {
    // 1. PRAGMA integrity_check
    const integrityResult = backupDb.pragma('integrity_check', { simple: true });
    if (integrityResult !== 'ok') {
      throw new ArchiveIntegrityError(`Integrity check failed: ${String(integrityResult)}`);
    }

    // 2. SQLite version
    const sqliteVersion = (backupDb.prepare('SELECT sqlite_version() as v').get() as { v: string }).v;

    // 3. Migration prefix check
    const migrationInfo = backupDb
      .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
      .all() as { version: number; name: string; checksum: string }[];

    const registeredVersions = MIGRATIONS.map((m) => m.version);
    if (migrationInfo.length > registeredVersions.length) {
      throw new ArchiveIntegrityError(
        `Backup has ${String(migrationInfo.length)} migrations but only ${String(registeredVersions.length)} registered`,
      );
    }
    for (let i = 0; i < migrationInfo.length; i++) {
      const mi = migrationInfo[i];
      const reg = MIGRATIONS[i];
      if (mi === undefined || reg === undefined) continue;
      if (mi.version !== reg.version) {
        throw new ArchiveIntegrityError(
          `Migration version mismatch at index ${String(i)}: backup has ${String(mi.version)}, expected ${String(reg.version)}`,
        );
      }
      if (mi.checksum !== reg.checksum) {
        throw new ArchiveIntegrityError(
          `Migration checksum mismatch for version ${String(mi.version)}`,
        );
      }
    }

    // 4. Event payload hash verification + codec decode
    const rows = backupDb.prepare('SELECT * FROM events ORDER BY seq ASC').all() as EventRow[];

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

    // 5. Force-genesis replay + projection integrity from backup snapshot
    backupDb.close();
    backupDbClosed = true;
    initDb(backupDbPath, { readonly: true });
    let projState;
    try {
      projState = rebuildProjection(ALL_HANDLERS, { forceGenesis: true, writeCheckpoint: false });
    } finally {
      closeDb();
    }
    const projIntegrity = verifyProjectionIntegrity(projState);
    if (!projIntegrity.matches) {
      throw new ArchiveIntegrityError(
        `Projection integrity failed: ${projIntegrity.mismatches.slice(0, 3).join('; ')}`,
      );
    }

    const projectionChecksum = computeProjectionChecksum(projState);

    // Event log digest
    const eventLogDigest = computeEventLogDigest(rows);

    const firstRow = rows.length > 0 ? rows[0] : undefined;
    const lastRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
    const firstSeq = firstRow?.seq ?? null;
    const latestSeq = lastRow?.seq ?? null;
    const latestEventId = lastRow?.id ?? null;
    const latestPayloadHash = lastRow?.payload_hash ?? null;

    return {
      migrationInfo,
      eventLogDigest,
      eventCount: rows.length,
      firstSeq,
      latestSeq,
      latestEventId,
      latestPayloadHash,
      projectionChecksum,
      sqliteVersion,
    };
  } finally {
    if (!backupDbClosed) backupDb.close();
  }
}

export async function runBackup(ctx: CommandContext): Promise<number> {
  const destArg = ctx.positionals[0];
  if (destArg === undefined || ctx.positionals.length > 1) {
    throw new UsageError('Usage: trellis backup <bundle-directory>');
  }

  const destPath = path.resolve(destArg);

  // 1. Refuse if destination exists
  if (existsSync(destPath)) {
    throw new DestinationExistsError(`Destination already exists: ${destPath}`);
  }

  // 2. Create sibling temporary directory
  const parentDir = path.dirname(destPath);
  const tempName = `.trellis-backup-${String(Date.now())}-${crypto.randomUUID().slice(0, 8)}`;
  const tempDir = path.join(parentDir, tempName);

  try {
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });

    const backupDbName = 'trellis.sqlite3';
    const backupDbPath = path.join(tempDir, backupDbName);

    // 3. Online Backup API against the live DB
    await requireCliRuntime(ctx).db.backup(backupDbPath);

    // 4. Validate the backup copy
    ctx.io.err.write('backup: validating backup copy\n');
    const validation = validateBackupDb(backupDbPath);

    // 5. Flush backup bytes before deriving manifest metadata.
    const backupFd = openSync(backupDbPath, 'r');
    try { fsyncSync(backupFd); } finally { closeSync(backupFd); }
    const dbSha256 = await computeFileSha256(backupDbPath);
    const dbStats = statSync(backupDbPath);

    // 6. Write manifest.json
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
        checksum: validation.projectionChecksum,
      },
      database: {
        file: backupDbName,
        sizeBytes: dbStats.size,
        sha256: dbSha256,
      },
      derivedState: {
        included: true,
        authoritative: false,
      },
    };

    const manifestPath = path.join(tempDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    try { chmodSync(manifestPath, 0o600); } catch { /* platform may not support chmod */ }
    const manifestFd = openSync(manifestPath, 'r');
    try { fsyncSync(manifestFd); } finally { closeSync(manifestFd); }

    // 7. Flush bundle directory before and after atomic rename.
    try {
      const parentFd = openSync(parentDir, 'r');
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    } catch { /* directory fsync unsupported on this platform */ }
    renameSync(tempDir, destPath);
    try {
      const parentFd = openSync(parentDir, 'r');
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    } catch { /* directory fsync unsupported on this platform */ }

    // Success
    const data = {
      bundle: destPath,
      createdAt: manifest.createdAt,
      schemaVersion: SCHEMA_VERSION,
      eventCount: validation.eventCount,
      latestSeq: validation.latestSeq,
      dbSha256,
      projectionChecksum: validation.projectionChecksum,
    };

    printResult(ctx.io, data, 'backup');
    return EXIT_CODES.OK;
  } catch (err) {
    // Cleanup temp dir on failure
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort: ignore cleanup errors */ }
    throw err;
  }
}
