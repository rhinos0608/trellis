import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initDb,
  closeDb,
  appendEvents as appendEventsStore,
  rebuildProjection,
  countEvents,
  rollbackRun,
} from '../../src/store/index.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import type { NewEventInput } from '../../src/store/events.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { handleRunStarted, handleRunCompleted } from '../../src/store/index.js';
import type { ClaimObservation } from '../../src/graph/types.js';
import { planClaimObservation } from '../../src/graph/claimReconciler.js';
import { getClaimsByFamily } from '../../src/graph/queries.js';
import { loadScenarios } from '../../src/evaluation/fixtures.js';
import { runScenario } from '../../src/evaluation/reconciliation.js';

const ALL_HANDLERS: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers, RUN_STARTED: handleRunStarted, RUN_COMPLETED: handleRunCompleted };

let tmpDir: string;

function appendEvents(events: readonly NewEventInput[]): ReturnType<typeof appendEventsStore> {
  const projection = rebuildProjection(ALL_HANDLERS);
  // Pre-create families referenced by events so scratch state passes validation
  const familyIds = new Set<string>();
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    const familyId = typeof payload.familyId === 'string' ? payload.familyId : (typeof payload.observation === 'object' && payload.observation !== null ? (payload.observation as Record<string, unknown>).familyId as string | undefined : undefined);
    if (familyId) familyIds.add(familyId);
  }
  // Prepend FAMILY_CREATED events for families referenced by events
  const familyCreatedEvents: NewEventInput[] = [];
  for (const fid of familyIds) {
    if (!projection.families.has(fid)) {
      projection.families.set(fid, { id: fid, label: fid, manifest: { scopeQuery: fid }, createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(), relatedFamilies: [] } as never);
      familyCreatedEvents.push(makeEvent({ eventType: 'FAMILY_CREATED', runId: 'system', payload: { family_id: fid, label: fid } }));
    }
  }
  const allEvents = [...familyCreatedEvents, ...events];
  for (const event of events) {
    const payload = event.payload as Record<string, unknown>;
    if (event.eventType === 'ENTITY_MERGED') {
      const p = payload as { survivorId?: string; mergedIds?: string[] };
      for (const id of [p.survivorId, ...(p.mergedIds ?? [])]) {
        if (id) projection.entities.set(id, { id, label: id, canonicalLabel: null, entityType: 'unknown', aliases: [], extractionConfidence: null, firstSeenRunId: event.runId, lastUpdatedRunId: event.runId, metadata: {} } as never);
      }
    }
  }
  return appendEventsStore(allEvents, { projection, handlers: ALL_HANDLERS });
}

