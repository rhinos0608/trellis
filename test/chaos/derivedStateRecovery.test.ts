/**
 * Chaos tests: derived-state checkpoint recovery.
 *
 * Verifies that corrupted or tampered projection checkpoints
 * are silently ignored with a logged warning, and rebuild falls
 * back to genesis replay producing a correct projection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../../src/store/db.js';
import {
  initDb,
  closeDb,
  appendEvents as appendEventsStore,
  rebuildProjection,
  computeProjectionChecksum,
  getLatestCompatibleCheckpoint,
  createEmptyProjectionState,
  serializeProjectionState,
  deserializeProjectionState,
  CURRENT_PROJECTION_VERSION,
} from '../../src/store/index.js';
import type { EventEnvelope, TrellisEventType } from '../../src/store/eventTypes.js';
import type { EventHandlerRegistry, ProjectionState } from '../../src/store/projectionState.js';
import type { NewEventInput } from '../../src/store/events.js';
import { rebuildKnowledgeReadModel, verifyKnowledgeReadModel, getKnowledgeReadModelStatus } from '../../src/store/readModel/index.js';
import { verifyProjectionIntegrity } from '../../src/store/projectionIntegrity.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;

function makeEvent(
  overrides: Partial<NewEventInput> & { eventType: TrellisEventType },
): NewEventInput {
  return {
    timestamp: new Date().toISOString(),
    eventVersion: 1,
    runId: 'run-test',
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload: {},
    ...overrides,
    ...(overrides.eventType === 'NODE_ADDED' ? {
      payload: {
        id: 'node', label: 'node', canonicalLabel: null, entityType: 'unknown', aliases: [],
        extractionConfidence: null, firstSeenRunId: overrides.runId ?? 'run-test', lastUpdatedRunId: overrides.runId ?? 'run-test', metadata: {},
        ...(overrides.payload as Record<string, unknown>),
      },
    } : {}),
  };
}

const nodeAddedHandler = (event: EventEnvelope, state: ProjectionState) => {
  const p = event.payload as { id: string; label: string; type?: string };
  state.entities.set(p.id, {
    id: p.id,
    label: p.label,
    canonicalLabel: null,
    entityType: p.type ?? 'unknown',
    aliases: [],
    extractionConfidence: null,
    firstSeenRunId: event.runId,
    lastUpdatedRunId: event.runId,
    metadata: {},
  });
};

const HANDLERS: EventHandlerRegistry = { NODE_ADDED: nodeAddedHandler };
function appendEvents(events: readonly NewEventInput[], projection: ProjectionState): EventEnvelope[] {
  return appendEventsStore(events, { projection, handlers: HANDLERS });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-checkpoint-chaos-'));
  const db = initDb(path.join(tmpDir, 'test.db'));
  expect(db).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Test: malformed JSON checkpoint → fallback to genesis ──────────

describe('checkpoint recovery: malformed JSON', () => {
  it('corrupted snapshot_json (invalid JSON) → rebuild falls back to genesis, produces correct projection', () => {
    let projection = rebuildProjection(HANDLERS);

    // Append some events
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e1', payload: { id: 'e1', label: 'Alpha' } }),
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e2', payload: { id: 'e2', label: 'Beta' } }),
    ], projection);

    // Rebuild — creates a checkpoint
    projection = rebuildProjection(HANDLERS);
    expect(projection.entities.size).toBe(2);
    const cleanChecksum = computeProjectionChecksum(projection);

    // Corrupt the checkpoint's snapshot_json with invalid JSON
    const db = getDb()!;
    db.prepare("UPDATE projection_checkpoints SET snapshot_json = '{invalid json!!!' WHERE compatible = 1").run();

    // Rebuild — should detect corruption, log warning, fall back to genesis
    const rebuilt = rebuildProjection(HANDLERS);

    // Event count must be unchanged (all events still exist)
    expect(rebuilt.entities.size).toBe(2);
    expect(rebuilt.entities.get('e1')!.label).toBe('Alpha');
    expect(rebuilt.entities.get('e2')!.label).toBe('Beta');

    // Checksum must match clean genesis rebuild
    const expectedFromGenesis = rebuildProjection(HANDLERS, { forceGenesis: true });
    expect(computeProjectionChecksum(rebuilt)).toBe(computeProjectionChecksum(expectedFromGenesis));
    expect(computeProjectionChecksum(rebuilt)).toBe(cleanChecksum);
  });
});

// ── Test: valid JSON but wrong state (checksum mismatch) ───────────

describe('checkpoint recovery: checksum mismatch', () => {
  it('tampered snapshot (valid JSON, wrong state) → rebuild falls back to genesis', () => {
    let projection = rebuildProjection(HANDLERS);

    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e1', payload: { id: 'e1', label: 'Alpha' } }),
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e2', payload: { id: 'e2', label: 'Beta' } }),
    ], projection);

    projection = rebuildProjection(HANDLERS);
    expect(projection.entities.size).toBe(2);

    // Tamper: replace snapshot with a valid but different ProjectionState
    // (an empty state — this represents data loss / corruption)
    const db = getDb()!;
    const emptyState = createEmptyProjectionState();
    // Force lastAppliedSeq to match checkpoint cursor so only checksum fails
    const checkpoint = getLatestCompatibleCheckpoint(CURRENT_PROJECTION_VERSION)!;
    emptyState.lastAppliedSeq = checkpoint.eventCursor;
    const tamperedJson = serializeProjectionState(emptyState);
    db.prepare("UPDATE projection_checkpoints SET snapshot_json = ? WHERE compatible = 1").run(tamperedJson);

    // Rebuild — checksum mismatch should trigger genesis fallback
    const rebuilt = rebuildProjection(HANDLERS);
    expect(rebuilt.entities.size).toBe(2);
    expect(rebuilt.entities.get('e1')!.label).toBe('Alpha');
    expect(rebuilt.entities.get('e2')!.label).toBe('Beta');
  });
});

// ── Test: normal checkpoint still works (fast path) ────────────────

describe('checkpoint recovery: uncorrupted fast path', () => {
  it('normal (uncorrupted) checkpoint works as incremental fast-path', () => {
    let projection = rebuildProjection(HANDLERS);

    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e1', payload: { id: 'e1', label: 'Alpha' } }),
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e2', payload: { id: 'e2', label: 'Beta' } }),
    ], projection);

    // First rebuild — creates checkpoint
    projection = rebuildProjection(HANDLERS);
    const cp = getLatestCompatibleCheckpoint(CURRENT_PROJECTION_VERSION);
    expect(cp).not.toBeNull();
    expect(cp!.snapshotJson).toBeTruthy();

    // Append more events
    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-2', entityId: 'e3', payload: { id: 'e3', label: 'Gamma' } }),
    ], projection);

    // Incremental rebuild — should use checkpoint as fast-path
    projection = rebuildProjection(HANDLERS);
    expect(projection.entities.size).toBe(3);
    expect(projection.entities.get('e1')!.label).toBe('Alpha');
    expect(projection.entities.get('e3')!.label).toBe('Gamma');
  });
});

// ── Test: corruption fallback + writeCheckpoint:true → repair write ─

describe('checkpoint recovery: repair write after fallback', () => {
  it('after corruption fallback with writeCheckpoint:true, new valid checkpoint is written', () => {
    let projection = rebuildProjection(HANDLERS);

    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e1', payload: { id: 'e1', label: 'Alpha' } }),
    ], projection);

    projection = rebuildProjection(HANDLERS);

    // Corrupt the checkpoint
    const db = getDb()!;
    db.prepare("UPDATE projection_checkpoints SET snapshot_json = 'CORRUPT' WHERE compatible = 1").run();

    // Invalidate so rebuild has no compatible checkpoint to load from
    db.prepare('UPDATE projection_checkpoints SET compatible = 0').run();

    // Rebuild with writeCheckpoint:true — falls back to genesis, writes new checkpoint
    projection = rebuildProjection(HANDLERS, { writeCheckpoint: true });
    expect(projection.entities.size).toBe(1);

    // A new valid checkpoint should exist
    const newCp = getLatestCompatibleCheckpoint(CURRENT_PROJECTION_VERSION);
    expect(newCp).not.toBeNull();
    expect(newCp!.snapshotJson).toBeTruthy();
    expect(newCp!.snapshotJson).not.toBe('CORRUPT');

    // Verify the new checkpoint is valid
    const snapshot = deserializeProjectionState(newCp!.snapshotJson!);
    expect(computeProjectionChecksum(snapshot)).toBe(newCp!.checksum);
  });

  it('after corruption fallback with writeCheckpoint:false, no repair write occurs', () => {
    let projection = rebuildProjection(HANDLERS);

    appendEvents([
      makeEvent({ eventType: 'NODE_ADDED', runId: 'run-1', entityId: 'e1', payload: { id: 'e1', label: 'Alpha' } }),
    ], projection);

    projection = rebuildProjection(HANDLERS);

    // Corrupt the checkpoint
    const db = getDb()!;
    db.prepare("UPDATE projection_checkpoints SET snapshot_json = 'CORRUPT' WHERE compatible = 1").run();

    // Count checkpoints before rebuild
    const beforeCount = (db.prepare("SELECT COUNT(*) AS n FROM projection_checkpoints").get() as { n: number }).n;

    // Rebuild with writeCheckpoint:false
    projection = rebuildProjection(HANDLERS, { writeCheckpoint: false });
    expect(projection.entities.size).toBe(1);

    // No new checkpoint should be written
    const afterCount = (db.prepare("SELECT COUNT(*) AS n FROM projection_checkpoints").get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Scenario 2: Interrupted read-model rebuild remains atomic
// ═══════════════════════════════════════════════════════════════════════

describe('read-model rebuild: SQLite trigger abort → status stays dirty', () => {
  it('trigger RAISE(ABORT) during rebuild → dirty status preserved, no partial rows, retry after drop succeeds', () => {
    const HANDLERS_FULL: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };

    const db = getDb()!;

    // 1. Seed claim/source/evidence projection state via real events
    let projection = rebuildProjection(HANDLERS_FULL);

    // FAMILY_CREATED → FAMILY_RESOLVED → CLAIM_OBSERVED → SOURCE_OBSERVED → EVIDENCE_LINKED
    appendEventsStore([
      { eventType: 'FAMILY_CREATED', eventVersion: 1, runId: 'rm-chaos', batchId: null, actor: 'system', entityId: 'fam-rm', entityType: 'family', timestamp: new Date().toISOString(), payload: { family_id: 'fam-rm', label: 'RM Chaos Family' } },
      { eventType: 'FAMILY_RESOLVED', eventVersion: 1, runId: 'rm-chaos', batchId: null, actor: 'system', entityId: 'fam-rm', entityType: 'family', timestamp: new Date().toISOString(), payload: { familyId: 'fam-rm', query: 'rm test', isNew: true } },
      { eventType: 'SOURCE_OBSERVED', eventVersion: 1, runId: 'rm-chaos', batchId: null, actor: 'system', entityId: 'src-rm', entityType: 'source', timestamp: new Date().toISOString(), payload: { sourceId: 'src-rm', observedSourceId: 'src-rm', canonicalUrl: 'https://rm-chaos.test', url: 'https://rm-chaos.test', title: 'RM Chaos Source', domain: 'rm-chaos.test', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'rm-chaos', observedAt: new Date().toISOString() } },
      { eventType: 'SOURCE_READ', eventVersion: 1, runId: 'rm-chaos', batchId: null, actor: 'system', entityId: 'src-rm', entityType: 'source', timestamp: new Date().toISOString(), payload: { sourceId: 'src-rm' } },
    ], { projection, handlers: HANDLERS_FULL });

    // CLAIM_OBSERVED requires a carefully constructed payload matching the codec
    appendEventsStore([
      { eventType: 'CLAIM_OBSERVED', eventVersion: 1, runId: 'rm-chaos', batchId: null, actor: 'system', entityId: 'claim-rm', entityType: 'claim', timestamp: new Date().toISOString(), payload: {
        observation: {
          id: 'obs-rm-1', familyId: 'fam-rm', runId: 'rm-chaos', observedAt: new Date().toISOString(),
          subjectText: 'test claim subject', predicate: 'test predicate', objectText: 'test object',
          polarity: 'asserted', hedge: 'certain', evidenceType: 'study', confidence: 0.9,
          sourceIds: [], extractionVersion: 'v1',
          canonicalKey: { subject: 'test claim subject', predicate: 'test predicate' },
        },
        reconciliation: {
          observationId: 'obs-rm-1', classification: 'new_claim', canonicalClaimId: 'claim-rm',
          score: 0.9, method: 'canonical_key_exact', rationale: 'test',
          reconcilerVersion: 1, candidates: [],
        },
      } },
    ], { projection, handlers: HANDLERS_FULL });

    // EVIDENCE_LINKED — claim needs at least one evidence for verifyProjectionIntegrity
    appendEventsStore([
      { eventType: 'EVIDENCE_LINKED', eventVersion: 2, runId: 'rm-chaos', batchId: null, actor: 'system', entityId: 'evd-rm-1', entityType: 'evidence', timestamp: new Date().toISOString(), payload: {
        id: 'evd-rm-1', claimId: 'claim-rm', sourceId: 'src-rm', observationId: 'obs-rm-1',
        stance: 'supports', excerpt: 'test excerpt', runId: 'rm-chaos',
      } },
    ], { projection, handlers: HANDLERS_FULL });

    const claimRm = projection.claims.get('claim-rm');
    expect(claimRm).toBeDefined();
    expect(projection.sources.has('src-rm')).toBe(true);

    // 2. Run a NORMAL read-model rebuild to establish baseline ready status
    rebuildKnowledgeReadModel(HANDLERS_FULL);
    const baselineStatus = getKnowledgeReadModelStatus();
    expect(baselineStatus.status).toBe('ready');

    // Count baseline rows
    const baselineClaimCount = (db.prepare('SELECT COUNT(*) AS n FROM rm_claims').get() as { n: number }).n;
    expect(baselineClaimCount).toBeGreaterThanOrEqual(1);

    // 3. Corrupt rm_* tables directly
    db.prepare('DELETE FROM rm_claims WHERE id = ?',).run('claim-rm');
    db.prepare('DELETE FROM rm_sources WHERE id = ?',).run('src-rm');
    db.prepare("UPDATE rm_state SET status='dirty', updated_at=? WHERE model_name='knowledge'").run(new Date().toISOString());

    // Verify corruption is in place
    const corruptedClaimCount = (db.prepare('SELECT COUNT(*) AS n FROM rm_claims').get() as { n: number }).n;
    expect(corruptedClaimCount).toBeLessThan(baselineClaimCount);
    expect(getKnowledgeReadModelStatus().status).toBe('dirty');

    // Save the corrupted-state projection checksum (event log unchanged)
    const eventLogChecksum = computeProjectionChecksum(rebuildProjection(HANDLERS_FULL, { forceGenesis: true }));

    // 4. Install a SQLite trigger that RAISE(ABORT) on INSERT into rm_claims
    db.prepare(`CREATE TRIGGER IF NOT EXISTS chaos_rm_insert AFTER INSERT ON rm_claims BEGIN SELECT RAISE(ABORT, 'chaos trigger fired'); END`).run();

    // 5. Call rebuildKnowledgeReadModel → should throw
    let threw = false;
    try {
      rebuildKnowledgeReadModel(HANDLERS_FULL);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // 6. Assert: status remains dirty (not silently ready)
    const afterAbortStatus = getKnowledgeReadModelStatus();
    expect(afterAbortStatus.status).toBe('dirty');

    // No half-old/half-new rows: DELETE was rolled back, so corrupted data remains;
    // no new rows from the rebuild INSERT landed.
    const afterAbortClaimCount = (db.prepare('SELECT COUNT(*) AS n FROM rm_claims').get() as { n: number }).n;
    expect(afterAbortClaimCount).toBe(corruptedClaimCount);

    // Event log and projection checksum are unchanged
    const afterAbortChecksum = computeProjectionChecksum(rebuildProjection(HANDLERS_FULL, { forceGenesis: true }));
    expect(afterAbortChecksum).toBe(eventLogChecksum);

    // 7. DROP the trigger and retry
    db.prepare('DROP TRIGGER IF EXISTS chaos_rm_insert').run();

    rebuildKnowledgeReadModel(HANDLERS_FULL);
    const finalStatus = getKnowledgeReadModelStatus();
    expect(finalStatus.status).toBe('ready');

    // verifyKnowledgeReadModel passes
    const rebuiltProjection = rebuildProjection(HANDLERS_FULL, { forceGenesis: true });
    const rmCheck = verifyKnowledgeReadModel(rebuiltProjection);
    expect(rmCheck.matches).toBe(true);
    expect(rmCheck.mismatches).toEqual([]);

    // verifyProjectionIntegrity passes
    const piCheck = verifyProjectionIntegrity(rebuiltProjection);
    expect(piCheck.matches).toBe(true);
    expect(piCheck.mismatches).toEqual([]);

    // FTS query returns the restored claim
    const ftsHits = db.prepare(
      "SELECT c.id FROM rm_claims c, rm_claims_fts f WHERE f.rowid = c.rowid AND rm_claims_fts MATCH 'predicate'",
    ).all() as Array<{ id: string }>;
    expect(ftsHits.length).toBeGreaterThanOrEqual(1);
  });
});
