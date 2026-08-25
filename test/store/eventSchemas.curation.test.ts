import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initDb, closeDb } from '../../src/store/index.js';
import {
  curationContext,
  claimMergedPayload,
  claimSplitPayload,
  claimRetractionSetPayload,
  claimRelationCuratedPayload,
  evidenceStanceOverriddenPayload,
  CURATION_COMMAND_ID_MAX_LENGTH,
  CURATION_REASON_MAX_LENGTH,
} from '../../src/store/eventSchemas/graph.js';

// ── Valid fixture payloads ────────────────────────────────────────────

const ctx = { commandId: 'cmd-01', reason: 'duplicate claims', expectedSeq: 7 };

const validMerged = {
  curation: ctx,
  sourceClaimId: 'claim-a',
  survivorClaimId: 'claim-b',
  affectedObservationIds: ['obs-1'],
  affectedEvidenceIds: [],
  affectedRelationIds: [],
  affectedContradictionIds: [],
  affectedGapIds: [],
};

const validSplitResult = {
  claimId: 'claim-x',
  currentObservationId: 'obs-x1',
  observationIds: ['obs-x1', 'obs-x2'],
  evidenceIds: [],
};
const validSplit = {
  curation: ctx,
  sourceClaimId: 'claim-a',
  results: [
    validSplitResult,
    { claimId: 'claim-y', currentObservationId: 'obs-y1', observationIds: ['obs-y1'], evidenceIds: [] },
  ],
};

const validRetraction = {
  curation: ctx,
  target: { kind: 'claim', id: 'claim-a' },
  previousStatus: 'active',
  newStatus: 'retracted',
};

const relationSnapshot = {
  id: 'rel-1',
  fromClaimId: 'claim-a',
  toClaimId: 'claim-b',
  relation: 'supports' as const,
  strength: 'strong' as const,
  score: 0.9,
  runId: 'run-1',
};

const validRelationCurated = {
  curation: ctx,
  relationId: 'rel-1',
  before: null,
  after: relationSnapshot,
};

const validStanceOverride = {
  curation: ctx,
  evidenceId: 'ev-1',
  claimId: 'claim-a',
  previousStance: 'supports' as const,
  newStance: 'opposes' as const,
};

// ── Schema contract tests ─────────────────────────────────────────────

describe('CLAIM_MERGED schema', () => {
  it('accepts a valid payload', () => {
    expect(claimMergedPayload.parse(validMerged)).toEqual(validMerged);
  });

  it('rejects sourceClaimId === survivorClaimId', () => {
    expect(() =>
      claimMergedPayload.parse({ ...validMerged, survivorClaimId: 'claim-a' }),
    ).toThrow();
  });
});

describe('CLAIM_SPLIT schema', () => {
  it('accepts a valid payload', () => {
    expect(claimSplitPayload.parse(validSplit)).toEqual(validSplit);
  });

  it('rejects fewer than 2 results', () => {
    expect(() => claimSplitPayload.parse({ ...validSplit, results: [validSplitResult] })).toThrow();
  });

  it('rejects a result whose observationIds is empty', () => {
    expect(() =>
      claimSplitPayload.parse({
        ...validSplit,
        results: [{ ...validSplitResult, observationIds: [] }, validSplit.results[1]],
      }),
    ).toThrow();
  });

  it('rejects duplicate observation or evidence IDs across results', () => {
    expect(() => claimSplitPayload.parse({ ...validSplit, results: [{ ...validSplitResult, observationIds: ['obs-x1'] }, { ...validSplit.results[1], observationIds: ['obs-x1'] }] })).toThrow();
    expect(() => claimSplitPayload.parse({ ...validSplit, results: [{ ...validSplitResult, evidenceIds: ['ev-1'] }, { ...validSplit.results[1], evidenceIds: ['ev-1'] }] })).toThrow();
  });

  it('rejects currentObservationId not in observationIds', () => {
    expect(() =>
      claimSplitPayload.parse({
        ...validSplit,
        results: [{ ...validSplitResult, currentObservationId: 'obs-other' }, validSplit.results[1]],
      }),
    ).toThrow();
  });
});

describe('CLAIM_RETRACTION_SET schema', () => {
  it('accepts a valid payload (observation target too)', () => {
    expect(claimRetractionSetPayload.parse(validRetraction)).toEqual(validRetraction);
    expect(claimRetractionSetPayload.parse({
      ...validRetraction,
      target: { kind: 'observation', id: 'obs-1' },
    })).toBeDefined();
  });

  it('rejects previousStatus === newStatus (no-op transition)', () => {
    expect(() =>
      claimRetractionSetPayload.parse({ ...validRetraction, newStatus: 'active' }),
    ).toThrow();
  });
});

