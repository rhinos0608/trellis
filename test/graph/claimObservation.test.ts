import { describe, expect, it } from 'vitest';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { createEmptyProjectionState, deserializeProjectionState, serializeProjectionState, canonicalSerializeProjectionState } from '../../src/store/projectionState.js';
import type { EventEnvelope } from '../../src/store/eventTypes.js';
import type { ClaimObservation, ClaimReconciliation } from '../../src/graph/types.js';
import { decodeEventPayload } from '../../src/store/eventValidation.js';

const assertion = { subjectText: 'Trellis', predicate: 'improves', objectText: 'research', polarity: 'asserted' as const, hedge: 'certain' as const, evidenceType: 'study' as const, canonicalKey: { subject: 'trellis', predicate: 'improves' } };
function observation(id: string, confidence = 0.8): ClaimObservation { return { ...assertion, id, familyId: 'f', runId: id, observedAt: `2024-01-0${id.charCodeAt(0) - 96}T00:00:00.000Z`, confidence, sourceIds: [], extractionVersion: 'v1' }; }
function event(payload: unknown, id = 'e'): EventEnvelope { return { seq: 1, id, timestamp: new Date().toISOString(), eventType: 'CLAIM_OBSERVED', eventVersion: 1, runId: 'r', batchId: null, actor: 'system', entityId: null, entityType: null, payload, payloadHash: '' }; }
function reconcile(o: ClaimObservation, classification: ClaimReconciliation['classification'], canonicalClaimId: string, matchedClaimId?: string): ClaimReconciliation { return { observationId: o.id, classification, canonicalClaimId, ...(matchedClaimId === undefined ? {} : { matchedClaimId }), score: 1, method: 'canonical_key_exact', rationale: classification, reconcilerVersion: 1, candidates: [] }; }

describe('longitudinal claim observations', () => {
  it('creates canonical claim and attaches same-claim observation', () => {
    const state = createEmptyProjectionState(); const a = observation('a', 0.6); const b = observation('b', 0.8);
    graphEventHandlers.CLAIM_OBSERVED(event({ observation: a, reconciliation: reconcile(a, 'new_claim', 'c') }), state);
    graphEventHandlers.CLAIM_OBSERVED(event({ observation: b, reconciliation: reconcile(b, 'same_claim', 'c', 'c') }, 'e2'), state);
    expect(state.claims.get('c')?.observationCount).toBe(2); expect(state.claims.get('c')?.confidence).toBeGreaterThan(0);
  });
  it('creates contradiction relation and superseding revision', () => {
    const state = createEmptyProjectionState(); const a = observation('a'); const b = { ...observation('b'), objectText: 'different' };
    graphEventHandlers.CLAIM_OBSERVED(event({ observation: a, reconciliation: reconcile(a, 'new_claim', 'c1') }), state);
    graphEventHandlers.CLAIM_OBSERVED(event({ observation: b, reconciliation: reconcile(b, 'contradiction', 'c2', 'c1') }, 'e2'), state);
    expect(state.contradictions.size).toBe(1); expect(state.claimRelations.size).toBe(1);
    const s = createEmptyProjectionState(); graphEventHandlers.CLAIM_OBSERVED(event({ observation: a, reconciliation: reconcile(a, 'new_claim', 'c1') }), s);
    graphEventHandlers.CLAIM_OBSERVED(event({ observation: b, reconciliation: { ...reconcile(b, 'supersedes', 'c2', 'c1'), supersedes: { previousObservationId: 'a', previousAssertion: assertion } } }, 'e3'), s);
    // Supersession creates a NEW claim identity (c2) — old claim (c1) remains
    // in state but is expired via a separate CLAIM_EXPIRED event.
    expect(s.claims.has('c1')).toBe(true);
    expect(s.claims.has('c2')).toBe(true);
    expect(s.claims.get('c2')?.observationIds).toEqual([b.id]);
  });
  it('rejects malformed reconciliation and observation payloads', () => {
    const o = observation('bad');
    const base = reconcile(o, 'new_claim', 'c');
    expect(() => decodeEventPayload('CLAIM_OBSERVED', 1, { observation: o, reconciliation: { ...base, matchedClaimId: 'c' } })).toThrow();
    expect(() => decodeEventPayload('CLAIM_OBSERVED', 1, { observation: o, reconciliation: { ...reconcile(o, 'contradiction', 'c', 'c') } })).toThrow();
    expect(() => decodeEventPayload('CLAIM_OBSERVED', 1, { observation: o, reconciliation: reconcile(o, 'supersedes', 'c', 'c') })).toThrow();
    expect(() => decodeEventPayload('CLAIM_OBSERVED', 1, { observation: { ...o, confidence: 'bad' }, reconciliation: base })).toThrow();
  });

  it('round-trips observation collections and canonical serialization changes', () => {
    const state = createEmptyProjectionState(); const o = observation('o'); const r = reconcile(o, 'new_claim', 'c');
    graphEventHandlers.CLAIM_OBSERVED(event({ observation: o, reconciliation: r }), state);
    const before = canonicalSerializeProjectionState(state); const restored = deserializeProjectionState(serializeProjectionState(state));
    expect(restored.claimObservations.has('o')).toBe(true); expect(restored.claimReconciliations.has('o')).toBe(true); expect(restored.observationToClaimId.get('o')).toBe('c'); expect(restored.observationsByClaimId.get('c')?.has('o')).toBe(true);
    o.confidence = 0.1; expect(canonicalSerializeProjectionState(state)).not.toBe(before);
  });
});
