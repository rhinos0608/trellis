import { describe, expect, it } from 'vitest';
import { verifyProjectionIntegrity } from '../../src/store/projectionIntegrity.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import type { Claim, Evidence, Source } from '../../src/graph/types.js';

function makeState() {
  const state = createEmptyProjectionState();

  const source: Source = {
    id: 'source-1', url: 'https://example.com', title: 'Test', retrievedAt: '2025-01-01',
    contentHash: 'h1', firstSeenRunId: 'run-1', lastSeenRunId: 'run-1',
  };
  state.sources.set(source.id, source);

  const claim: Claim = {
    id: 'claim-1', familyId: 'f1', subjectText: 'Trellis', predicate: 'works',
    objectText: 'well', polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
    canonicalKey: { subject: 'trellis', predicate: 'works' },
    contradictionState: 'none', firstSeenRunId: 'run-1', lastSeenRunId: 'run-1',
    evidenceIds: ['evd-1'],
  };
  state.claims.set(claim.id, claim);
  const claimIds = state.claimsByFamilyId.get(claim.familyId) ?? new Set<string>();
  claimIds.add(claim.id);
  state.claimsByFamilyId.set(claim.familyId, claimIds);

  const evidence: Evidence = {
    id: 'evd-1', claimId: 'claim-1', sourceId: 'source-1', runId: 'run-1',
  };
  state.evidence.set(evidence.id, evidence);
  const evIds = state.evidenceByClaimId.get(evidence.claimId) ?? new Set<string>();
  evIds.add(evidence.id);
  state.evidenceByClaimId.set(evidence.claimId, evIds);

  return state;
}