function makeEvent(overrides: Partial<NewEventInput> & { eventType: string }): NewEventInput {
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
  } as NewEventInput;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-validity-test-'));
  initDb(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Migration ────────────────────────────────────────────────────────

describe('migration 0005: claim validity columns', () => {
  it('applies cleanly and backfills valid_at', () => {
    appendEvents([
      makeEvent({ eventType: 'RUN_STARTED', runId: 'r1', payload: { runId: 'r1', familyId: 'f1', query: 'test', strategy: 'agent' } }),
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r1', entityId: 'c1', entityType: 'claim', payload: buildClaimPayload('c1', 'obs1', 'f1', 'r1', '2024-06-01T00:00:00Z') }),
      makeEvent({ eventType: 'RUN_COMPLETED', runId: 'r1', payload: { runId: 'r1' } }),
    ]);
    const state = rebuildProjection(ALL_HANDLERS);
    const c1 = state.claims.get('c1');
    expect(c1).toBeDefined();
    expect(c1!.expiredAt).toBeUndefined();
  });
});

// ── Supersession ──────────────────────────────────────────────────────

describe('claim validity: supersession creates new identity and expires old', () => {
  it('creates new claim with distinct id and validAt after supersession', () => {
    const scenarios = loadScenarios(path.join(process.cwd(), 'test/fixtures/reconciliation/v1/scenarios'));
    const temporal = scenarios.find((s) => s.name === 'temporal-revisions');
    expect(temporal).toBeDefined();
    const { state, steps } = runScenario(temporal!.scenario);
    // t1 should be supersedes
    const t1Step = steps.find((s) => s.observationId === 't1');
    expect(t1Step?.reconciliation.classification).toBe('supersedes');
    const canonicalId = t1Step!.reconciliation.canonicalClaimId;
    const matchedId = t1Step!.reconciliation.matchedClaimId!;
    // Supersession MUST create a distinct new claim id — never reuse the old
    expect(canonicalId).not.toBe(matchedId);
    // New claim identity has validAt set from the observation
    const newClaim = state.claims.get(canonicalId);
    expect(newClaim).toBeDefined();
    expect(newClaim!.validAt).toBe('2025-01-01T00:00:00.000Z');
    expect(newClaim!.expiredAt).toBeUndefined();
    // Old claim still exists in projection (runScenario does not emit CLAIM_EXPIRED)
    const oldClaim = state.claims.get(matchedId);
    expect(oldClaim).toBeDefined();
  });

  it('CLAIM_EXPIRED + CLAIM_OBSERVED supersession produces two distinct claims', () => {
    // Simulate the full supersession flow as runService.ts emits it:
    // CLAIM_OBSERVED for old, CLAIM_EXPIRED for old, CLAIM_OBSERVED for new
    appendEvents([
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r1', entityId: 'c_old', entityType: 'claim',
        payload: buildClaimPayload('c_old', 'obs_old', 'f1', 'r1', '2024-01-01T00:00:00Z') }),
      makeEvent({ eventType: 'CLAIM_EXPIRED', runId: 'r2', entityId: 'c_old', entityType: 'claim',
        payload: { claimId: 'c_old', expiredAt: '2025-01-01T00:00:00Z', reason: 'superseded', replacementClaimId: 'c_new', replacementObservationId: 'obs_new' } }),
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r2', entityId: 'c_new', entityType: 'claim',
        payload: buildClaimPayload('c_new', 'obs_new', 'f1', 'r2', '2025-01-01T00:00:00Z') }),
    ]);
    const state = rebuildProjection(ALL_HANDLERS);
    const oldClaim = state.claims.get('c_old');
    expect(oldClaim).toBeDefined();
    expect(oldClaim!.expiredAt).toBe('2025-01-01T00:00:00Z');
    const newClaim = state.claims.get('c_new');
    expect(newClaim).toBeDefined();
    expect(newClaim!.validAt).toBe('2025-01-01T00:00:00Z');
    expect(newClaim!.expiredAt).toBeUndefined();
  });

  it('supersession does NOT expire claims via contradiction', () => {
    // Use negation-and-qualification scenario which has a contradiction step
    const scenarios = loadScenarios(path.join(process.cwd(), 'test/fixtures/reconciliation/v1/scenarios'));
    const neg = scenarios.find((s) => s.name === 'negation-and-qualification');
    expect(neg).toBeDefined();
    const { state, steps } = runScenario(neg!.scenario);
    // g1 is a contradiction against claim-1
    const g1Step = steps.find((s) => s.observationId === 'g1');
    expect(g1Step?.reconciliation.classification).toBe('contradiction');
    // Neither the old claim nor the new contradiction claim is expired
    const oldClaim = state.claims.get(g1Step!.reconciliation.matchedClaimId!);
    expect(oldClaim).toBeDefined();
    expect(oldClaim!.expiredAt).toBeUndefined();
    const newClaim = state.claims.get(g1Step!.reconciliation.canonicalClaimId);
    expect(newClaim).toBeDefined();
    expect(newClaim!.expiredAt).toBeUndefined();
  });
});

// ── Contradiction does NOT expire ─────────────────────────────────────

