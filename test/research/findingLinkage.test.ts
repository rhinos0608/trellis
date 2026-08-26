import { describe, it, expect } from 'vitest';
import { buildFindingLinkage, clusterIdByFindingId } from '../../src/research/findingLinkage.js';
import type { Finding } from '../../src/research/internalTypes.js';

function makeFinding(
  id: string,
  claim: string,
  overrides?: Partial<Finding>,
): Finding {
  return {
    id,
    claim,
    normalizedClaim: claim.toLowerCase(),
    evidenceDirectness: 'secondary',
    claimType: 'secondary',
    sourceIds: [],
    subQuestionIds: [],
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

describe('buildFindingLinkage', () => {
  it('returns empty for zero findings', () => {
    const result = buildFindingLinkage([]);
    expect(result.clusters).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('returns single cluster for one finding', () => {
    const result = buildFindingLinkage([makeFinding('f1', 'React is fast')]);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.findingIds).toEqual(['f1']);
  });

  it('clusters near-duplicate findings (above directThreshold)', () => {
    const f1 = makeFinding('f1', 'React is fast and performant for web apps');
    const f2 = makeFinding('f2', 'React is fast and performant for web apps');
    const result = buildFindingLinkage([f1, f2], { directThreshold: 0.9 });
    // Same normalized claim => jaccard = 1.0 => directThreshold met => union
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.findingIds).toContain('f1');
    expect(result.clusters[0]!.findingIds).toContain('f2');
  });

  it('separates dissimilar findings into different clusters', () => {
    const f1 = makeFinding('f1', 'React is fast and performant');
    const f2 = makeFinding('f2', 'Python is used for data science');
    const result = buildFindingLinkage([f1, f2], {
      lexicalThreshold: 0.9,
      directThreshold: 0.95,
    });
    expect(result.clusters).toHaveLength(2);
  });

  it('builds supports edges between moderately similar findings in different clusters', () => {
    const f1 = makeFinding('f1', 'react is very fast for web applications');
    const f2 = makeFinding('f2', 'react is very fast for building apps');
    const result = buildFindingLinkage([f1, f2], {
      lexicalThreshold: 0.3,
      directThreshold: 0.95,
    });
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    // If they ended up in different clusters, there should be a supports edge
    if (result.clusters.length === 2) {
      expect(result.edges.length).toBeGreaterThanOrEqual(1);
      expect(result.edges[0]!.relation).toBe('supports');
    }
  });

  it('caps edges per finding via maxEdgesPerFinding', () => {
    // Create many findings that are all moderately similar to each other
    const findings = Array.from({ length: 10 }, (_, i) =>
      makeFinding(`f${i}`, `React is good for performance testing ${i}`),
    );
    const result = buildFindingLinkage(findings, {
      lexicalThreshold: 0.2,
      directThreshold: 0.99,
      maxEdgesPerFinding: 2,
    });
    // Each cluster should have at most 2 edges
    const edgeCountByCluster = new Map<string, number>();
    for (const e of result.edges) {
      edgeCountByCluster.set(e.fromClusterId, (edgeCountByCluster.get(e.fromClusterId) ?? 0) + 1);
      edgeCountByCluster.set(e.toClusterId, (edgeCountByCluster.get(e.toClusterId) ?? 0) + 1);
    }
    for (const count of edgeCountByCluster.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it('uses highest confidence finding as cluster normalized claim', () => {
    const f1 = makeFinding('f1', 'react is fast', { confidence: 0.3 });
    const f2 = makeFinding('f2', 'react is fast', { confidence: 0.9 });
    const result = buildFindingLinkage([f1, f2], { directThreshold: 0.5 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.normalizedClaim).toBe('react is fast');
  });

  it('sourceCount deduplicates source IDs across findings in a cluster', () => {
    const f1 = makeFinding('f1', 'react is fast', { sourceIds: ['s1', 's2'] });
    const f2 = makeFinding('f2', 'react is fast', { sourceIds: ['s2', 's3'] });
    const result = buildFindingLinkage([f1, f2], { directThreshold: 0.5 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]!.sourceCount).toBe(3); // s1, s2, s3
  });

  it('edges have unique string ids', () => {
    const f1 = makeFinding('f1', 'React is fast');
    const f2 = makeFinding('f2', 'React performance is great');
    const result = buildFindingLinkage([f1, f2], {
      lexicalThreshold: 0.1,
      directThreshold: 0.99,
    });
    const ids = result.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('clusterIdByFindingId', () => {
  it('maps each finding id to its cluster id', () => {
    const f1 = makeFinding('f1', 'react is fast');
    const f2 = makeFinding('f2', 'react is fast');
    const f3 = makeFinding('f3', 'vue is great');
    const result = buildFindingLinkage([f1, f2, f3], { directThreshold: 0.5 });
    const map = clusterIdByFindingId(result.clusters);
    expect(map.get('f1')).toBe(map.get('f2'));
    expect(map.get('f3')).not.toBe(map.get('f1'));
  });

  it('returns empty map for empty clusters', () => {
    const map = clusterIdByFindingId([]);
    expect(map.size).toBe(0);
  });
});

describe('polarity guard — opposite polarity not clustered', () => {
  it('does not merge findings with differing negation into the same cluster', () => {
    const f1 = makeFinding('f1', 'React is fast');
    const f2 = makeFinding('f2', 'React is not fast');
    const result = buildFindingLinkage([f1, f2], { directThreshold: 0.5 });
    // jaccard(react is fast, react is not fast) ≈ 0.75 → directThreshold met,
    // but negation differs → must NOT share a cluster
    expect(result.clusters).toHaveLength(2);
    // Edge should be contradicts, not same_claim
    const contradictionEdges = result.edges.filter((e) => e.relation === 'contradicts');
    expect(contradictionEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('still clusters non-negated findings together', () => {
    const f1 = makeFinding('f1', 'React is fast');
    const f2 = makeFinding('f2', 'React is fast');
    const result = buildFindingLinkage([f1, f2], { directThreshold: 0.5 });
    // Same polarity (both non-negated) — should be merged into one cluster
    expect(result.clusters).toHaveLength(1);
  });

  it('clusters negated findings together when both contain negation words', () => {
    const f1 = makeFinding('f1', 'React is not slow');
    const f2 = makeFinding('f2', 'React is not slow');
    const result = buildFindingLinkage([f1, f2], { directThreshold: 0.5 });
    // Both negated — same polarity → merged into one cluster
    expect(result.clusters).toHaveLength(1);
  });
});
