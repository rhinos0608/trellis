import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initDb, closeDb, appendEvents as appendEventsStore, queryEvents, getLatestEventCursor, countEvents, rebuildProjection } from '../../src/store/index.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { handleRunStarted, handleRunCompleted } from '../../src/store/exampleHandlers.js';
import { initializeSchema, SCHEMA_VERSION } from '../../src/store/migrations/index.js';
import { rollbackCrossRunMutation } from '../../src/store/rollback.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import type { TrellisEventType } from '../../src/store/eventTypes.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';

let tmpDir: string;
let dbPath: string;

const HANDLERS: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers, RUN_STARTED: handleRunStarted, RUN_COMPLETED: handleRunCompleted };
function appendEvents(events: readonly ReturnType<typeof makeInput>[]) {
  const projection = createEmptyProjectionState();
  projection.lastAppliedSeq = getLatestEventCursor() ?? 0;
  for (const event of events) {
    const p = event.payload as Record<string, unknown>;
    if (typeof p.familyId === 'string' && !projection.families.has(p.familyId)) projection.families.set(p.familyId, { id: p.familyId, label: p.familyId, manifest: { scopeQuery: p.familyId }, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), relatedFamilies: [] } as never);
    if (event.eventType === 'ENTITY_MERGED') {
      const ids = [p.survivorId, ...((p.mergedIds as string[] | undefined) ?? [])];
      for (const id of ids) if (typeof id === 'string') projection.entities.set(id, { id, label: id, canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: event.runId, lastUpdatedRunId: event.runId, metadata: {} } as never);
    }
    if (event.eventType === 'NODE_RELABELED' && typeof p.targetId === 'string') projection.entities.set(p.targetId, { id: p.targetId, label: p.targetId, canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: event.runId, lastUpdatedRunId: event.runId, metadata: {} } as never);
  }
  return appendEventsStore(events, { projection, handlers: HANDLERS });
}