describe('CLAIM_RELATION_CURATED schema', () => {
  it('accepts creation (before=null) and removal (after=null) individually', () => {
    expect(claimRelationCuratedPayload.parse(validRelationCurated)).toEqual(validRelationCurated);
    expect(claimRelationCuratedPayload.parse({
      ...validRelationCurated,
      before: relationSnapshot,
      after: null,
    })).toBeDefined();
  });

  it('rejects before === after === null', () => {
    expect(() =>
      claimRelationCuratedPayload.parse({ ...validRelationCurated, after: null }),
    ).toThrow();
  });
});

describe('EVIDENCE_STANCE_OVERRIDDEN schema', () => {
  it('accepts a valid payload with previousStance=null (first stance set)', () => {
    expect(evidenceStanceOverriddenPayload.parse({
      ...validStanceOverride,
      previousStance: null,
    })).toBeDefined();
    expect(evidenceStanceOverriddenPayload.parse(validStanceOverride)).toEqual(validStanceOverride);
  });

  it('rejects unknown stance values and missing fields (strict shape)', () => {
    expect(() =>
      evidenceStanceOverriddenPayload.parse({ ...validStanceOverride, extraField: 1 }),
    ).toThrow();
    expect(() =>
      evidenceStanceOverriddenPayload.parse({ ...validStanceOverride, newStance: 'neutral' }),
    ).toThrow();
  });
});

describe('curationContext bounds', () => {
  it('rejects empty commandId/reason and negative/non-integer expectedSeq', () => {
    expect(() => curationContext.parse({ ...ctx, commandId: '' })).toThrow();
    expect(() => curationContext.parse({ ...ctx, reason: '' })).toThrow();
    expect(() => curationContext.parse({ ...ctx, expectedSeq: -1 })).toThrow();
    expect(() => curationContext.parse({ ...ctx, expectedSeq: 1.5 })).toThrow();
  });

  it('rejects over-length commandId/reason at the documented constants', () => {
    expect(() => curationContext.parse({ ...ctx, commandId: 'x'.repeat(CURATION_COMMAND_ID_MAX_LENGTH + 1) })).toThrow();
    expect(() => curationContext.parse({ ...ctx, reason: 'x'.repeat(CURATION_REASON_MAX_LENGTH + 1) })).toThrow();
    expect(curationContext.parse({
      commandId: 'x'.repeat(CURATION_COMMAND_ID_MAX_LENGTH),
      reason: 'x'.repeat(CURATION_REASON_MAX_LENGTH),
      expectedSeq: 0,
    })).toBeDefined();
  });
});

// ── Migration 0003: events.actor_id column ────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-curation-test-'));
  dbPath = path.join(tmpDir, 'test.db');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('migration 0003: events.actor_id', () => {
  it('adds a nullable actor_id column; pre-migration rows survive with NULL', () => {
    // Build an events table at migration-0002 state (no actor_id), insert a row.
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE events (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        id            TEXT NOT NULL UNIQUE,
        timestamp     TEXT NOT NULL,
        event_type    TEXT NOT NULL,
        event_version INTEGER NOT NULL CHECK (event_version >= 1),
        run_id        TEXT NOT NULL,
        batch_id      TEXT,
        actor         TEXT NOT NULL DEFAULT 'system'
                      CHECK (actor IN ('system', 'user', 'classifier', 'rollback')),
        entity_id     TEXT,
        entity_type   TEXT,
        payload       TEXT NOT NULL,
        payload_hash  TEXT NOT NULL CHECK (length(payload_hash) = 64)
      );
      INSERT INTO events (id, timestamp, event_type, event_version, run_id, batch_id, actor, entity_id, entity_type, payload, payload_hash)
      VALUES ('legacy-1', '2024-01-01T00:00:00.000Z', 'RUN_STARTED', 1, 'run-1', NULL, 'system', NULL, NULL, '{}', '${'a'.repeat(64)}');
    `);
    legacyDb.close();

    const db = initDb(dbPath);
    expect(db).not.toBeNull();

    // Column exists and is nullable
    const columns = db!.prepare('PRAGMA table_info(events)').all() as { name: string; notnull: number }[];
    const actorIdCol = columns.find((c) => c.name === 'actor_id');
    expect(actorIdCol).toBeDefined();
    expect(actorIdCol!.notnull).toBe(0);

    // Pre-migration row survived with NULL
    const row = db!.prepare("SELECT actor_id FROM events WHERE id = 'legacy-1'").get() as { actor_id: string | null };
    expect(row.actor_id).toBeNull();

    // Index exists per 0001's (col, seq) convention
    const idx = db!.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='events'").all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain('idx_events_actor_seq');

    // Migration recorded
    const applied = db!.prepare('SELECT version FROM schema_migrations WHERE version = 3').get();
    expect(applied).toBeDefined();
  });

  it('fresh DB path also has actor_id via sequential migrations', () => {
    const db = initDb(dbPath);
    const columns = db!.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('actor_id');
  });
});
