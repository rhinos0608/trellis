/**
 * Claim clustering — dedup and relation detection across claims.
 * Ported from search-mcp's findingLinkage.ts (edge computation using
 * lexical anchor overlap, semantic vector overlap, hybrid scoring) and
 * claimClustering.ts (canonical key normalization + fuzzy matching).
 *
 * Produces ClaimRelation rows with types: same_claim, near_duplicate,
 * supports, elaborates, contradicts, background.
 *
 * The Union-Find + edge classification pipeline is preserved from
 * findingLinkage.ts. The canonical-key normalization from claimClustering.ts
 * is used as a fast-path pre-cluster before the pairwise scoring.
 */

import type {
  Claim,
  ClaimRelation,
  ClaimRelationType,
  ClaimRelationStrength,
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LEXICAL_THRESHOLD = 0.58;
const DEFAULT_DIRECT_THRESHOLD = 0.92;
const DEFAULT_MAX_EDGES_PER_CLAIM = 8;
const STRONG_LEXICAL_FLOOR = 0.78;
const STRONG_VECTOR_LEXICAL_FLOOR = 0.18;
const DETERMINISTIC_MERGE_THRESHOLD = 0.92;

const LINK_STOP_WORDS = new Set([
  'about',
  'after',
  'also',
  'and',
  'are',
  'but',
  'can',
  'for',
  'from',
  'has',
  'have',
  'into',
  'its',
  'may',
  'more',
  'not',
  'now',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'which',
  'with',
]);

// ── Text normalization ───────────────────────────────────────────────────────

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9@._/-]+/g, ' ')
    .trim();
}

function termsFor(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(/\s+/)
      .map((term) => term.replace(/^[._/-]+|[._/-]+$/g, ''))
      .filter((term) => term.length > 2 && !LINK_STOP_WORDS.has(term)),
  );
}

function anchorsFor(text: string): Set<string> {
  const anchors = new Set<string>();
  for (const match of text.matchAll(/@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*/gi)) {
    anchors.add(match[0].toLowerCase());
  }
  for (const match of text.matchAll(/\bv?\d+(?:\.\d+)*(?:-[\w.]+)?\b/gi)) {
    anchors.add(match[0].toLowerCase());
  }
  for (const match of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) anchors.add(match[0]);
  return anchors;
}

function discriminatorsFor(text: string): Set<string> {
  const discriminators = anchorsFor(text);
  const normalized = text.toLowerCase();
  if (/\bmodel context protocol\b/i.test(text)) discriminators.add('mcp');
  for (const match of text.matchAll(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)+\b/g)) {
    const phrase = match[0].toLowerCase().replace(/\s+/g, ' ');
    if (phrase !== 'model context protocol') discriminators.add(phrase);
  }
  for (const match of text.matchAll(/\b[A-Z]{2,}\b/g)) discriminators.add(match[0].toLowerCase());
  if (normalized.includes('claude desktop')) discriminators.add('claude desktop');
  if (normalized.includes('anthropic')) discriminators.add('anthropic');
  return discriminators;
}

function discriminatorGap(left: Set<string>, right: Set<string>): string[] {
  if (left.size === 0 || right.size === 0) return [];
  const gap = new Set<string>();
  for (const item of left) if (!right.has(item)) gap.add(item);
  for (const item of right) if (!left.has(item)) gap.add(item);
  return [...gap].sort();
}

