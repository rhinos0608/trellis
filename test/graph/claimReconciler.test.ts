import { describe, expect, it } from 'vitest';
import { planClaimObservation } from '../../src/graph/claimReconciler.js';
import type { Claim, ClaimObservation } from '../../src/graph/types.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';

function observation(id: string, overrides: Partial<ClaimObservation> = {}): ClaimObservation {
  return {
    id, familyId: 'family-1', runId: 'run-2', observedAt: '2025-01-01', confidence: 0.9,
    sourceIds: [], extractionVersion: 'test', subjectText: 'Trellis', predicate: 'supports',
    objectText: 'claim reconciliation', polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
    canonicalKey: { subject: 'trellis', predicate: 'supports' }, ...overrides,
  };
}

function claim(id: string, overrides: Partial<Claim> = {}): Claim {
  return {
    ...observation(`old-${id}`), id, contradictionState: 'none',
    firstSeenRunId: 'run-1', lastSeenRunId: 'run-1', confidence: 0.8, ...overrides,
  };
}

function stateWith(...claims: Claim[]) {
  const state = createEmptyProjectionState();
  for (const item of claims) {
    state.claims.set(item.id, item);
    const ids = state.claimsByFamilyId.get(item.familyId) ?? new Set<string>();
    ids.add(item.id); state.claimsByFamilyId.set(item.familyId, ids);
  }
  return state;
}

function result(obs: ClaimObservation, existing: Claim) {
  return planClaimObservation(obs, stateWith(existing)).reconciliation;
}

