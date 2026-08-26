/**
 * Finding linkage — cluster similar findings and compute inter-finding edges.
 * Simplified from search-mcp's findingLinkage.ts — no embedding dependency,
 * uses lexical similarity only (ufficient for the core pipeline).
 */

import { randomUUID } from 'node:crypto';
import type {
  Finding,
  FindingCluster,
  FindingClusterEdge,
  FindingClusterRelation,
  FindingClusterEdgeStrength,
} from './internalTypes.js';
import { hasNegationWord } from './state.js';

const DEFAULT_LEXICAL_THRESHOLD = 0.58;
const DEFAULT_DIRECT_THRESHOLD = 0.92;
const DEFAULT_MAX_EDGES_PER_FINDING = 8;

/** Two findings with opposite polarity must not share a cluster. */
function samePolarity(a: Finding, b: Finding): boolean {
  // Prefer structured polarity from GroundedFinding assertion, fall back to text-based detection
  const aPolarity = 'assertion' in a ? (a as unknown as { assertion: { polarity?: string } }).assertion.polarity : undefined;
  const bPolarity = 'assertion' in b ? (b as unknown as { assertion: { polarity?: string } }).assertion.polarity : undefined;
  if (aPolarity !== undefined && bPolarity !== undefined) {
    return aPolarity === bPolarity;
  }
  return hasNegationWord(a.claim) === hasNegationWord(b.claim);
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(
    a.toLowerCase().split(/\s+/).filter((w) => w.length > 0),
  );
  const setB = new Set(
    b.toLowerCase().split(/\s+/).filter((w) => w.length > 0),
  );
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface CandidateEdge {
  id: string;
  fromClusterId: string;
  toClusterId: string;
  relation: FindingClusterRelation;
  strength: FindingClusterEdgeStrength;
  score: number;
}

class UnionFind {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(x: number): number {
    const parentX = this.parent[x];
    if (parentX !== undefined && parentX !== x) {
      this.parent[x] = this.find(parentX);
    }
    return this.parent[x] ?? x;
  }
  union(x: number, y: number): void {
    const px = this.find(x);
    const py = this.find(y);
    if (px !== py) this.parent[px] = py;
  }
}

export interface FindingLinkageResult {
  clusters: FindingCluster[];
  edges: FindingClusterEdge[];
}

/**
 * Build finding clusters and inter-finding edges using lexical similarity.
 */
export function buildFindingLinkage(
  findings: Finding[],
  options?: {
    lexicalThreshold?: number;
    directThreshold?: number;
    maxEdgesPerFinding?: number;
  },
): FindingLinkageResult {
  const lexicalThreshold = options?.lexicalThreshold ?? DEFAULT_LEXICAL_THRESHOLD;
  const directThreshold = options?.directThreshold ?? DEFAULT_DIRECT_THRESHOLD;
  const maxEdges = options?.maxEdgesPerFinding ?? DEFAULT_MAX_EDGES_PER_FINDING;

  if (findings.length === 0) {
    return { clusters: [], edges: [] };
  }

  // Cluster findings by near-duplicate (Union-Find)
  const uf = new UnionFind(findings.length);
  const candidateEdges: CandidateEdge[] = [];

  for (let i = 0; i < findings.length; i++) {
    const fi = findings[i];
    if (fi === undefined) continue;
    for (let j = i + 1; j < findings.length; j++) {
      const fj = findings[j];
      if (fj === undefined) continue;
      const sim = jaccardSimilarity(fi.normalizedClaim, fj.normalizedClaim);

      if (sim >= directThreshold) {
        if (samePolarity(fi, fj)) {
          uf.union(i, j);
          candidateEdges.push({
            id: randomUUID().slice(0, 12),
            fromClusterId: '', // filled below
            toClusterId: '',
            relation: 'same_claim',
            strength: 'strong',
            score: sim,
          });
        } else {
          // Opposite polarity: do not cluster — record as contradiction
          candidateEdges.push({
            id: randomUUID().slice(0, 12),
            fromClusterId: '',
            toClusterId: '',
            relation: 'contradicts',
            strength: 'strong',
            score: sim,
          });
        }
      } else if (sim >= lexicalThreshold) {
        candidateEdges.push({
          id: randomUUID().slice(0, 12),
          fromClusterId: '',
          toClusterId: '',
          relation: 'supports',
          strength: sim >= 0.75 ? 'strong' : 'weak',
          score: sim,
        });
      }
    }
  }

  // Build clusters from Union-Find
  const clusterMap = new Map<number, number[]>(); // root -> [indices]
  for (let i = 0; i < findings.length; i++) {
    const root = uf.find(i);
    const arr = clusterMap.get(root) ?? [];
    arr.push(i);
    clusterMap.set(root, arr);
  }

  const clusters: FindingCluster[] = [];
  const indexToClusterId = new Map<number, string>();
  let clusterIdx = 0;

  for (const indices of clusterMap.values()) {
    const clusterId = `cl-${String(clusterIdx++)}`;
    const clusterFindings = indices
      .map((i) => findings[i])
      .filter((f): f is Finding => f !== undefined);
    const allSourceIds = clusterFindings.flatMap((f) => f.sourceIds);

    // Use the finding with highest confidence as cluster normalized claim
    const best =
      clusterFindings.reduce((a, b) =>
        (a.confidence ?? 0) >= (b.confidence ?? 0) ? a : b,
      );

    clusters.push({
      id: clusterId,
      findingIds: clusterFindings.map((f) => f.id),
      normalizedClaim: best.normalizedClaim,
      sourceCount: new Set(allSourceIds).size,
    });

    for (const i of indices) {
      indexToClusterId.set(i, clusterId);
    }
  }

  // Build inter-cluster edges from cluster pairs
  const edges: FindingClusterEdge[] = [];
  const seenPairs = new Set<string>();

  // Build inter-cluster edges from cluster pairs
  for (let i = 0; i < findings.length; i++) {
    const ci = indexToClusterId.get(i);
    if (ci === undefined) continue;
    for (let j = i + 1; j < findings.length; j++) {
      const cj = indexToClusterId.get(j);
      if (cj === undefined || ci === cj) continue;
      const fi = findings[i];
      const fj = findings[j];
      if (fi === undefined || fj === undefined) continue;
      const sim = jaccardSimilarity(fi.normalizedClaim, fj.normalizedClaim);
      if (sim < lexicalThreshold) continue;

      const pairKey = [ci, cj].sort().join('::');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      let relation: FindingClusterRelation =
        sim >= directThreshold ? 'same_claim' : 'supports';
      if (!samePolarity(fi, fj)) relation = 'contradicts';

      edges.push({
        id: randomUUID().slice(0, 12),
        fromClusterId: ci,
        toClusterId: cj,
        relation,
        strength: sim >= 0.75 ? 'strong' : 'weak',
        score: sim,
      });
    }
  }

  // Cap edges per cluster
  const cappedEdges: FindingClusterEdge[] = [];
  const edgeCountByCluster = new Map<string, number>();
  for (const edge of edges) {
    const fromCount = edgeCountByCluster.get(edge.fromClusterId) ?? 0;
    const toCount = edgeCountByCluster.get(edge.toClusterId) ?? 0;
    if (fromCount < maxEdges && toCount < maxEdges) {
      cappedEdges.push(edge);
      edgeCountByCluster.set(edge.fromClusterId, fromCount + 1);
      edgeCountByCluster.set(edge.toClusterId, toCount + 1);
    }
  }

  return { clusters, edges: cappedEdges };
}

/**
 * Build a map from finding ID to cluster ID.
 */
export function clusterIdByFindingId(
  clusters: FindingCluster[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const cluster of clusters) {
    for (const fid of cluster.findingIds) {
      map.set(fid, cluster.id);
    }
  }
  return map;
}
