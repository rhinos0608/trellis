import { describe, it, expect } from 'vitest';
import { deriveEpistemicState } from '../../src/graph/epistemics.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import type { ProjectionState } from '../../src/store/projectionState.js';
import type {
  Claim,
  ClaimObservation,
  Evidence,
  Source,
} from '../../src/graph/types.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeSource(
  id: string,
  domain: string,
  authorityClass: Source['authorityClass'] = 'unknown',
  publishedAt?: string,
): Source {
  return {
    id,
    url: `https://${domain}/${id}`,
    canonicalUrl: `https://${domain}/${id}`,
    domain,
    sourceType: 'web',
    authorityClass,
    isPrimary: false,
    extractionStatus: 'extracted',
    retrievedAt: '2024-06-01T00:00:00Z',
    publishedAt,
    firstSeenRunId: 'run-1',
    lastSeenRunId: 'run-1',
    lastSeenAt: '2024-06-01T00:00:00Z',
    runCount: 1,
  };
}

function makeObservation(
  id: string,
  familyId: string,
  sourceIds: string[],
  confidence: number,
  evidenceType: Claim['evidenceType'] = 'claim',
): ClaimObservation {
  return {
    id,
    familyId,
    runId: 'run-1',
    observedAt: '2024-06-01T00:00:00Z',
    subjectText: `Subject ${id}`,
    predicate: 'has property',
    objectText: `Object ${id}`,
    polarity: 'asserted',
    hedge: 'certain',
    evidenceType,
    confidence,
    sourceIds,
    extractionVersion: 'test-v1',
    canonicalKey: { subject: `subject-${id}`, predicate: 'has-property' },
  };
}

function makeEvidence(
  id: string,
  claimId: string,
  sourceId: string,
  stance: Evidence['stance'] = 'supports',
  excerpt?: string,
): Evidence {
  return {
    id,
    claimId,
    sourceId,
    stance,
    ...(excerpt === undefined ? {} : { excerpt }),
    runId: 'run-1',
  };
}

function makeClaim(
  id: string,
  familyId: string,
  observationIds: string[],
  evidenceIds: string[] = [],
): Claim {
  return {
    id,
    familyId,
    subjectText: `Subject ${id}`,
    predicate: 'has property',
    polarity: 'asserted',
    hedge: 'certain',
    evidenceType: 'claim',
    confidence: 0,
    canonicalKey: { subject: `subject-${id}`, predicate: 'has-property' },
    contradictionState: 'none',
    firstSeenRunId: 'run-1',
    lastSeenRunId: 'run-1',
    observationIds,
    observationCount: observationIds.length,
    evidenceIds,
    supportingEvidenceCount: 0,
    opposingEvidenceCount: 0,
  };
}

