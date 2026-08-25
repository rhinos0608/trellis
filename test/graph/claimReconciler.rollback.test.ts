import { describe, expect, it } from 'vitest';
import { decodeEventPayload } from '../../src/store/eventValidation.js';
import { StaleProjectionError } from '../../src/store/eventErrors.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { createEmptyProjectionState, canonicalSerializeProjectionState } from '../../src/store/projectionState.js';
import { planClaimObservation } from '../../src/graph/claimReconciler.js';
import type { ClaimObservation, ClaimReconciliation } from '../../src/graph/types.js';
import type { EventEnvelope } from '../../src/store/eventTypes.js';

const assertion = {
  subjectText: 'Trellis', predicate: 'improves', objectText: 'research', polarity: 'asserted' as const,
  hedge: 'certain' as const, evidenceType: 'study' as const, canonicalKey: { subject: 'trellis', predicate: 'improves' },
};
function observation(id: string, confidence = 0.8): ClaimObservation {
  return { ...assertion, id, familyId: 'family', runId: `run-${id}`, observedAt: id, confidence, sourceIds: [], extractionVersion: 'v1' };
}
function reconciliation(o: ClaimObservation, classification: ClaimReconciliation['classification'], canonicalClaimId: string, matchedClaimId?: string): ClaimReconciliation {
  return { observationId: o.id, classification, canonicalClaimId, ...(matchedClaimId === undefined ? {} : { matchedClaimId }), score: 1, method: 'canonical_key_exact', rationale: classification, reconcilerVersion: 1, candidates: [] };
}
function event(payload: unknown, id = 'event'): EventEnvelope {
  return { seq: 1, id, timestamp: new Date().toISOString(), eventType: 'CLAIM_OBSERVED', eventVersion: 1, runId: 'run', batchId: null, actor: 'system', entityId: null, entityType: null, payload, payloadHash: '' };
}
function apply(state: ReturnType<typeof createEmptyProjectionState>, o: ClaimObservation, r: ClaimReconciliation, id = o.id): void {
  graphEventHandlers.CLAIM_OBSERVED(event({ observation: o, reconciliation: r }, id), state);
}

describe('longitudinal claim rollback boundaries', () => {
  it('bootstraps canonical claim when founder disappeared through rollback', () => {
    const state = createEmptyProjectionState();
    const founder = observation('founder');
    apply(state, founder, reconciliation(founder, 'new_claim', 'claim_x'));
    state.claims.delete('claim_x');
    state.claimsByFamilyId.get('family')?.delete('claim_x');
    state.rolledBackRuns.add(founder.runId);
    const survivor = observation('survivor');
    apply(state, survivor, reconciliation(survivor, 'same_claim', 'claim_x', 'claim_x'));
    expect(state.claims.get('claim_x')?.observationIds).toEqual(['survivor']);
  });

  it('skips orphan relation and self-edge materialization', () => {
    const state = createEmptyProjectionState();
    const first = observation('first');
    apply(state, first, reconciliation(first, 'new_claim', 'claim_a'));
    graphEventHandlers.EDGE_ADDED(event({ id: 'orphan', fromClaimId: 'claim_a', toClaimId: 'gone', relation: 'near_duplicate', strength: 'strong', score: 1, runId: 'run' }, 'edge'), state);
    expect(state.claimRelations.size).toBe(0);
    const same = observation('same');
    apply(state, same, reconciliation(same, 'same_claim', 'claim_a', 'claim_a'));
    expect([...state.claimRelations.values()].some((r) => r.fromClaimId === r.toClaimId)).toBe(false);
  });

  it('replans stale concurrent observation against persisted claim', () => {
    const first = observation('one');
    const second = observation('two');
    const stale = createEmptyProjectionState();
    const persisted = createEmptyProjectionState();
    apply(persisted, first, reconciliation(first, 'new_claim', 'claim_one'));
    persisted.lastAppliedSeq = 1;
    expect(() => {
      if (stale.lastAppliedSeq !== persisted.lastAppliedSeq) throw new StaleProjectionError(stale.lastAppliedSeq, persisted.lastAppliedSeq);
    }).toThrow(StaleProjectionError);
    const replanned = planClaimObservation(second, persisted);
    expect(replanned.reconciliation.classification).toBe('same_claim');
    apply(persisted, replanned.observation, replanned.reconciliation);
    expect(persisted.claims.get('claim_one')?.observationCount).toBe(2);
  });

  it('changes canonical checksum for observation, confidence, and revision', () => {
    const state = createEmptyProjectionState();
    const first = observation('first', 0.5);
    apply(state, first, reconciliation(first, 'new_claim', 'claim_a'));
    const initial = canonicalSerializeProjectionState(state);
    const second = observation('second', 0.9);
    apply(state, second, reconciliation(second, 'same_claim', 'claim_a', 'claim_a'));
    const same = canonicalSerializeProjectionState(state);
    expect(same).not.toBe(initial);
    const third = { ...observation('third'), objectText: 'replaces research', temporalScope: { eventType: 'updated' as const, eventDate: '2025', dateConfidence: 'exact' as const } };
    apply(state, third, reconciliation(third, 'supersedes', 'claim_b', 'claim_a'));
    expect(canonicalSerializeProjectionState(state)).not.toBe(same);
  });

  it('rejects mismatched same_claim IDs during decode', () => {
    expect(() => decodeEventPayload('CLAIM_OBSERVED', 1, {
      observation: {}, reconciliation: { classification: 'same_claim', canonicalClaimId: 'claim-a', matchedClaimId: 'claim-b' },
    })).toThrow();
  });
});