function makeInput(eventType: TrellisEventType, overrides?: Record<string, unknown>) {
  return {
    eventType,
    eventVersion: 1,
    runId: 'run-test',
    batchId: null as string | null,
    actor: 'system' as const,
    entityId: null as string | null,
    entityType: null as string | null,
    timestamp: new Date().toISOString(),
    payload: {},
    ...overrides,
    ...(eventType === 'NODE_ADDED' ? { payload: { id: 'node', label: 'node', canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: 'run-test', lastUpdatedRunId: 'run-test', metadata: {}, ...(overrides?.payload as Record<string, unknown>) } } : {}),
    ...(eventType === 'RUN_STARTED' ? { payload: { runId: 'run-test', familyId: 'fixture-family', query: 'fixture', strategy: 'agent', ...(overrides?.payload as Record<string, unknown>) } } : {}),
    ...(eventType === 'RUN_COMPLETED' ? { payload: { runId: 'run-test', ...(overrides?.payload as Record<string, unknown>) } } : {}),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-migration-test-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test 1: Fresh DB ────────────────────────────────────────────────

describe('migration 0001: fresh DB', () => {
  it('creates schema_migrations with version 1, new DDL shape, and seq ordering', () => {
    const db = initDb(dbPath);
    expect(db).not.toBeNull();

    // schema_migrations has exactly one row
    const rows = db!.prepare('SELECT * FROM schema_migrations').all() as { version: number; name: string; checksum: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
    expect(rows[0]!.name).toBe('event_store_foundation');
    expect(rows[0]!.checksum).toMatch(/^sha256:/);

    // events table has seq column
    const columns = db!.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain('seq');
    expect(colNames).toContain('id');
    expect(colNames).toContain('payload_hash');

    // Can append and query with ascending seq
    const e1 = appendEvents([makeInput('RUN_STARTED', { runId: 'r1' })]);
    const e2 = appendEvents([makeInput('RUN_COMPLETED', { runId: 'r1' })]);
    expect(e1[0]!.seq).toBe(1);
    expect(e2[0]!.seq).toBe(2);

    const all = queryEvents({});
    expect(all).toHaveLength(2);
    expect(all[0]!.seq).toBe(1);
    expect(all[1]!.seq).toBe(2);
  });
});

// ── Test 2: Populated legacy DB migration ───────────────────────────

describe('migration 0001: legacy DB migration', () => {
  it('preserves all rows with correct seq ordering and fills null payload_hash', () => {
    // First create a legacy schema DB manually
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        timestamp     TEXT NOT NULL,
        event_type    TEXT NOT NULL,
        event_version INTEGER NOT NULL DEFAULT 1,
        run_id        TEXT NOT NULL,
        batch_id      TEXT,
        actor         TEXT NOT NULL DEFAULT 'system',
        entity_id     TEXT,
        entity_type   TEXT,
        payload       TEXT NOT NULL,
        payload_hash  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_run_id ON events(run_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_entity_id ON events(entity_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_batch_id ON events(batch_id);

      CREATE TABLE projection_checkpoints (
        id                 TEXT PRIMARY KEY,
        created_at         TEXT NOT NULL,
        event_cursor       TEXT NOT NULL,
        projection_version INTEGER NOT NULL,
        schema_version     INTEGER NOT NULL,
        event_count        INTEGER NOT NULL,
        checksum           TEXT NOT NULL,
        compatible         INTEGER NOT NULL DEFAULT 1
      );
    `);

    // Insert rows in a specific order that must be preserved
    const t1 = '2024-01-01T00:00:00.000Z';
    const t2 = '2024-02-01T00:00:00.000Z';
    const t3 = '2024-03-01T00:00:00.000Z';
    const payload1 = JSON.stringify({ id: 'e1' });
    const payload2 = JSON.stringify({ id: 'e2' });
    const payload3 = JSON.stringify({ id: 'e3' });

    const insert = legacyDb.prepare(
      `INSERT INTO events (id, timestamp, event_type, event_version, run_id, batch_id, actor, entity_id, entity_type, payload, payload_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Insert out of timestamp order — migration sorts by timestamp ASC, id ASC
    insert.run('id-c', t3, 'RUN_COMPLETED', 1, 'run-1', null, 'system', null, null, payload3, 'hash3');
    insert.run('id-a', t1, 'RUN_STARTED', 1, 'run-1', null, 'system', null, null, payload1, 'hash1');
    insert.run('id-b', t2, 'NODE_ADDED', 1, 'run-2', null, 'system', 'e2', 'entity', payload2, null); // null payload_hash

    legacyDb.close();

    // Now open via the new initDb path — migration runs
    const db = initDb(dbPath);
    expect(db).not.toBeNull();

    // All rows survived
    expect(countEvents()).toBe(3);

    // schema_migrations has version 1
    const migrations = db!.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.version).toBe(1);

    // Seq values are ascending 1..3 in timestamp order: id-a (t1), id-b (t2), id-c (t3)
    const all = queryEvents({});
    expect(all).toHaveLength(3);
    expect(all[0]!.seq).toBe(1);
    expect(all[0]!.id).toBe('id-a');
    expect(all[1]!.seq).toBe(2);
    expect(all[1]!.id).toBe('id-b');
    expect(all[2]!.seq).toBe(3);
    expect(all[2]!.id).toBe('id-c');

    // Previously-null payload_hash is now a valid sha256
    const nodeEvent = all.find((e) => e.eventType === 'NODE_ADDED');
    expect(nodeEvent).toBeDefined();
    expect(nodeEvent!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Test 3: Same-millisecond ordering fix ───────────────────────────

describe('seq ordering: same-millisecond fix', () => {
  it('events with identical timestamps return in insertion (seq) order', () => {
    initDb(dbPath);
    const ts = '2024-06-15T12:00:00.000Z';

    appendEvents([
      makeInput('NODE_ADDED', { runId: 'r1', timestamp: ts, payload: { id: 'e1' } }),
      makeInput('NODE_ADDED', { runId: 'r1', timestamp: ts, payload: { id: 'e2' } }),
      makeInput('NODE_ADDED', { runId: 'r1', timestamp: ts, payload: { id: 'e3' } }),
    ]);

    const all = queryEvents({ eventType: 'NODE_ADDED' });
    expect(all).toHaveLength(3);
    // Must be in insertion order (seq 1, 2, 3)
    expect(all[0]!.seq).toBe(1);
    expect(all[1]!.seq).toBe(2);
    expect(all[2]!.seq).toBe(3);
    expect((all[0]!.payload as { id: string }).id).toBe('e1');
    expect((all[1]!.payload as { id: string }).id).toBe('e2');
    expect((all[2]!.payload as { id: string }).id).toBe('e3');
  });
});

// ── Test 4: Backward clock movement ─────────────────────────────────

describe('seq ordering: backward clock movement', () => {
  it('events with reversed timestamps still return in insertion order', () => {
    initDb(dbPath);

    const early = '2024-01-01T00:00:00.000Z';
    const late = '2024-06-01T00:00:00.000Z';

    // Event A with late timestamp, then Event B with early timestamp (clock skew)
    const a = appendEvents([makeInput('NODE_ADDED', { runId: 'r1', timestamp: late, payload: { id: 'eA' } })]);
    const b = appendEvents([makeInput('NODE_ADDED', { runId: 'r1', timestamp: early, payload: { id: 'eB' } })]);

    const all = queryEvents({ eventType: 'NODE_ADDED' });
    expect(all).toHaveLength(2);
    // A was appended first (lower seq), B second — regardless of timestamp
    expect(all[0]!.seq).toBe(a[0]!.seq);
    expect(all[1]!.seq).toBe(b[0]!.seq);
    expect((all[0]!.payload as { id: string }).id).toBe('eA');
    expect((all[1]!.payload as { id: string }).id).toBe('eB');

    // getLatestEventCursor reflects B (highest seq) despite earlier timestamp
    const cursor = getLatestEventCursor();
    expect(cursor).toBe(b[0]!.seq);
  });
});

// ── Test 5: Pagination via afterSeq ─────────────────────────────────

describe('query: pagination via afterSeq', () => {
  it('pages correctly with afterSeq and limit', () => {
    initDb(dbPath);

    for (let i = 0; i < 10; i++) {
      appendEvents([makeInput('NODE_ADDED', { runId: 'r1', payload: { id: `e${i}` } })]);
    }

    // First page
    const page1 = queryEvents({ limit: 3 });
    expect(page1).toHaveLength(3);
    expect(page1[0]!.seq).toBe(1);
    expect(page1[2]!.seq).toBe(3);

    // Second page
    const page2 = queryEvents({ afterSeq: page1[2]!.seq, limit: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0]!.seq).toBe(4);
    expect(page2[2]!.seq).toBe(6);

    // Third page
    const page3 = queryEvents({ afterSeq: page2[2]!.seq, limit: 3 });
    expect(page3).toHaveLength(3);
    expect(page3[0]!.seq).toBe(7);
    expect(page3[2]!.seq).toBe(9);

    // Fourth page (remaining)
    const page4 = queryEvents({ afterSeq: page3[2]!.seq, limit: 3 });
    expect(page4).toHaveLength(1);
    expect(page4[0]!.seq).toBe(10);

    // No overlap between pages
    const allSeqs = [...page1, ...page2, ...page3, ...page4].map((e) => e.seq);
    const uniqueSeqs = new Set(allSeqs);
    expect(uniqueSeqs.size).toBe(10);
  });
});

// ── Test 6: Migration atomicity ─────────────────────────────────────

describe('migration 0001: atomicity', () => {
  it('rolls back on failure inside the REAL migration 0001.up(), leaving original table intact', () => {
    // Legacy DB with a row whose `actor` value is legal under the OLD schema
    // (plain TEXT, no CHECK) but violates the NEW schema's
    // `CHECK (actor IN ('system','user','classifier','rollback'))` constraint.
    // This forces migration0001's real INSERT INTO events_new to throw partway
    // through the copy loop, inside the runner's real db.transaction() wrapper —
    // not a synthetic stand-in transaction.
    const dbPath2 = path.join(tmpDir, 'atomic-test.db');
    const legacyDb = new Database(dbPath2);
    legacyDb.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_version INTEGER NOT NULL DEFAULT 1,
        run_id TEXT NOT NULL,
        batch_id TEXT,
        actor TEXT NOT NULL DEFAULT 'system',
        entity_id TEXT,
        entity_type TEXT,
        payload TEXT NOT NULL,
        payload_hash TEXT
      );
    `);
    const insert = legacyDb.prepare(
      `INSERT INTO events (id, timestamp, event_type, event_version, run_id, batch_id, actor, entity_id, entity_type, payload, payload_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('id-x', '2024-01-01T00:00:00.000Z', 'RUN_STARTED', 1, 'run-1', null, 'system', null, null, '{"test":true}', 'abc123');
    insert.run('id-y', '2024-01-02T00:00:00.000Z', 'RUN_STARTED', 1, 'run-1', null, 'totally_bogus_actor', null, null, '{"test":true}', 'def456');

    const countBefore = (legacyDb.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt;
    expect(countBefore).toBe(2);
    legacyDb.close();

    // Run the REAL migration runner against this fixture — expect it to throw
    const testDb = new Database(dbPath2);
    expect(() => initializeSchema(testDb)).toThrow();

    // Original `events` table is untouched: still old schema (no `seq` column), same row count
    const columns = testDb.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain('seq');
    const countAfter = (testDb.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt;
    expect(countAfter).toBe(countBefore);

    // events_new must not exist (rolled back by the runner's transaction)
    const hasNew = testDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events_new'")
      .get();
    expect(hasNew).toBeUndefined();

    // Migration must NOT be recorded as applied
    const migrationsTable = testDb
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    if (migrationsTable !== undefined) {
      const appliedRow = testDb.prepare('SELECT 1 FROM schema_migrations WHERE version = 1').get();
      expect(appliedRow).toBeUndefined();
    }

    testDb.close();
  });
});

// ── Test 7: Restart/idempotency ─────────────────────────────────────

describe('migration 0001: restart idempotency', () => {
  it('calling initializeSchema twice does not error or duplicate', () => {
    initDb(dbPath);

    appendEvents([makeInput('RUN_STARTED', { runId: 'r1' })]);
    expect(countEvents()).toBe(1);

    closeDb();

    // Re-open — migration should be a no-op
    const db = initDb(dbPath);
    expect(db).not.toBeNull();

    // Exactly one migration row
    const migrations = db!.prepare('SELECT * FROM schema_migrations').all() as { version: number }[];
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.version).toBe(1);

    // Existing events untouched
    expect(countEvents()).toBe(1);

    // Can still append
    appendEvents([makeInput('RUN_COMPLETED', { runId: 'r1' })]);
    expect(countEvents()).toBe(2);
  });
});

// ── Test 8: Checksum mismatch detection ─────────────────────────────

describe('migration 0001: checksum mismatch detection', () => {
  it('throws when a migration row checksum is tampered', () => {
    initDb(dbPath);

    // Tamper with the checksum
    const db = new Database(dbPath);
    db.prepare("UPDATE schema_migrations SET checksum = 'sha256:tampered' WHERE version = 1").run();
    db.close();

    // Opening again should throw due to checksum mismatch
    expect(() => {
      closeDb();
      const freshDb = new Database(dbPath);
      try {
        initializeSchema(freshDb);
      } finally {
        freshDb.close();
      }
    }).toThrow(/Checksum mismatch/);
  });
});

// ── Test 9: rollback.ts interference-detection-uses-seq ─────────────

describe('rollback: interference detection uses seq, not timestamp', () => {
  it('detects later interference even when timestamp is earlier (clock skew)', () => {
    initDb(dbPath);

    const early = '2024-01-01T00:00:00.000Z';
    const late = '2024-06-01T00:00:00.000Z';

    // Event A: cross_run_mutation (ENTITY_MERGED) with LATE timestamp, seq 1
    appendEvents([
      makeInput('ENTITY_MERGED', {
        runId: 'run-merge',
        timestamp: late,
        entityId: 'ent-a',
        entityType: 'entity',
        payload: {
          survivorId: 'ent-a',
          mergedIds: ['ent-b'],
          mergedSnapshots: [{ id: 'ent-b', label: 'B', aliases: [], metadata: {}, claimIds: [], evidenceIds: [] }],
        },
      }),
    ]);

    // Event B: same entity, EARLIER timestamp (clock skew), seq 2
    appendEvents([
      makeInput('NODE_RELABELED', {
        runId: 'run-other',
        timestamp: early,
        entityId: 'ent-b',
        entityType: 'entity',
        payload: { targetId: 'ent-b', oldLabel: 'old', newLabel: 'new' },
      }),
    ]);

    const state = createEmptyProjectionState();
    const allEvents = queryEvents({});
    const mergeEvent = allEvents.find((e) => e.eventType === 'ENTITY_MERGED')!;

    // B has seq 2 > mergeEvent seq 1, even though B's timestamp is EARLIER
    // Interference detection must find B via seq, not timestamp
    state.lastAppliedSeq = allEvents.at(-1)?.seq ?? 0;
    const outcome = rollbackCrossRunMutation(mergeEvent, state, { projection: state, handlers: HANDLERS });
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind === 'blocked') {
      expect(outcome.reason).toContain('interference');
    }
  });
});