describe('claim reconciler', () => {
  it('same_claim for exact canonical key and high text similarity', () => {
    const existing = claim('c1');
    expect(result(observation('o1'), existing).classification).toBe('same_claim');
    expect(result(observation('o2', { subjectText: 'Trellis system', objectText: 'claim reconciliation' }), existing).classification).toBe('same_claim');
  });

  it('elaboration when objectText is extended superset of existing', () => {
    // isElaboration checks same subject/predicate + longer objectText containing old objectText
    expect(result(observation('o1', { objectText: 'claim reconciliation process' }), claim('c1')).classification).toBe('elaboration');
  });

  it('qualification when polarity differs (conditional vs asserted) in same scope', () => {
    expect(result(observation('o2', { objectText: 'claim reconciliation', polarity: 'conditional' }), claim('c2')).classification).toBe('qualification');
  });

  it('near_duplicate for high text similarity with different canonicalKey', () => {
    // Different quantifierCanonical → sameKey fails, jaccard scoring applies
    const obs = observation('o3', {
      objectText: 'claim reconciliation',
      canonicalKey: { subject: 'trellis', predicate: 'supports', quantifierCanonical: '50%' },
    });
    const c3 = claim('c3', {
      objectText: 'claim reconciliation tools',
    });
    // assertionText: 'trellis supports claim reconciliation' vs 'trellis supports claim reconciliation tools'
    // jaccard ~0.8 → score ~0.785 → near_duplicate
    expect(result(obs, c3).classification).toBe('near_duplicate');
  });

  it('prioritizes polarity contradictions within same scope', () => {
    expect(result(observation('o1', { polarity: 'negated' }), claim('c1')).classification).toBe('contradiction');
  });

  it('prioritizes numeric contradictions within same scope', () => {
    const quantified = claim('c2', { quantifier: { value: 50, unit: '%', comparisonType: 'increase' } });
    expect(result(observation('o2', { quantifier: { value: 10, unit: '%', comparisonType: 'increase' } }), quantified).classification).toBe('contradiction');
  });

  it('contradiction requires same scope — different objectText avoids contradiction', () => {
    // Different objectText scope → not sameScope → polarity mismatch NOT a contradiction
    const unrelated = claim('c1', { objectText: 'unrelated metric' });
    const obs = observation('o1', { objectText: 'claim reconciliation', polarity: 'negated' });
    expect(result(obs, unrelated).classification).not.toBe('contradiction');
  });

  it('contradiction requires same scope — different temporal period avoids contradiction', () => {
    const old = claim('c1', {
      objectText: 'claim reconciliation',
      temporalScope: { eventType: 'released', eventDate: '2023-01-01', dateConfidence: 'exact' },
    });
    const obs = observation('o1', {
      objectText: 'claim reconciliation',
      polarity: 'negated',
      temporalScope: { eventType: 'released', eventDate: '2024-01-01', dateConfidence: 'exact' },
    });
    expect(result(obs, old).classification).not.toBe('contradiction');
  });

  it('same_claim requires objectText compatibility — different objectText is NOT same_claim', () => {
    const existing = claim('c1', { objectText: 'metric A' });
    const obs = observation('o1', {
      objectText: 'metric B',
      canonicalKey: { subject: 'trellis', predicate: 'supports' },
    });
    // subject/predicate match but objectText differs → sameKey fails → not same_claim
    expect(result(obs, existing).classification).not.toBe('same_claim');
  });

  it('same_claim requires temporal scope compatibility — different period is NOT same_claim', () => {
    const existing = claim('c1', {
      temporalScope: { eventType: 'released', eventDate: '2023-01-01', dateConfidence: 'exact' },
    });
    const obs = observation('o1', {
      temporalScope: { eventType: 'released', eventDate: '2024-01-01', dateConfidence: 'exact' },
    });
    expect(result(obs, existing).classification).not.toBe('same_claim');
  });

  it('classifies newer explicit replacement as supersedes', () => {
    const old = claim('c1', { temporalScope: { eventType: 'released', eventDate: '2024-01-01', dateConfidence: 'exact' }, currentObservationId: 'old-o' });
    const next = observation('o1', { observedAt: '2025-01-01', objectText: 'replaces old claim reconciliation', temporalScope: { eventType: 'updated', eventDate: '2025-01-01', dateConfidence: 'exact' } });
    const reconciliation = result(next, old);
    expect(reconciliation.classification).toBe('supersedes');
    expect(reconciliation.supersedes?.previousObservationId).toBe('old-o');
  });

  it('uses new claim for no match and borderline similarity', () => {
    expect(result(observation('o1', { subjectText: 'SQLite', predicate: 'stores', objectText: 'events', canonicalKey: { subject: 'sqlite', predicate: 'stores' } }), claim('c1', { canonicalKey: { subject: 'trellis', predicate: 'supports' } })).classification).toBe('new_claim');
    expect(result(observation('o2', { subjectText: 'Trellis unrelated topic', predicate: 'mentions', objectText: 'other data', canonicalKey: { subject: 'unrelated', predicate: 'mentions' } }), claim('c2', { canonicalKey: { subject: 'trellis', predicate: 'supports' } })).classification).toBe('new_claim');
  });

  it('isolates families and returns top five candidates ordered by score then id', () => {
    const otherFamily = claim('cross-family', { familyId: 'family-2' });
    expect(planClaimObservation(observation('o1'), stateWith(otherFamily)).reconciliation.classification).toBe('new_claim');
    // All candidates share same canonicalKey/objectText → sameKey passes → same_claim for all.
    const candidates = Array.from({ length: 6 }, (_, i) => claim(`c${i}`, { objectText: 'claim reconciliation' }));
    const reconciliation = planClaimObservation(observation('o2'), stateWith(...candidates)).reconciliation;
    expect(reconciliation.candidates).toHaveLength(5);
    expect(reconciliation.candidates.map((candidate) => candidate.claimId)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });

  it('emits lexical_rules_v2 when canonicalKey does not match exactly', () => {
    // Different canonicalKey subject → sameKey fails → lexical_rules_v2
    const obs = observation('o1', { canonicalKey: { subject: 'trellis', predicate: 'supports' } });
    const c = claim('c1', { canonicalKey: { subject: 'trellis', predicate: 'contradicts' } });
    expect(result(obs, c).method).toBe('lexical_rules_v2');
  });

  it('emits canonical_key_exact when canonicalKey matches exactly', () => {
    const r = result(observation('o1'), claim('c1'));
    expect(r.method).toBe('canonical_key_exact');
    expect(r.reconcilerVersion).toBe(4);
  });

  it('supersedes.previousAssertion contains only assertion fields, not claim-only fields', () => {
    const old = claim('c1', {
      temporalScope: { eventType: 'released', eventDate: '2024-01-01', dateConfidence: 'exact' },
      currentObservationId: 'old-o',
    });
    const next = observation('o1', {
      observedAt: '2025-01-01',
      objectText: 'replaces old claim reconciliation',
      temporalScope: { eventType: 'updated', eventDate: '2025-01-01', dateConfidence: 'exact' },
    });
    const reconciliation = result(next, old);
    expect(reconciliation.classification).toBe('supersedes');
    const pa = reconciliation.supersedes!.previousAssertion;
    // Must contain assertion fields
    expect(pa.subjectText).toBeDefined();
    expect(pa.predicate).toBeDefined();
    expect(pa.polarity).toBeDefined();
    expect(pa.hedge).toBeDefined();
    expect(pa.evidenceType).toBeDefined();
    expect(pa.canonicalKey).toBeDefined();
    // Must NOT contain claim-only fields
    expect(pa).not.toHaveProperty('id');
    expect(pa).not.toHaveProperty('familyId');
    expect(pa).not.toHaveProperty('confidence');
    expect(pa).not.toHaveProperty('contradictionState');
    expect(pa).not.toHaveProperty('firstSeenRunId');
    expect(pa).not.toHaveProperty('lastSeenRunId');
    expect(pa).not.toHaveProperty('revisionHistory');
    expect(pa).not.toHaveProperty('evidenceIds');
    expect(pa).not.toHaveProperty('observationIds');
  });

  // ── Supersession scope gating (v4) ──────────────────────────────────────

  it('same-entity replacement with lineage → supersedes', () => {
    const old = claim('c1', {
      objectText: 'claim reconciliation',
      temporalScope: { eventType: 'released', eventDate: '2024-01-01', dateConfidence: 'exact' },
      currentObservationId: 'old-o',
    });
    const next = observation('o1', {
      observedAt: '2025-01-01',
      objectText: 'replaces claim reconciliation with improved approach',
      temporalScope: { eventType: 'updated', eventDate: '2025-01-01', dateConfidence: 'exact' },
    });
    expect(result(next, old).classification).toBe('supersedes');
  });

  it('unrelated-topic + replacement wording + newer date → new_claim, not supersedes', () => {
    const old = claim('c1', {
      objectText: 'claim reconciliation',
      temporalScope: { eventType: 'released', eventDate: '2024-01-01', dateConfidence: 'exact' },
    });
    const next = observation('o1', {
      observedAt: '2025-01-01',
      canonicalKey: { subject: 'kubernetes', predicate: 'deprecates' },
      objectText: 'legacy deployment approach',
      temporalScope: { eventType: 'updated', eventDate: '2025-06-01', dateConfidence: 'exact' },
    });
    expect(result(next, old).classification).not.toBe('supersedes');
    expect(result(next, old).classification).toBe('new_claim');
  });

  it('replacement wording but no lineage reference to prior object → new_claim', () => {
    const old = claim('c1', {
      objectText: 'claim reconciliation',
      temporalScope: { eventType: 'released', eventDate: '2024-01-01', dateConfidence: 'exact' },
    });
    const next = observation('o1', {
      observedAt: '2025-01-01',
      objectText: 'replaces deprecated approach',
      temporalScope: { eventType: 'updated', eventDate: '2025-06-01', dateConfidence: 'exact' },
    });
    expect(result(next, old).classification).not.toBe('supersedes');
    expect(result(next, old).classification).toBe('new_claim');
  });

  // ── Entity-aware reconciliation (v3) ───────────────────────────────────

  it('same_claim when subjectEntityId matches even with different text', () => {
    // Two claims about NVIDIA H100 but with slightly different text
    // Same subjectEntityId → strong positive entity signal → same_claim
    const existing = claim('c1', {
      subjectEntityId: 'entity-nvidia-h100',
      subjectText: 'NVIDIA H100 GPU',
      objectText: '80GB memory',
      canonicalKey: { subject: 'nvidia h100', predicate: 'has' },
    });
    const obs1 = observation('o1', {
      subjectEntityId: 'entity-nvidia-h100',
      subjectText: 'NVIDIA H100',
      objectText: '80GB memory',
      canonicalKey: { subject: 'nvidia h100', predicate: 'has' },
    });
    expect(result(obs1, existing).classification).toBe('same_claim');
  });

  it('never same_claim when subjectEntityIds differ regardless of text similarity', () => {
    // Identical text but different entity IDs — entity signal hard-negates
    const existing = claim('c1', {
      subjectEntityId: 'entity-a',
      subjectText: 'CUDA support',
      objectText: 'frameworks',
      canonicalKey: { subject: 'cuda support', predicate: 'has' },
    });
    const obs1 = observation('o1', {
      subjectEntityId: 'entity-b',
      subjectText: 'CUDA support',
      objectText: 'frameworks',
      canonicalKey: { subject: 'cuda support', predicate: 'has' },
    });
    expect(result(obs1, existing).classification).not.toBe('same_claim');
  });

  it('ambiguity downgrade: near-tied text scores without entity confirmation → near_duplicate', () => {
    // Two existing claims with similar text but neither exact canonical key match.
    // Top-2 scores are near-tied and low confidence → ambiguity guard downgrades to near_duplicate
    const existing1 = claim('c1', {
      subjectText: 'machine learning', predicate: 'requires', objectText: 'data',
      canonicalKey: { subject: 'machine learning', predicate: 'requires' },
    });
    const existing2 = claim('c2', {
      subjectText: 'deep learning', predicate: 'requires', objectText: 'data',
      canonicalKey: { subject: 'deep learning', predicate: 'requires' },
    });
    // Observation that is very similar to both existing claims but not an exact key match
    const obs1 = observation('o1', {
      subjectText: 'machine learning models', predicate: 'needs', objectText: 'training data',
      canonicalKey: { subject: 'machine learning models', predicate: 'needs' },
    });
    const reconciliation = planClaimObservation(obs1, stateWith(existing1, existing2)).reconciliation;
    // The classification should NOT be same_claim (would have been on text score alone)
    // because neither exact canonical key nor entity ID confirms it
    expect(reconciliation.classification).not.toBe('same_claim');
  });

  it('still same_claim when entity IDs match AND canonical key matches', () => {
    // Entity ID match + canonical key match → definite same_claim
    const existing = claim('c1', {
      subjectEntityId: 'entity-trellis',
      subjectText: 'Trellis', predicate: 'supports', objectText: 'reconciliation',
      canonicalKey: { subject: 'trellis', predicate: 'supports' },
    });
    const obs1 = observation('o1', {
      subjectEntityId: 'entity-trellis',
      subjectText: 'Trellis system', predicate: 'supports', objectText: 'reconciliation',
      canonicalKey: { subject: 'trellis', predicate: 'supports' },
    });
    expect(result(obs1, existing).classification).toBe('same_claim');
  });

  it('observation with subjectEntityId only uses entity signal for subject', () => {
    // Only observation has subjectEntityId set (claim doesn't) → entity signal skipped (not both set)
    const existing = claim('c1', {
      subjectText: 'Trellis', predicate: 'supports', objectText: 'reconciliation',
      canonicalKey: { subject: 'trellis', predicate: 'supports' },
    });
    const obs1 = observation('o1', {
      subjectEntityId: 'entity-trellis',
      subjectText: 'Trellis', predicate: 'supports', objectText: 'reconciliation',
      canonicalKey: { subject: 'trellis', predicate: 'supports' },
    });
    // Without both entity IDs set, falls back to text scoring — canonical key match → same_claim
    expect(result(obs1, existing).classification).toBe('same_claim');
  });
});
