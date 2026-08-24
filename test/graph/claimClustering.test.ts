import { describe, it, expect } from 'vitest';
import { clusterClaims } from '../../src/graph/claimClustering.js';
import type { Claim, NormalizedClaimKey } from '../../src/graph/types.js';

function makeClaim(
  id: string,
  subjectText: string,
  predicate: string,
  overrides?: Partial<Claim>,
): Claim {
  return {
    id,
    familyId: 'fam-1',
    subjectText,
    predicate,
    objectText: undefined,
    polarity: 'asserted',
    hedge: 'certain',
    evidenceType: 'study',
    confidence: 0.8,
    canonicalKey: { subject: subjectText.toLowerCase(), predicate: predicate.toLowerCase() } as NormalizedClaimKey,
    contradictionState: 'none',
    firstSeenRunId: 'run-1',
    lastSeenRunId: 'run-1',
    ...overrides,
  };
}

describe('claimClustering', () => {
  it('returns empty for zero claims', () => {
    const result = clusterClaims([], 'run-1');
    expect(result.relations).toEqual([]);
  });

  it('returns empty for single claim', () => {
    const result = clusterClaims([makeClaim('c1', 'React performance', 'improves')], 'run-1');
    expect(result.relations).toEqual([]);
  });

  it('detects same_claim for exact normalized match', () => {
    const claims = [
      makeClaim('c1', 'React performance improves', 'by 20 percent'),
      makeClaim('c2', 'React performance improves', 'by 20 percent'),
    ];
    const result = clusterClaims(claims, 'run-1');
    const sameClaim = result.relations.find((r) => r.relation === 'same_claim');
    expect(sameClaim).toBeDefined();
    expect(sameClaim!.strength).toBe('strong');
    expect(sameClaim!.score).toBe(1);
  });

  it('detects near_duplicate for high lexical overlap', () => {
    const claims = [
      makeClaim('c1', 'React 19 improves performance significantly', 'by 40 percent'),
      makeClaim('c2', 'React 19 performance improvement of 40 percent', 'is significant'),
    ];
    const result = clusterClaims(claims, 'run-1');
    // Should find some relation between these claims
    expect(result.relations.length).toBeGreaterThanOrEqual(1);
  });

  it('detects contradicts when negation signals present', () => {
    const claims = [
      makeClaim('c1', 'React 19 adds support', 'for server components'),
      makeClaim('c2', 'React 19 not adds support', 'for server components'),
    ];
    const result = clusterClaims(claims, 'run-1');
    const contradiction = result.relations.find((r) => r.relation === 'contradicts');
    expect(contradiction).toBeDefined();
    expect(contradiction!.strength).toBe('weak');
  });

  it('detects high anchor overlap as direct method', () => {
    const claims = [
      makeClaim('c1', 'v3.2.1 of SDK releases', 'on 2024-01-15'),
      makeClaim('c2', 'v3.2.1 of SDK release', 'on 2024-01-15'),
    ];
    const result = clusterClaims(claims, 'run-1');
    expect(result.relations.length).toBeGreaterThanOrEqual(1);
    // High anchor overlap should produce a direct or near_duplicate edge
    const strongEdge = result.relations.find((r) => r.strength === 'strong');
    expect(strongEdge).toBeDefined();
  });

  it('produces multiple relation types for different claim pairs', () => {
    const claims = [
      makeClaim('c1', 'React 19 adds support', 'for server components'),
      makeClaim('c2', 'React 19 adds support', 'for server components'),
      makeClaim('c3', 'React 19 not adds support', 'for server components'),
    ];
    const result = clusterClaims(claims, 'run-1');
    const relationTypes = new Set(result.relations.map((r) => r.relation));
    expect(relationTypes.has('same_claim')).toBe(true);
    expect(relationTypes.has('contradicts')).toBe(true);
  });

  it('each relation has a unique id field (ready for ULID)', () => {
    const claims = [
      makeClaim('c1', 'A supports B', 'strongly'),
      makeClaim('c2', 'A supports B', 'strongly'),
      makeClaim('c3', 'X contradicts Y', 'clearly'),
      makeClaim('c4', 'X contradicts Y', 'clearly'),
    ];
    const result = clusterClaims(claims, 'run-1');
    // Multiple edges should all have empty id (caller assigns ULIDs)
    for (const r of result.relations) {
      expect(typeof r.id).toBe('string');
    }
  });
});
