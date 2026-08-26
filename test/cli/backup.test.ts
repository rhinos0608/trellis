/**
 * Tests for `trellis backup` CLI command.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import type { TrellisEventType } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';
import { appendEvents, closeDb, getLatestEventCursor, initDb, rebuildProjection } from '../../src/store/index.js';
import { rebuildKnowledgeReadModel } from '../../src/store/readModel/index.js';
import { runCli } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';
import { hashPayload } from '../../src/store/events.js';
import { computeEventLogDigest } from '../../src/store/archiveDigest.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };

// ── Capture streams ──────────────────────────────────────────────────

class StringWriter {
  private readonly parts: string[] = [];
  write(chunk: unknown): boolean {
    this.parts.push(String(chunk));
    return true;
  }
  get value(): string {
    return this.parts.join('');
  }
}

function makeIo(json: boolean): { io: CliIo; out: StringWriter; err: StringWriter } {
  const out = new StringWriter();
  const err = new StringWriter();
  return { io: { out: out as unknown as NodeJS.WritableStream, err: err as unknown as NodeJS.WritableStream, json }, out, err };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const { io, out, err } = makeIo(args.includes('--json'));
  const code = await runCli(['--db', dbPath, ...args], io);
  return { code, out: out.value, err: err.value };
}

function lastJson<T>(out: string): T & { ok: boolean; command: string } {
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '') as T & { ok: boolean; command: string };
}

// ── Seeding helpers ──

let tempDir: string;
let dbPath: string;

function event(eventType: TrellisEventType, payload: unknown, timestamp = '2025-01-01T00:00:00.000Z'): NewEventInput {
  return { timestamp, eventType, eventVersion: eventType === 'EVIDENCE_LINKED' ? 2 : 1, runId: 'run-backup', batchId: null, actor: 'user', actorId: 'operator', entityId: null, entityType: null, payload } as NewEventInput;
}

function seedBase(): void {
  appendEvents([
    event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }),
    event('SOURCE_ADDED', { id: 'source-1', url: 'https://example.test/source', domain: 'example.test', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', contentHash: 'hash', retrievedAt: '2025-01-01T00:00:00.000Z', firstSeenRunId: 'run-backup' }),
    event('NODE_ADDED', { id: 'entity-1', label: 'Test Entity', canonicalLabel: 'test entity', entityType: 'concept', aliases: [], extractionConfidence: 0.8, firstSeenRunId: 'run-backup', lastUpdatedRunId: 'run-backup', metadata: {} }),
    event('CLAIM_ACCEPTED', { id: 'claim-a', subjectText: 'A improves B', predicate: 'improves', objectText: 'research', polarity: 'asserted', hedge: 'certain', evidenceType: 'study', canonicalKey: { subject: 'a improves b', predicate: 'improves' }, familyId: 'family-1', confidence: 0.5, contradictionState: 'none', firstSeenRunId: 'run-backup', lastSeenRunId: 'run-backup' }),
    event('CLAIM_OBSERVED', { observation: { id: 'obs-a', familyId: 'family-1', subjectText: 'A improves B', predicate: 'improves', objectText: 'research', polarity: 'asserted', hedge: 'certain', evidenceType: 'study', canonicalKey: { subject: 'a improves b', predicate: 'improves' }, runId: 'run-backup', observedAt: '2025-01-01T00:00:01.000Z', confidence: 0.7, sourceIds: ['source-1'], extractionVersion: 'v1' }, reconciliation: { observationId: 'obs-a', classification: 'new_claim', canonicalClaimId: 'claim-a', score: 1, method: 'canonical_key_exact', rationale: 'test', reconcilerVersion: 1, candidates: [] } }, '2025-01-01T00:00:01.000Z'),
    event('EVIDENCE_LINKED', { id: 'evd-a-1', claimId: 'claim-a', sourceId: 'source-1', stance: 'supports', excerpt: 'evidence text', runId: 'run-backup', observationId: 'obs-a' }, '2025-01-01T00:00:01.000Z'),
  ], { projection: rebuildProjection(handlers), handlers });
  rebuildKnowledgeReadModel(handlers);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-backup-'));
  dbPath = path.join(tempDir, 'trellis.db');
  expect(initDb(dbPath)).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('trellis backup', () => {
  it('creates a bundle with manifest and correct DB', async () => {
    seedBase();
    const bundleDir = path.join(tempDir, 'my-bundle');
    const { code, out } = await run(['backup', bundleDir, '--json']);
    expect(code).toBe(0);
    const body = lastJson<{ data: { bundle: string; eventCount: number; latestSeq: number; dbSha256: string; projectionChecksum: string } }>(out);
    expect(body.ok).toBe(true);
    expect(body.data.bundle).toBe(bundleDir);
    expect(body.data.eventCount).toBeGreaterThanOrEqual(6);
    expect(body.data.latestSeq).toBeGreaterThanOrEqual(6);

    // Bundle directory exists with expected files
    expect(fs.existsSync(path.join(bundleDir, 'trellis.sqlite3'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'manifest.json'))).toBe(true);

    // Manifest is valid JSON with correct shape
    const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, 'manifest.json'), 'utf8'));
    expect(manifest.format).toBe('trellis-sqlite-backup');
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.schemaVersion).toBeGreaterThanOrEqual(4);
    expect(manifest.eventLog.count).toBe(body.data.eventCount);
    expect(manifest.eventLog.sha256).toBeTypeOf('string');
    expect(manifest.database.sha256).toBe(body.data.dbSha256);
    expect(manifest.projection.checksum).toBe(body.data.projectionChecksum);
    expect(manifest.derivedState.included).toBe(true);
    expect(manifest.derivedState.authoritative).toBe(false);

    // DB SHA-256 matches recomputed hash
    const dbContent = fs.readFileSync(path.join(bundleDir, 'trellis.sqlite3'));
    const crypto = await import('node:crypto');
    const recomputed = crypto.createHash('sha256').update(dbContent).digest('hex');
    expect(body.data.dbSha256).toBe(recomputed);
  });

  it('fails with DESTINATION_EXISTS when destination already exists', async () => {
    seedBase();
    const bundleDir = path.join(tempDir, 'existing-bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    const { code, out } = await run(['backup', bundleDir, '--json']);
    expect(code).toBe(4);
    const body = lastJson<{ ok: boolean; error: { code: string } }>(out);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('DESTINATION_EXISTS');
  });

  it('produces internally consistent snapshot with concurrent writer', async () => {
    seedBase();
    const bundleDir = path.join(tempDir, 'concurrent-bundle');

    // Start appending events in a separate connection while backup runs
    const concurrentDb = new Database(dbPath);
    concurrentDb.pragma('journal_mode = WAL');
    concurrentDb.pragma('busy_timeout = 5000');

    const insert = concurrentDb.prepare(
      `INSERT INTO events (id, timestamp, event_type, event_version, run_id, batch_id, actor, actor_id, entity_id, entity_type, payload, payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Run backup and concurrent writes simultaneously
    const backupPromise = run(['backup', bundleDir, '--json']);

    // Append a few events concurrently
    for (let i = 0; i < 5; i++) {
      const payload = JSON.stringify({ family_id: `concurrent-${String(i)}`, label: `Concurrent ${String(i)}` });
      const payloadHash = hashPayload(payload);
      insert.run(`ulid-${String(Date.now())}-${String(i)}`, new Date().toISOString(), 'FAMILY_CREATED', 1, 'run-concurrent', null, 'user', 'operator', null, null, payload, payloadHash);
    }

    const { code, out } = await backupPromise;
    concurrentDb.close();

    expect(code).toBe(0);

    // Force-genesis replay of the backup DB should succeed
    const body = lastJson<{ data: { eventCount: number } }>(out);
    expect(body.ok).toBe(true);

    // Verify the backup DB independently
    const backupDbPath = path.join(bundleDir, 'trellis.sqlite3');
    const backupDb = new Database(backupDbPath, { readonly: true, fileMustExist: true });
    const integrity = backupDb.pragma('integrity_check', { simple: true });
    expect(integrity).toBe('ok');

    // All events should have valid hashes
    const rows = backupDb.prepare('SELECT * FROM events ORDER BY seq ASC').all() as { payload: string; payload_hash: string }[];
    for (const row of rows) {
      expect(hashPayload(row.payload)).toBe(row.payload_hash);
    }
    backupDb.close();
  });

  it('detects tampering via canonical digest mismatch', async () => {
    seedBase();
    const bundleDir = path.join(tempDir, 'tamper-bundle');
    const { code } = await run(['backup', bundleDir, '--json']);
    expect(code).toBe(0);

    // Read the original event rows from the backup DB
    const backupDbPath = path.join(bundleDir, 'trellis.sqlite3');
    const backupDb = new Database(backupDbPath, { readonly: true });
    const rows = backupDb.prepare('SELECT * FROM events ORDER BY seq ASC').all() as Array<{ seq: number; id: string; timestamp: string; event_type: string; event_version: number; run_id: string; batch_id: string | null; actor: string; actor_id: string | null; entity_id: string | null; entity_type: string | null; payload: string; payload_hash: string }>;
    const originalDigest = computeEventLogDigest(rows);
    backupDb.close();

    // Tamper with one event's payload in the backup DB
    const raw = new Database(backupDbPath);
    raw.prepare("UPDATE events SET payload = payload || ' TAMPERED' WHERE seq = (SELECT MIN(seq) FROM events)").run();
    const tamperedRows = raw.prepare('SELECT * FROM events ORDER BY seq ASC').all() as typeof rows;
    const tamperedDigest = computeEventLogDigest(tamperedRows);
    raw.close();

    // Digests must differ
    expect(tamperedDigest).not.toBe(originalDigest);
  });

  it('no temp directory left behind on failure', async () => {
    seedBase();
    const bundleDir = path.join(tempDir, 'fail-bundle');
    // First run succeeds
    await run(['backup', bundleDir, '--json']);
    // Second run fails (destination exists)
    const { code } = await run(['backup', bundleDir, '--json']);
    expect(code).toBe(4);

    // No temp directories left
    const entries = fs.readdirSync(tempDir).filter((e) => e.startsWith('.trellis-backup-'));
    expect(entries).toHaveLength(0);
  });

  it('usage error when no argument given', async () => {
    seedBase();
    const { code, out } = await run(['backup', '--json']);
    expect(code).toBe(2);
    const body = lastJson<{ ok: boolean; error: { code: string } }>(out);
    expect(body.error.code).toBe('USAGE_ERROR');
  });
});