function buildState(
  sources: Source[],
  observations: ClaimObservation[],
  evidence: Evidence[],
  claims: Claim[],
): ProjectionState {
  const state = createEmptyProjectionState();
  for (const s of sources) state.sources.set(s.id, s);
  for (const o of observations) {
    state.claimObservations.set(o.id, o);
    state.observationToClaimId.set(o.id, claims.find((c) => c.observationIds?.includes(o.id))?.id ?? '');
  }
  for (const e of evidence) state.evidence.set(e.id, e);
  for (const c of claims) {
    state.claims.set(c.id, c);
    const set = state.observationsByClaimId.get(c.id) ?? new Set();
    for (const obsId of c.observationIds ?? []) set.add(obsId);
    state.observationsByClaimId.set(c.id, set);
  }
  return state;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('deriveEpistemicState', () => {
  it('unknown — zero evidence → zero confidence', () => {
    const claim = makeClaim('c1', 'f1', [], []);
    const state = buildState([], [], [], [claim]);
    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.confidence).toBe(0);
    expect(result.epistemicStatus).toBe('unknown');
    expect(result.contradictionState).toBe('none');
    expect(result.supportLevel).toBe('weak');
  });

  it('consensus — 2 authoritative observations from different domains', () => {
    const src1 = makeSource('s1', 'docs.example.com', 'official_spec', '2024-01-01T00:00:00Z');
    const src2 = makeSource('s2', 'blog.other.com', 'third_party_analysis', '2024-03-01T00:00:00Z');
    const obs1 = makeObservation('o1', 'f1', ['s1'], 0.9, 'study');
    const obs2 = makeObservation('o2', 'f1', ['s2'], 0.8, 'benchmark');
    const ev1 = makeEvidence('e1', 'c1', 's1', 'supports');
    const ev2 = makeEvidence('e2', 'c1', 's2', 'supports');
    const claim = makeClaim('c1', 'f1', ['o1', 'o2'], ['e1', 'e2']);
    const state = buildState([src1, src2], [obs1, obs2], [ev1, ev2], [claim]);

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.epistemicStatus).toBe('consensus');
    expect(result.contradictionState).toBe('none');
    expect(result.supportLevel).toBe('primary');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('not consensus — identical evidence text across 2 domains counts as one source', () => {
    const src1 = makeSource('s1', 'wire.example.com', 'news');
    const src2 = makeSource('s2', 'local.example.com', 'news');
    const obs1 = makeObservation('o1', 'f1', ['s1'], 0.8, 'study');
    const obs2 = makeObservation('o2', 'f1', ['s2'], 0.8, 'study');
    const excerpt = 'Identical syndicated evidence text.';
    const ev1 = makeEvidence('e1', 'c1', 's1', 'supports', excerpt);
    const ev2 = makeEvidence('e2', 'c1', 's2', 'supports', excerpt);
    const claim = makeClaim('c1', 'f1', ['o1', 'o2'], ['e1', 'e2']);
    const state = buildState([src1, src2], [obs1, obs2], [ev1, ev2], [claim]);

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.epistemicStatus).toBe('emerging');
  });

  it('consensus — distinct evidence text across 2 domains counts as 2 sources', () => {
    const src1 = makeSource('s1', 'docs.example.com', 'official_spec');
    const src2 = makeSource('s2', 'blog.other.com', 'third_party_analysis');
    const obs1 = makeObservation('o1', 'f1', ['s1'], 0.9, 'study');
    const obs2 = makeObservation('o2', 'f1', ['s2'], 0.8, 'benchmark');
    const ev1 = makeEvidence('e1', 'c1', 's1', 'supports', 'Distinct evidence text one.');
    const ev2 = makeEvidence('e2', 'c1', 's2', 'supports', 'Distinct evidence text two.');
    const claim = makeClaim('c1', 'f1', ['o1', 'o2'], ['e1', 'e2']);
    const state = buildState([src1, src2], [obs1, obs2], [ev1, ev2], [claim]);

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.epistemicStatus).toBe('consensus');
  });

  it('not consensus — 1 observation with evidence from 2 domains falls back to emerging', () => {
    const src1 = makeSource('s1', 'a.com', 'news', '2024-01-01T00:00:00Z');
    const src2 = makeSource('s2', 'b.com', 'third_party_analysis', '2024-03-01T00:00:00Z');
    const obs1 = makeObservation('o1', 'f1', ['s1'], 0.8, 'study');
    const ev1 = makeEvidence('e1', 'c1', 's1', 'supports');
    const ev2 = makeEvidence('e2', 'c1', 's2', 'supports');
    const claim = makeClaim('c1', 'f1', ['o1'], ['e1', 'e2']);
    const state = buildState([src1, src2], [obs1], [ev1, ev2], [claim]);

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    // Evidence from 2 domains but only 1 observation → not enough for consensus
    expect(result.epistemicStatus).not.toBe('consensus');
    // Has active evidence → falls back to emerging
    expect(result.epistemicStatus).toBe('emerging');
  });

  it('contested — supporting + opposing evidence → contested state, dampened confidence', () => {
    const src1 = makeSource('s1', 'a.com', 'news');
    const src2 = makeSource('s2', 'b.com', 'forum_social');
    const obs1 = makeObservation('o1', 'f1', ['s1'], 0.9, 'claim');
    const obs2 = makeObservation('o2', 'f1', ['s2'], 0.8, 'claim');
    const ev1 = makeEvidence('e1', 'c1', 's1', 'supports');
    const ev2 = makeEvidence('e2', 'c1', 's2', 'opposes');
    const claim = makeClaim('c1', 'f1', ['o1', 'o2'], ['e1', 'e2']);
    const state = buildState([src1, src2], [obs1, obs2], [ev1, ev2], [claim]);

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.contradictionState).toBe('contested');
    expect(result.epistemicStatus).toBe('contested');
    expect(result.supportLevel).toBe('conflicting');
    // Confidence should be dampened from opposing evidence
    expect(result.confidence).toBeLessThan(0.9);
  });

  it('contested — unresolved Contradiction row → contested', () => {
    const src = makeSource('s1', 'a.com', 'news');
    const obs1 = makeObservation('o1', 'f1', ['s1'], 0.8);
    const obs2 = makeObservation('o2', 'f1', ['s1'], 0.7);
    const claim = makeClaim('c1', 'f1', ['o1', 'o2']);
    const state = buildState([src], [obs1, obs2], [], [claim]);

    // Add an unresolved contradiction referencing this claim
    state.contradictions.set('con-1', {
      id: 'con-1',
      familyId: 'f1',
      claimIdA: 'c1',
      claimIdB: 'c2',
      contradictionType: 'factual_disagreement',
      resolutionStatus: 'unresolved',
      firstSeenRunId: 'run-1',
    });

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.contradictionState).toBe('contested');
    expect(result.epistemicStatus).toBe('contested');
  });

  it('speculative — single anecdotal observation', () => {
    const src = makeSource('s1', 'forum.com', 'forum_social');
    const obs = makeObservation('o1', 'f1', ['s1'], 0.5, 'anecdote');
    const claim = makeClaim('c1', 'f1', ['o1']);
    const state = buildState([src], [obs], [], [claim]);

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.epistemicStatus).toBe('speculative');
    expect(result.supportLevel).toBe('weak');
    expect(result.confidence).toBeLessThan(0.6);
  });

  it('emerging — 2 observations from same domain', () => {
    const src = makeSource('s1', 'a.com', 'news');
    const obs1 = makeObservation('o1', 'f1', ['s1'], 0.7, 'claim');
    const obs2 = makeObservation('o2', 'f1', ['s1'], 0.6, 'study');
    const claim = makeClaim('c1', 'f1', ['o1', 'o2']);
    const state = buildState([src], [obs1, obs2], [], [claim]);

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.epistemicStatus).toBe('emerging');
    expect(result.contradictionState).toBe('none');
  });

  it('resolved contradictions → resolved state', () => {
    const src = makeSource('s1', 'a.com', 'news');
    const obs = makeObservation('o1', 'f1', ['s1'], 0.8);
    const claim = makeClaim('c1', 'f1', ['o1']);
    const state = buildState([src], [obs], [], [claim]);

    state.contradictions.set('con-1', {
      id: 'con-1',
      familyId: 'f1',
      claimIdA: 'c1',
      claimIdB: 'c2',
      contradictionType: 'factual_disagreement',
      resolutionStatus: 'resolved',
      firstSeenRunId: 'run-1',
      resolvedRunId: 'run-2',
    });

    const result = deriveEpistemicState(state, claim, '2024-06-01T00:00:00Z');

    expect(result.contradictionState).toBe('resolved');
  });
});
