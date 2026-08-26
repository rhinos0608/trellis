/**
 * Chaos tests: rollback atomicity and curation preflight ordering.
 *
 * Fix 2(a): marker + compensations must commit atomically (all-or-nothing).
 * Fix 2(b): curation event types must be rejected BEFORE any event append.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EventEnvelope } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';
import type { EventHandlerRegistry, ProjectionState } from '../../src/store/projectionState.js';
import {
  appendEvents as appendEventsStore,
  closeDb,
  createEmptyProjectionState,
  getDb,
  initDb,
  queryEvents,
  rebuildProjection,
  rollbackRun,
  CurationRollbackBlockedError,
} from '../../src/store/index.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { rebuildKnowledgeReadModel, getKnowledgeReadModelStatus, verifyKnowledgeReadModel } from '../../src/store/readModel/index.js';

// ── Helpers ────────────────────────────────────────────────────────

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
let tempDir: string;

function event(
  eventType: NewEventInput['eventType'],
  payload: unknown,
  runId = 'test-run',
  eventVersion = 1,
): NewEventInput {
  return {
    eventType,
    eventVersion,
    runId,
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function assertion(subjectText: string, objectText = 'evidence') {
  return {
    subjectText, predicate: 'supports', objectText, polarity: 'asserted' as const, hedge: 'certain' as const,
    evidenceType: 'study' as const, canonicalKey: { subject: subjectText.toLowerCase(), predicate: 'supports' },
  };
}

function observation(id: string, subjectText: string, familyId: string, runId: string, objectText = 'evidence') {
  return {
    ...assertion(subjectText, objectText), id, familyId, runId, observedAt: new Date().toISOString(), confidence: 0.9,
    sourceIds: [], extractionVersion: 'v1',
  };
}

function observed(
  id: string, subjectText: string, familyId: string, runId: string, claimId: string,
  classification: 'new_claim' | 'same_claim' | 'supersedes' | 'contradiction' = 'new_claim',
  matchedClaimId?: string, previousObservationId?: string,
): NewEventInput {
  const reconciliation = {
    observationId: id, classification, canonicalClaimId: claimId,
    ...(classification !== 'new_claim' ? { matchedClaimId: matchedClaimId ?? claimId } : {}),
    score: 0.9, method: 'canonical_key_exact' as const, rationale: 'test', reconcilerVersion: 1 as const, candidates: [],
    ...(classification === 'supersedes' ? { supersedes: { previousObservationId: previousObservationId ?? 'missing', previousAssertion: assertion('old text') } } : {}),
  };
  return event('CLAIM_OBSERVED', { observation: observation(id, subjectText, familyId, runId), reconciliation }, runId);
}

const db = () => getDb()!;
const rebuildEmpty = () => rebuildKnowledgeReadModel(handlers);
function appendEvents(events: readonly NewEventInput[], projection: ProjectionState): EventEnvelope[] {
  return appendEventsStore(events, { projection, handlers });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-rollback-chaos-'));
  expect(initDb(path.join(tempDir, 'test.db'))).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── Fix 2(a): Atomicity — handler failure mid-rollback ─────────────

describe('rollback atomicity: handler failure blocks all appends', () => {
  it('compensating-handler failure → NO RUN_ROLLED_BACK event, NO partial compensations, state unchanged', () => {
    const state = createEmptyProjectionState();
    rebuildEmpty();

    // Append events for a run that has cross_run_mutation effects
    appendEvents([
      event('FAMILY_CREATED', { family_id: 'fam-1', label: 'Family 1' }, 'rb-run'),
      observed('obs-1', 'rollback target claim', 'fam-1', 'rb-run', 'claim-1'),
    ], state);

    // Verify events exist
    expect(queryEvents({ eventType: 'RUN_ROLLED_BACK' })).toHaveLength(0);
    expect(state.claims.has('claim-1')).toBe(true);

    // Monkeypatch: make the CLAIM_OBSERVED handler throw to simulate mid-rollback failure.
    // We do this by temporarily replacing the handler for a type that appears
    // in the compensation events. Since rollback compensation for CLAIM_OBSERVED
    // is pure_run_local (skipped during replay), we need a cross_run_mutation event.
    // Use FAMILY_RENAMED (cross_run_mutation) instead — append one.

    appendEvents([
        event('FAMILY_RENAMED', { targetId: 'fam-1', oldLabel: 'Family 1', newLabel: 'Renamed' }, 'rb-run'),
    ], state);

    // Capture event count AFTER all setup appends, BEFORE the rollback attempt
    const eventCountBefore = queryEvents().length;

    // Save the original handler
    const origHandler = handlers['FAMILY_RENAMED'];

    // Override FAMILY_RENAMED handler to throw
    handlers['FAMILY_RENAMED'] = () => {
      throw new Error('simulated handler failure');
    };

    let rollbackError: unknown;
    try {
      // Attempt rollback — should abort atomically (appendEvents throws)
      rollbackRun('rb-run', state, { projection: state, handlers });
    } catch (err) {
      rollbackError = err;
    } finally {
      // Restore original handler
      handlers['FAMILY_RENAMED'] = origHandler;
    }

    // The handler failure must have thrown
    expect(rollbackError).toBeInstanceOf(Error);

    // No events should have been appended (atomic abort via DB transaction rollback)
    expect(queryEvents({ eventType: 'RUN_ROLLED_BACK' })).toHaveLength(0);

    // Event count unchanged — no partial compensation events
    expect(queryEvents().length).toBe(eventCountBefore);

    // Projection state unchanged
    expect(state.claims.has('claim-1')).toBe(true);

    // Read model unchanged
    expect(verifyKnowledgeReadModel(state)).toEqual({ matches: true, mismatches: [] });

    // Retry with normal (non-throwing) handler should succeed exactly once
    const result2 = rollbackRun('rb-run', state, { projection: state, handlers });
    expect(result2.blocked).toHaveLength(0);
    expect(result2.executed).toBeGreaterThanOrEqual(1);

    // Exactly one RUN_ROLLED_BACK event
    expect(queryEvents({ eventType: 'RUN_ROLLED_BACK' })).toHaveLength(1);

    // Rolled-back data gone
    expect(state.rolledBackRuns.has('rb-run')).toBe(true);
    expect(verifyKnowledgeReadModel(state)).toEqual({ matches: true, mismatches: [] });
  });
});

// ── Fix 2(b): Curation preflight — all 5 event types ──────────────

describe('curation preflight: rollback rejected BEFORE any event append', () => {
  const CURATION_TYPES = [
    'CLAIM_MERGED',
    'CLAIM_SPLIT',
    'CLAIM_RETRACTION_SET',
    'CLAIM_RELATION_CURATED',
    'EVIDENCE_STANCE_OVERRIDDEN',
  ] as const;

  for (const curationType of CURATION_TYPES) {
    it(`${curationType}: rollback rejected before any event append`, () => {
      const state = createEmptyProjectionState();
      rebuildEmpty();

      // Directly insert a raw event row — bypasses schema validation
      // since rollbackRun only checks event types via queryEvents.
      const curationRunId = `curation-${curationType.toLowerCase()}`;
      const db_ = getDb()!;
      const dummyHash = 'a'.repeat(64); // SHA-256 hex length
      db_.prepare(
        `INSERT INTO events (id, timestamp, event_type, event_version, run_id, batch_id,
         actor, actor_id, entity_id, entity_type, payload, payload_hash)
         VALUES (?, ?, ?, 1, ?, NULL, 'system', NULL, NULL, NULL, ?, ?)`
      ).run(
        `raw-${curationType.toLowerCase()}-${Date.now()}`,
        new Date().toISOString(),
        curationType,
        curationRunId,
        '{}',
        dummyHash,
      );

      // Count events before rollback attempt
      const eventCountBefore = queryEvents().length;

      // Attempt rollback — should throw CurationRollbackBlockedError
      expect(() => {
        rollbackRun(curationRunId, state, { projection: state, handlers });
      }).toThrow(CurationRollbackBlockedError);

      // Zero new events appended (no marker, no compensations)
      expect(queryEvents().length).toBe(eventCountBefore);
      expect(queryEvents({ eventType: 'RUN_ROLLED_BACK' })).toHaveLength(0);

      // Projection state unchanged
      expect(verifyKnowledgeReadModel(state)).toEqual({ matches: true, mismatches: [] });
    });
  }
});
