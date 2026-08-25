import { describe, it, expect } from 'vitest';
import {
  createEmptyProjectionState,
  canonicalSerializeProjectionState,
  computeProjectionChecksum,
  PROJECTION_CHECKSUM_VERSION,
} from '../../src/store/index.js';
import type { ProjectionState } from '../../src/store/projectionState.js';

// ── Helpers ─────────────────────────────────────────────────────────

function makeState(): ProjectionState {
  return createEmptyProjectionState();
}

// ── Test 1: Value-mutation detection ────────────────────────────────

describe('checksum: value-mutation detection', () => {
  it('different field value on same entity ID produces different checksum', () => {
    const state1 = makeState();
    state1.entities.set('e1', {
      id: 'e1', label: 'Alpha', canonicalLabel: null, entityType: 'protocol',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r1',
      lastUpdatedRunId: 'r1', metadata: {},
    });

    const state2 = makeState();
    state2.entities.set('e1', {
      id: 'e1', label: 'BETA', canonicalLabel: null, entityType: 'protocol',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r1',
      lastUpdatedRunId: 'r1', metadata: {},
    });

    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });
});

// ── Test 2: All-collections coverage ────────────────────────────────

describe('checksum: all-collections coverage', () => {
  it('extra Evidence entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.evidence.set('ev1', {
      id: 'ev1', claimId: 'c1', sourceId: 's1', runId: 'r1',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra Family entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.families.set('f1', {
      id: 'f1', label: 'Family 1', manifest: { scopeQuery: 'test' },
      createdAt: '2024-01-01T00:00:00.000Z', lastActivity: '2024-01-01T00:00:00.000Z',
      relatedFamilies: [],
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra Gap entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.gaps.set('g1', {
      id: 'g1', familyId: 'f1', question: 'What?', category: 'unanswered_sub_question',
      status: 'open', priority: 1, firstSeenRunId: 'r1',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra reverse-index entry (evidenceByClaimId) changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.evidenceByClaimId.set('c1', new Set(['ev1']));
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra entityFamilyMemberships entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.entityFamilyMemberships.push({
      entityId: 'e1', familyId: 'f1', confidence: 0.9, isPrimary: true, runId: 'r1',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra rolledBackRuns entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.rolledBackRuns.add('run-x');
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra entityMergeHistory entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.entityMergeHistory.set('e1', { fromId: 'e1', intoId: 'e2', fromLabel: 'X', mergedEventId: 'ev1' });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra claims entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.claims.set('c1', {
      id: 'c1', familyId: 'f1', subjectText: 'test', predicate: 'test', polarity: 'asserted',
      hedge: 'certain', evidenceType: 'study', confidence: 0.9,
      canonicalKey: { subject: 'a', predicate: 'b' }, contradictionState: 'none',
      firstSeenRunId: 'r1', lastSeenRunId: 'r1',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra claimRelations entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.claimRelations.set('rel1', {
      id: 'rel1', fromClaimId: 'c1', toClaimId: 'c2', relation: 'supports',
      strength: 'strong', score: 0.9, runId: 'r1',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra contradictions entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.contradictions.set('con1', {
      id: 'con1', familyId: 'f1', claimIdA: 'c1', claimIdB: 'c2',
      contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved',
      likelyExplanation: null, firstSeenRunId: 'r1',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra sources entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.sources.set('s1', {
      id: 's1', url: 'https://example.com', title: 'Ex', domain: 'example.com',
      sourceType: 'web', isPrimary: true, extractionStatus: 'pending',
      contentHash: 'abc', retrievedAt: '2024-01-01T00:00:00Z', firstSeenRunId: 'r1',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra threads entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.threads.set('t1', {
      id: 't1', familyId: 'f1', label: 'Thread', createdAt: '2024-01-01T00:00:00Z', status: 'open',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra researchRuns entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.researchRuns.set('rr1', {
      runId: 'rr1', familyId: 'f1', query: 'test', status: 'completed',
      startedAt: '2024-01-01T00:00:00Z',
    });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra claimRelationsByFromClaimId entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.claimRelationsByFromClaimId.set('c1', new Set(['rel1']));
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra claimRelationsByToClaimId entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.claimRelationsByToClaimId.set('c2', new Set(['rel1']));
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra claimsByFamilyId entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.claimsByFamilyId.set('f1', new Set(['c1']));
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra threadsByFamilyId entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.threadsByFamilyId.set('f1', new Set(['t1']));
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra entityFamilyKeys entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.entityFamilyKeys.add('e1|f1');
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });

  it('extra familyMergeHistory entry changes checksum', () => {
    const state1 = makeState();
    const state2 = makeState();
    state2.familyMergeHistory.set('f1', { fromId: 'f1', intoId: 'f2', fromLabel: 'F1', mergedEventId: 'ev1' });
    expect(computeProjectionChecksum(state1)).not.toBe(computeProjectionChecksum(state2));
  });
});

// ── Test 7: Canonical string order (code-unit) ─────────────────────

describe('checksum: canonical string order', () => {
  it('sorts keys by UTF-16 code units, not locale', () => {
    const state = makeState();
    state.entities.set('B', {
      id: 'B', label: 'B', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: {},
    });
    state.entities.set('a', {
      id: 'a', label: 'a', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: {},
    });
    const serialized = canonicalSerializeProjectionState(state);
    const bIdx = serialized.indexOf('"B"');
    const aIdx = serialized.indexOf('"a"');
    // 'B' (0x42) < 'a' (0x61) in code-unit order
    expect(bIdx).toBeLessThan(aIdx);
  });
});

// ── Test 3: Order-independence (true canonicalization) ──────────────

describe('checksum: order-independence', () => {
  it('same logical state with different Map insertion order yields identical checksum', () => {
    // State 1: insert A then B
    const state1 = makeState();
    state1.entities.set('a', {
      id: 'a', label: 'A', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: {},
    });
    state1.entities.set('b', {
      id: 'b', label: 'B', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: {},
    });

    // State 2: insert B then A
    const state2 = makeState();
    state2.entities.set('b', {
      id: 'b', label: 'B', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: {},
    });
    state2.entities.set('a', {
      id: 'a', label: 'A', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: {},
    });

    expect(canonicalSerializeProjectionState(state1)).toBe(canonicalSerializeProjectionState(state2));
    expect(computeProjectionChecksum(state1)).toBe(computeProjectionChecksum(state2));
  });

  it('same logical Set elements with different insertion order yields identical checksum', () => {
    const state1 = makeState();
    state1.entityFamilyKeys.add('z-key');
    state1.entityFamilyKeys.add('a-key');

    const state2 = makeState();
    state2.entityFamilyKeys.add('a-key');
    state2.entityFamilyKeys.add('z-key');

    expect(canonicalSerializeProjectionState(state1)).toBe(canonicalSerializeProjectionState(state2));
    expect(computeProjectionChecksum(state1)).toBe(computeProjectionChecksum(state2));
  });
});

// ── Test 4: Nested object key order independence ────────────────────

describe('checksum: nested object key order independence', () => {
  it('same metadata content with different key order yields identical checksum', () => {
    const state1 = makeState();
    state1.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { a: 1, b: 2 },
    });

    const state2 = makeState();
    state2.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { b: 2, a: 1 },
    });

    expect(canonicalSerializeProjectionState(state1)).toBe(canonicalSerializeProjectionState(state2));
    expect(computeProjectionChecksum(state1)).toBe(computeProjectionChecksum(state2));
  });

  it('deeply nested objects with different key order yield identical checksum', () => {
    const state1 = makeState();
    state1.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { outer: { z: 1, a: 2 } },
    });

    const state2 = makeState();
    state2.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { outer: { a: 2, z: 1 } },
    });

    expect(canonicalSerializeProjectionState(state1)).toBe(canonicalSerializeProjectionState(state2));
    expect(computeProjectionChecksum(state1)).toBe(computeProjectionChecksum(state2));
  });
});

// ── Test 5: Non-JSON-safe value rejection ───────────────────────────

describe('checksum: non-JSON-safe value rejection', () => {
  it('throws on NaN', () => {
    const state = makeState();
    state.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { bad: NaN },
    });
    expect(() => canonicalSerializeProjectionState(state)).toThrow('Non-JSON-safe value');
  });

  it('throws on undefined', () => {
    const state = makeState();
    state.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { bad: undefined },
    });
    expect(() => canonicalSerializeProjectionState(state)).toThrow('Non-JSON-safe value');
  });

  it('throws on Infinity', () => {
    const state = makeState();
    state.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { bad: Infinity },
    });
    expect(() => canonicalSerializeProjectionState(state)).toThrow('Non-JSON-safe value');
  });

  it('throws on function', () => {
    const state = makeState();
    state.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { bad: (() => {}) as unknown },
    });
    expect(() => canonicalSerializeProjectionState(state)).toThrow('Non-JSON-safe value');
  });

  it('throws on bigint', () => {
    const state = makeState();
    state.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: { bad: 42n },
    });
    expect(() => canonicalSerializeProjectionState(state)).toThrow('Non-JSON-safe value');
  });

  it('throws on unsafe value inside a Set (entityFamilyKeys)', () => {
    const state = makeState();
    (state.entityFamilyKeys as Set<unknown>).add(NaN);
    expect(() => canonicalSerializeProjectionState(state)).toThrow('Non-JSON-safe value');
  });

  it('throws on unsafe value inside a reverse-index Set (evidenceByClaimId)', () => {
    const state = makeState();
    state.evidenceByClaimId.set('c1', new Set<unknown>([undefined]) as Set<string>);
    expect(() => canonicalSerializeProjectionState(state)).toThrow('Non-JSON-safe value');
  });
});

// ── Test 6: Checksum format ─────────────────────────────────────────

describe('checksum: format', () => {
  it('matches expected versioned format', () => {
    const state = makeState();
    state.entities.set('e1', {
      id: 'e1', label: 'X', canonicalLabel: null, entityType: 't',
      aliases: [], extractionConfidence: null, firstSeenRunId: 'r',
      lastUpdatedRunId: 'r', metadata: {},
    });
    const checksum = computeProjectionChecksum(state);
    expect(checksum).toMatch(/^sha256:projection-v\d+:[0-9a-f]{64}$/);
    expect(checksum).toContain(`v${PROJECTION_CHECKSUM_VERSION}`);
  });
});