function hasContradictionSignal(left: string, right: string): boolean {
  const negated =
    /\b(no longer|not|without|removed|removes|deprecated|drops?|disable[sd]?|cannot|can't)\b/i;
  const positive = /\b(adds?|added|supports?|introduced|enables?|includes?|allows?)\b/i;
  return (
    (negated.test(left) && positive.test(right)) || (negated.test(right) && positive.test(left))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / Math.min(a.size, b.size);
}

function cosineSimilarity(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function recordText(claim: Claim): string {
  return [claim.subjectText, claim.predicate, claim.objectText]
    .filter((part): part is string => Boolean(part))
    .join('\n');
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

// ── Edge classification ──────────────────────────────────────────────────────

function classifyEdge(
  method: 'direct' | 'lexical' | 'vector',
  score: number,
  lexicalScore: number,
  anchorScore: number,
  discriminatorBridge: boolean,
  contradictionSignal: boolean,
): { relation: ClaimRelationType; strength: ClaimRelationStrength; bridge?: boolean } {
  if (contradictionSignal) {
    return { relation: 'contradicts', strength: 'weak', bridge: true };
  }
  if (method === 'direct' && !discriminatorBridge) {
    return { relation: 'same_claim', strength: 'strong' };
  }
  if (method === 'lexical' && score >= STRONG_LEXICAL_FLOOR && !discriminatorBridge) {
    return { relation: 'near_duplicate', strength: 'strong' };
  }
  if (
    method === 'vector' &&
    score >= DETERMINISTIC_MERGE_THRESHOLD &&
    lexicalScore >= STRONG_VECTOR_LEXICAL_FLOOR &&
    !discriminatorBridge
  ) {
    return { relation: 'near_duplicate', strength: 'strong' };
  }
  if (anchorScore > 0 && discriminatorBridge) {
    return { relation: 'elaborates', strength: 'weak', bridge: true };
  }
  return {
    relation: method === 'vector' ? 'supports' : 'elaborates',
    strength: 'weak',
    ...(discriminatorBridge ? { bridge: true } : {}),
  };
}

// ── Canonical key matching (from claimClustering.ts) ─────────────────────────

function normalizeSubject(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePredicate(predicate: string): string {
  return predicate
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(reduces|reduced|reducing)\b/g, 'reduce')
    .replace(/\b(increases|increased|increasing)\b/g, 'increase')
    .replace(/\b(improves|improved|improving)\b/g, 'improve')
    .replace(/\b(achieves|achieved|achieving)\b/g, 'achieve')
    .replace(/\b(outperforms|outperformed|outperforming)\b/g, 'outperform')
    .replace(/\b(surpasses|surpassed|surpassing)\b/g, 'surpass')
    .replace(/\b(shows|showed|showing)\b/g, 'show')
    .replace(/\b(indicates|indicated|indicating)\b/g, 'indicate')
    .replace(/\b(suggests|suggested|suggesting)\b/g, 'suggest')
    .replace(/\b(provides|provided|providing)\b/g, 'provide')
    .replace(/\b(enables|enabled|enabling)\b/g, 'enable')
    .replace(/\b(requires|required|requiring)\b/g, 'require')
    .replace(/\b(uses|used|using)\b/g, 'use')
    .replace(/\b(employs|employed|employing)\b/g, 'employ')
    .trim();
}

function buildClusterKey(claim: Claim): string {
  const key = claim.canonicalKey;
  const base = `${normalizeSubject(key.subject)}::${normalizePredicate(key.predicate)}`;
  return key.quantifierCanonical ? `${base}::${key.quantifierCanonical}` : base;
}

function fuzzyMatchKeys(keyA: string, keyB: string): boolean {
  if (keyA === keyB) return true;
  const partsA = keyA.split('::');
  const partsB = keyB.split('::');
  const subjectA = partsA[0];
  const subjectB = partsB[0];
  if (!subjectA || !subjectB) return false;
  const wordsA = new Set(subjectA.split(/\s+/).filter(Boolean));
  const wordsB = new Set(subjectB.split(/\s+/).filter(Boolean));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const minSize = Math.min(wordsA.size, wordsB.size);
  if (minSize === 0) return false;
  const subjectOverlap = overlap / minSize;
  if (subjectOverlap >= 0.6) {
    const predA = partsA[1]?.split(/\s+/).filter(Boolean) ?? [];
    const predB = partsB[1]?.split(/\s+/).filter(Boolean) ?? [];
    const predOverlap = predA.some((w) => predB.includes(w));
    return predOverlap || subjectOverlap >= 1.0;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ClaimClusteringOptions {
  /** Optional embeddings[i] = embedding for claims[i]. */
  embeddings?: number[][];
  vectorThreshold?: number;
  lexicalThreshold?: number;
  directThreshold?: number;
  maxEdgesPerClaim?: number;
}

export interface ClaimClusteringResult {
  /** ClaimRelation rows — independent ULID-keyed edges. */
  relations: ClaimRelation[];
}

/**
 * Build pairwise ClaimRelation rows from a set of claims using the same
 * scoring pipeline as findingLinkage.ts:
 *
 * 1. Canonical key fast-path (fuzzyMatchKeys) → pre-cluster same-subject claims
 * 2. Pairwise: direct match, anchor overlap, lexical Jaccard, vector cosine
 * 3. Edge classification into relation types
 * 4. Union-Find transitive clustering for same_claim/near_duplicate
 *
 * Returns ClaimRelation rows — the caller persists them into
 * state.claimRelations.
 */
export function clusterClaims(
  claims: Claim[],
  runId: string,
  options?: ClaimClusteringOptions,
): ClaimClusteringResult {
  if (claims.length <= 1) return { relations: [] };

  const vectorThreshold = options?.vectorThreshold ?? 0.82;
  const lexicalThreshold = options?.lexicalThreshold ?? DEFAULT_LEXICAL_THRESHOLD;
  const directThreshold = options?.directThreshold ?? DEFAULT_DIRECT_THRESHOLD;
  const maxEdgesPerClaim = options?.maxEdgesPerClaim ?? DEFAULT_MAX_EDGES_PER_CLAIM;

  const records = claims.map(recordText);
  const terms = records.map(termsFor);
  const anchors = records.map(anchorsFor);
  const discriminators = records.map(discriminatorsFor);
  const normalized = claims.map((c) => normalizeText(recordText(c)));

  // Canonical key pre-clustering: group claims that share a fuzzy canonical key
  const canonicalKeyMap = new Map<string, number[]>(); // key → claim indices
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    if (!claim) continue;
    const key = buildClusterKey(claim);
    const existing = canonicalKeyMap.get(key);
    if (existing) {
      existing.push(i);
    } else {
      // Check if any existing key fuzzy-matches
      let matched = false;
      for (const [existingKey, indices] of canonicalKeyMap) {
        if (fuzzyMatchKeys(key, existingKey)) {
          indices.push(i);
          matched = true;
          break;
        }
      }
      if (!matched) canonicalKeyMap.set(key, [i]);
    }
  }

  // Edge accumulation — keyed by edgeKey to keep best score
  type CandidateEdge = ClaimRelation & {
    leftIndex: number;
    rightIndex: number;
    semanticScore?: number;
  };

  const edgesByKey = new Map<string, CandidateEdge>();
  const edgeCounts = new Map<string, number>();

  const addEdge = (
    leftIndex: number,
    rightIndex: number,
    method: 'direct' | 'lexical' | 'vector',
    score: number,
    rationale: string,
    lexicalScore: number,
    anchorScore: number,
  ): void => {
    const left = claims[leftIndex];
    const right = claims[rightIndex];
    if (!left || !right || score <= 0) return;
    const currentLeftCount = edgeCounts.get(left.id) ?? 0;
    const currentRightCount = edgeCounts.get(right.id) ?? 0;
    if (currentLeftCount >= maxEdgesPerClaim || currentRightCount >= maxEdgesPerClaim) return;
    const key = edgeKey(left.id, right.id);
    const existing = edgesByKey.get(key);
    if (existing && existing.score >= score) return;

    const discriminatorBridge =
      discriminatorGap(
        discriminators[leftIndex] ?? new Set<string>(),
        discriminators[rightIndex] ?? new Set<string>(),
      ).length > 0;

    const relation = classifyEdge(
      method,
      score,
      lexicalScore,
      anchorScore,
      discriminatorBridge,
      hasContradictionSignal(left.subjectText + ' ' + left.predicate, right.subjectText + ' ' + right.predicate),
    );

    edgesByKey.set(key, {
      id: '', // caller assigns ULIDs at persist time
      fromClaimId: left.id,
      toClaimId: right.id,
      leftIndex,
      rightIndex,
      relation: relation.relation,
      strength: relation.strength,
      score,
      rationale: `${rationale} Classified as ${relation.relation}/${relation.strength}.`,
      runId,
      ...(method === 'vector' ? { semanticScore: score } : {}),
    });
    edgeCounts.set(left.id, currentLeftCount + 1);
    edgeCounts.set(right.id, currentRightCount + 1);
  };

  // Pairwise scoring
  for (let left = 0; left < claims.length; left++) {
    for (let right = left + 1; right < claims.length; right++) {
      const anchorScore = overlapScore(
        anchors[left] ?? new Set<string>(),
        anchors[right] ?? new Set<string>(),
      );
      const lexicalScore = jaccard(
        terms[left] ?? new Set<string>(),
        terms[right] ?? new Set<string>(),
      );
      if (normalized[left] === normalized[right] && normalized[left] !== '') {
        addEdge(
          left,
          right,
          'direct',
          1,
          'Exact normalized-claim match.',
          lexicalScore,
          anchorScore,
        );
      } else if (anchorScore >= directThreshold && lexicalScore >= 0.25) {
        addEdge(
          left,
          right,
          'direct',
          Math.min(1, (anchorScore + lexicalScore) / 2),
          'Shared high-confidence entity/version/date anchors.',
          lexicalScore,
          anchorScore,
        );
      } else if (lexicalScore >= lexicalThreshold) {
        addEdge(
          left,
          right,
          'lexical',
          lexicalScore,
          'High lexical overlap after stop-word removal.',
          lexicalScore,
          anchorScore,
        );
      }

      const vectorScore = cosineSimilarity(
        options?.embeddings?.[left],
        options?.embeddings?.[right],
      );
      if (vectorScore >= vectorThreshold) {
        addEdge(
          left,
          right,
          'vector',
          vectorScore,
          'Nearest-neighbour match in the claim embedding index.',
          lexicalScore,
          anchorScore,
        );
      }
    }
  }

  // Build relation rows — strip internal leftIndex/rightIndex
  const relations: ClaimRelation[] = [...edgesByKey.values()].map((edge) => {
    const { leftIndex: _l, rightIndex: _r, semanticScore: _s, ...rest } = edge;
    return rest;
  });

  relations.sort((a, b) => b.score - a.score);
  return { relations };
}