describe('verifyProjectionIntegrity', () => {
  it('returns matches for valid claim with evidence', () => {
    const result = verifyProjectionIntegrity(makeState());
    expect(result.matches).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it('reports mismatch when claim has no evidence', () => {
    const state = makeState();
    const orphan: Claim = {
      id: 'claim-orphan', familyId: 'f1', subjectText: 'X', predicate: 'y',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
      canonicalKey: { subject: 'x', predicate: 'y' },
      contradictionState: 'none', firstSeenRunId: 'run-1', lastSeenRunId: 'run-1',
    };
    state.claims.set(orphan.id, orphan);
    const ids = state.claimsByFamilyId.get('f1') ?? new Set<string>();
    ids.add(orphan.id);
    state.claimsByFamilyId.set('f1', ids);

    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.includes('claim-orphan') && m.includes('no valid evidence'))).toBe(true);
  });

  it('does NOT report mismatch for merged tombstone claim without evidence', () => {
    const state = makeState();
    const tombstone: Claim = {
      id: 'claim-tomb', familyId: 'f1', subjectText: 'X', predicate: 'y',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
      canonicalKey: { subject: 'x', predicate: 'y' },
      contradictionState: 'none', firstSeenRunId: 'run-1', lastSeenRunId: 'run-1',
      curationStatus: 'merged',
    };
    state.claims.set(tombstone.id, tombstone);
    const ids = state.claimsByFamilyId.get('f1') ?? new Set<string>();
    ids.add(tombstone.id);
    state.claimsByFamilyId.set('f1', ids);

    const result = verifyProjectionIntegrity(state);
    expect(result.mismatches.some((m) => m.includes('claim-tomb'))).toBe(false);
  });

  it('does NOT report mismatch for split tombstone claim without evidence', () => {
    const state = makeState();
    const tombstone: Claim = {
      id: 'claim-split-tomb', familyId: 'f1', subjectText: 'X', predicate: 'y',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
      canonicalKey: { subject: 'x', predicate: 'y' },
      contradictionState: 'none', firstSeenRunId: 'run-1', lastSeenRunId: 'run-1',
      curationStatus: 'split',
    };
    state.claims.set(tombstone.id, tombstone);
    const ids = state.claimsByFamilyId.get('f1') ?? new Set<string>();
    ids.add(tombstone.id);
    state.claimsByFamilyId.set('f1', ids);

    const result = verifyProjectionIntegrity(state);
    expect(result.mismatches.some((m) => m.includes('claim-split-tomb'))).toBe(false);
  });

  it('reports mismatch for retracted claim without evidence (retraction retains provenance)', () => {
    const state = makeState();
    const retracted: Claim = {
      id: 'claim-ret', familyId: 'f1', subjectText: 'X', predicate: 'y',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
      canonicalKey: { subject: 'x', predicate: 'y' },
      contradictionState: 'none', firstSeenRunId: 'run-1', lastSeenRunId: 'run-1',
      curationStatus: 'retracted',
    };
    state.claims.set(retracted.id, retracted);
    const ids = state.claimsByFamilyId.get('f1') ?? new Set<string>();
    ids.add(retracted.id);
    state.claimsByFamilyId.set('f1', ids);

    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.includes('claim-ret') && m.includes('no valid evidence'))).toBe(true);
  });

  it('reports evidence referencing nonexistent source', () => {
    const state = makeState();
    const badEvidence: Evidence = {
      id: 'evd-bad', claimId: 'claim-1', sourceId: 'source-missing', runId: 'run-1',
    };
    state.evidence.set(badEvidence.id, badEvidence);
    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.includes('evd-bad') && m.includes('nonexistent source'))).toBe(true);
  });

  it('reports mismatch when evidenceIds on claim drift from state.evidence', () => {
    const state = makeState();
    const claim = state.claims.get('claim-1')!;
    claim.evidenceIds = ['evd-nonexistent'];
    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.includes('evd-nonexistent') && m.includes('nonexistent evidence record'))).toBe(true);
  });

  it('reports mismatch when evidenceByClaimId index drifts from authoritative evidence', () => {
    const state = makeState();
    // Add stale entry to reverse index
    const idx = state.evidenceByClaimId.get('claim-1') ?? new Set<string>();
    idx.add('evd-ghost');
    state.evidenceByClaimId.set('claim-1', idx);

    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.includes('evd-ghost') && m.includes('not in authoritative evidence'))).toBe(true);
  });

  it('reports mismatch when authoritative evidence missing from evidenceByClaimId index', () => {
    const state = makeState();
    // Clear the reverse index for claim-1
    state.evidenceByClaimId.set('claim-1', new Set<string>());

    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.includes('evd-1') && m.includes('missing from evidenceByClaimId index'))).toBe(true);
  });

  it('reports mismatch when claim.evidenceIds is empty but real evidence exists for the claim', () => {
    const state = makeState();
    const claim = state.claims.get('claim-1')!;
    // evd-1 exists in state.evidence with claimId='claim-1', but evidenceIds says []
    claim.evidenceIds = [];
    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.includes('claim-1') && m.includes('evd-1') && m.includes('missing from claim.evidenceIds'))).toBe(true);
  });

  it('reports orphan evidence and reverse-index keys', () => {
    const state = makeState();
    state.evidence.set('evd-missing-source', { id: 'evd-missing-source', claimId: 'claim-1', sourceId: 'source-missing', runId: 'run-1' });
    state.evidence.set('evd-missing-claim', { id: 'evd-missing-claim', claimId: 'claim-missing', sourceId: 'source-1', runId: 'run-1' });
    state.evidenceByClaimId.set('claim-missing', new Set(['evd-missing-claim']));

    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches).toEqual(expect.arrayContaining([
      'evidence evd-missing-source: references nonexistent source source-missing',
      'evidence evd-missing-claim: references nonexistent claim claim-missing',
      'evidenceByClaimId contains nonexistent claim claim-missing',
    ]));
  });

  it('reports mismatch when claim.evidenceIds contains evidence belonging to another claim', () => {
    const state = makeState();
    // Add a second claim with its own evidence
    const claim2: Claim = {
      id: 'claim-2', familyId: 'f1', subjectText: 'X', predicate: 'y',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'study',
      canonicalKey: { subject: 'x', predicate: 'y' },
      contradictionState: 'none', firstSeenRunId: 'run-1', lastSeenRunId: 'run-1',
      evidenceIds: ['evd-2'],
    };
    state.claims.set(claim2.id, claim2);
    const ev2: Evidence = { id: 'evd-2', claimId: 'claim-2', sourceId: 'source-1', runId: 'run-1' };
    state.evidence.set(ev2.id, ev2);
    const idx2 = state.evidenceByClaimId.get('claim-2') ?? new Set<string>();
    idx2.add(ev2.id);
    state.evidenceByClaimId.set('claim-2', idx2);

    // claim-1 steals evd-2 which belongs to claim-2
    const claim1 = state.claims.get('claim-1')!;
    claim1.evidenceIds = ['evd-1', 'evd-2'];

    const result = verifyProjectionIntegrity(state);
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((m) => m.includes('claim-1') && m.includes('evd-2') && m.includes('not owned by this claim'))).toBe(true);
  });
});
