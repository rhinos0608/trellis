import { describe, it, expect } from 'vitest';
import {
  getClaimsByFamily,
  getEvidenceForClaim,
  getContradictionsByFamily,
  getGapsByFamily,
  getEntityById,
  findEntityByLabel,
} from '../../src/graph/queries.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import type { ProjectionState } from '../../src/store/projectionState.js';

describe('queries', () => {
  function stateWithFixtures(): ProjectionState {
    const state = createEmptyProjectionState();

    state.entities.set('e1', {
      id: 'e1', label: 'React', canonicalLabel: null, entityType: 'package',
      aliases: [], extractionConfidence: 0.9, firstSeenRunId: 'r1', lastUpdatedRunId: 'r1', metadata: {},
    });
    state.entities.set('e2', {
      id: 'e2', label: 'Vue', canonicalLabel: null, entityType: 'package',
      aliases: [], extractionConfidence: 0.8, firstSeenRunId: 'r1', lastUpdatedRunId: 'r1', metadata: {},
    });

    state.claims.set('c1', {
      id: 'c1', familyId: 'fam-1', subjectText: 'React', predicate: 'is fast',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'study', confidence: 0.9,
      canonicalKey: { subject: 'react', predicate: 'is fast' }, contradictionState: 'none',
      firstSeenRunId: 'r1', lastSeenRunId: 'r1',
    });
    state.claims.set('c2', {
      id: 'c2', familyId: 'fam-1', subjectText: 'React', predicate: 'is popular',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'study', confidence: 0.8,
      canonicalKey: { subject: 'react', predicate: 'is popular' }, contradictionState: 'none',
      firstSeenRunId: 'r1', lastSeenRunId: 'r1',
    });
    state.claims.set('c3', {
      id: 'c3', familyId: 'fam-2', subjectText: 'Vue', predicate: 'is easy',
      polarity: 'asserted', hedge: 'certain', evidenceType: 'opinion', confidence: 0.7,
      canonicalKey: { subject: 'vue', predicate: 'is easy' }, contradictionState: 'none',
      firstSeenRunId: 'r1', lastSeenRunId: 'r1',
    });

    state.evidence.set('ev1', { id: 'ev1', claimId: 'c1', sourceId: 'src-1', runId: 'r1' });
    state.evidence.set('ev2', { id: 'ev2', claimId: 'c1', sourceId: 'src-2', runId: 'r1' });

    state.contradictions.set('cn1', {
      id: 'cn1', familyId: 'fam-1', claimIdA: 'c1', claimIdB: 'c2',
      contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved',
      firstSeenRunId: 'r1',
    });

    state.gaps.set('g1', {
      id: 'g1', familyId: 'fam-1', question: 'Q1', category: 'low_confidence',
      status: 'open', priority: 1, firstSeenRunId: 'r1',
    });

    // Set up reverse indices
    const c1fam = new Set<string>(['c1', 'c2']);
    const c2fam = new Set<string>(['c3']);
    state.claimsByFamilyId.set('fam-1', c1fam);
    state.claimsByFamilyId.set('fam-2', c2fam);
    const evSet = new Set<string>(['ev1', 'ev2']);
    state.evidenceByClaimId.set('c1', evSet);

    return state;
  }

  describe('getClaimsByFamily', () => {
    it('returns claims for the given family', () => {
      const state = stateWithFixtures();
      const claims = getClaimsByFamily(state, 'fam-1');
      expect(claims.length).toBe(2);
      expect(claims.map((c) => c.id)).toEqual(expect.arrayContaining(['c1', 'c2']));
    });

    it('returns empty for unknown family', () => {
      const state = stateWithFixtures();
      expect(getClaimsByFamily(state, 'unknown')).toEqual([]);
    });
  });

  describe('getEvidenceForClaim', () => {
    it('returns evidence for the given claim', () => {
      const state = stateWithFixtures();
      const evidence = getEvidenceForClaim(state, 'c1');
      expect(evidence.length).toBe(2);
    });

    it('returns empty for unknown claim', () => {
      const state = stateWithFixtures();
      expect(getEvidenceForClaim(state, 'unknown')).toEqual([]);
    });
  });

  describe('getContradictionsByFamily', () => {
    it('returns contradictions for the family', () => {
      const state = stateWithFixtures();
      const result = getContradictionsByFamily(state, 'fam-1');
      expect(result.length).toBe(1);
      expect(result[0]!.id).toBe('cn1');
    });

    it('returns empty for family without contradictions', () => {
      const state = stateWithFixtures();
      expect(getContradictionsByFamily(state, 'fam-2')).toEqual([]);
    });
  });

  describe('getGapsByFamily', () => {
    it('returns gaps for the family', () => {
      const state = stateWithFixtures();
      const result = getGapsByFamily(state, 'fam-1');
      expect(result.length).toBe(1);
      expect(result[0]!.id).toBe('g1');
    });

    it('returns empty for family without gaps', () => {
      const state = stateWithFixtures();
      expect(getGapsByFamily(state, 'fam-2')).toEqual([]);
    });
  });

  describe('getEntityById', () => {
    it('returns entity by id', () => {
      const state = stateWithFixtures();
      expect(getEntityById(state, 'e1')!.label).toBe('React');
    });

    it('returns undefined for unknown id', () => {
      const state = stateWithFixtures();
      expect(getEntityById(state, 'unknown')).toBeUndefined();
    });
  });

  describe('findEntityByLabel', () => {
    it('finds entity by case-insensitive label', () => {
      const state = stateWithFixtures();
      expect(findEntityByLabel(state, 'react')!.id).toBe('e1');
      expect(findEntityByLabel(state, 'REACT')!.id).toBe('e1');
    });

    it('returns undefined for unknown label', () => {
      const state = stateWithFixtures();
      expect(findEntityByLabel(state, 'Angular')).toBeUndefined();
    });
  });
});