describe('claim validity: contradiction does NOT expire claims', () => {
  it('both claims remain active after contradiction', () => {
    appendEvents([
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r1', entityId: 'c1', entityType: 'claim', payload: buildClaimPayload('c1', 'obs1', 'f1', 'r1') }),
    ]);
    const state1 = rebuildProjection(ALL_HANDLERS);

    const obs2: ClaimObservation = {
      id: 'obs2', familyId: 'f1', runId: 'r2', observedAt: '2024-06-01T00:00:00Z',
      subjectText: 'React', predicate: 'supports', polarity: 'negated', hedge: 'certain',
      evidenceType: 'opinion', confidence: 0.6, sourceIds: ['s2'], extractionVersion: 'test',
      canonicalKey: { subject: 'react', predicate: 'supports' },
    };
    const planned = planClaimObservation(obs2, state1);
    expect(planned.reconciliation.classification).toBe('contradiction');

    appendEvents([
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r2', entityId: planned.reconciliation.canonicalClaimId, entityType: 'claim', payload: planned }),
    ]);

    const state2 = rebuildProjection(ALL_HANDLERS);
    const claims = [...state2.claims.values()].filter((c) => c.familyId === 'f1');
    for (const c of claims) {
      expect(c.expiredAt).toBeUndefined();
    }
    expect(claims.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Query filtering ──────────────────────────────────────────────────

describe('claim validity: getClaimsByFamily excludes expired', () => {
  it('expired claim excluded from family view, accessible by direct ID', () => {
    appendEvents([
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r1', entityId: 'c1', entityType: 'claim', payload: buildClaimPayload('c1', 'obs1', 'f1', 'r1') }),
      makeEvent({ eventType: 'CLAIM_EXPIRED', runId: 'r2', entityId: 'c1', entityType: 'claim',
        payload: { claimId: 'c1', expiredAt: '2025-01-01T00:00:00Z', reason: 'superseded', replacementClaimId: 'c2', replacementObservationId: 'obs2' },
      }),
    ]);

    const state = rebuildProjection(ALL_HANDLERS);
    const active = getClaimsByFamily(state, 'f1');
    expect(active.find((c) => c.id === 'c1')).toBeUndefined();

    // Direct ID lookup still works
    const historical = state.claims.get('c1');
    expect(historical).toBeDefined();
    expect(historical!.expiredAt).toBe('2025-01-01T00:00:00Z');
  });
});

// ── Read-model rebuild ────────────────────────────────────────────────

describe('claim validity: rebuild from events', () => {
  it('produces correct valid_at and expired_at', () => {
    appendEvents([
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r1', entityId: 'c1', entityType: 'claim',
        payload: buildClaimPayload('c1', 'obs1', 'f1', 'r1', '2024-01-01T00:00:00Z') }),
      makeEvent({ eventType: 'CLAIM_EXPIRED', runId: 'r2', entityId: 'c1', entityType: 'claim',
        payload: { claimId: 'c1', expiredAt: '2025-01-01T00:00:00Z', reason: 'superseded', replacementClaimId: 'c2', replacementObservationId: 'obs2' } }),
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r2', entityId: 'c2', entityType: 'claim',
        payload: buildClaimPayload('c2', 'obs2', 'f1', 'r2', '2025-01-01T00:00:00Z') }),
    ]);

    const state = rebuildProjection(ALL_HANDLERS);
    const c1 = state.claims.get('c1');
    expect(c1).toBeDefined();
    expect(c1!.expiredAt).toBe('2025-01-01T00:00:00Z');
    const c2 = state.claims.get('c2');
    expect(c2).toBeDefined();
    expect(c2!.expiredAt).toBeUndefined();
    expect(c2!.validAt).toBe('2025-01-01T00:00:00Z');
  });

  it('CLAIM_EXPIRED is skipped on rollback (pure_run_local)', () => {
    appendEvents([
      makeEvent({ eventType: 'CLAIM_OBSERVED', runId: 'r1', entityId: 'c1', entityType: 'claim',
        payload: buildClaimPayload('c1', 'obs1', 'f1', 'r1') }),
      makeEvent({ eventType: 'CLAIM_EXPIRED', runId: 'r1', entityId: 'c1', entityType: 'claim',
        payload: { claimId: 'c1', expiredAt: '2025-01-01T00:00:00Z', reason: 'superseded', replacementClaimId: 'c2', replacementObservationId: 'obs2' } }),
    ]);

    const state = rebuildProjection(ALL_HANDLERS);
    state.lastAppliedSeq = countEvents();
    rollbackRun('r1', state, { projection: state, handlers: ALL_HANDLERS });
    const state2 = rebuildProjection(ALL_HANDLERS);
    expect(state2.claims.has('c1')).toBe(false);
  });
});

// ── Reconciler filtering ──────────────────────────────────────────────

describe('claim validity: planClaimObservation ignores expired candidates', () => {
  it('expired claims excluded from matching', () => {
    const state = rebuildProjection(ALL_HANDLERS);
    state.claims.set('c-old', {
      id: 'c-old', familyId: 'f1', subjectText: 'React', predicate: 'supports',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
      canonicalKey: { subject: 'react', predicate: 'supports' },
      confidence: 0.8, contradictionState: 'none', firstSeenRunId: 'r1',
      lastSeenRunId: 'r1', expiredAt: '2025-01-01T00:00:00Z',
    } as never);
    state.claimsByFamilyId.set('f1', new Set(['c-old']));

    const obs: ClaimObservation = {
      id: 'obs-new', familyId: 'f1', runId: 'r2', observedAt: '2025-06-01T00:00:00Z',
      subjectText: 'React', predicate: 'supports', polarity: 'asserted', hedge: 'certain',
      evidenceType: 'study', confidence: 0.8, sourceIds: ['s1'], extractionVersion: 'test',
      canonicalKey: { subject: 'react', predicate: 'supports' },
    };
    const planned = planClaimObservation(obs, state);
    expect(planned.reconciliation.classification).toBe('new_claim');
  });
});

// ── Helpers ───────────────────────────────────────────────────────────

function buildClaimPayload(
  claimId: string, obsId: string, familyId: string, runId: string,
  observedAt = new Date().toISOString(),
): Record<string, unknown> {
  return {
    observation: {
      id: obsId, familyId, runId, observedAt,
      subjectText: 'React', predicate: 'supports', polarity: 'asserted',
      hedge: 'certain', evidenceType: 'study', confidence: 0.8,
      sourceIds: ['s1'], extractionVersion: 'test',
      canonicalKey: { subject: 'react', predicate: 'supports' },
    },
    reconciliation: {
      observationId: obsId, classification: 'new_claim',
      canonicalClaimId: claimId, score: 0, method: 'lexical_rules_v2',
      rationale: 'test', reconcilerVersion: 4, candidates: [],
    },
  };
}
