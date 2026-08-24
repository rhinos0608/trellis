/**
 * Pre-run family resolution — matches an incoming research query against
 * existing family manifests (scopeQuery, scopeSummary, tags) and creates a
 * new Family if no strong match is found.
 *
 * Critical inversion from search-mcp: search-mcp's classifier
 * (families/classifier.ts) runs POST-HOC via solidifyFamilies after a run
 * completes, with a multi-run gating threshold. Here, resolution runs
 * BEFORE a research run starts — for explicit research requests we never
 * gate on passive multi-run accumulation; create immediately on no match.
 *
 * Scoring is pure token-overlap (no LLM, no embeddings) so it runs
 * synchronously at call time. Embedding-based matching can layer on later.
 */

import { randomUUID } from 'node:crypto';
import type { Family, FamilyManifest } from './types.js';

// ── Tokenization ──────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'not', 'so', 'if', 'then', 'that', 'this', 'these', 'those', 'it',
  'its', 'about', 'which', 'who', 'whom', 'what', 'when', 'where', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'only', 'own', 'same', 'than', 'too', 'very',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

// ── Scoring ───────────────────────────────────────────────────────────────

/** Jaccard overlap: |intersection| / |union| of token sets. */
function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Score how well a query matches a family manifest. Combines three signals:
 * 1. Direct scopeQuery overlap with the query (highest weight)
 * 2. Tag overlap with query tokens
 * 3. scopeSummary overlap with query
 *
 * Returns 0–1 where higher is better.
 */
function manifestScore(queryTokens: string[], manifest: FamilyManifest): number {
  const scopeTokens = tokenize(manifest.scopeQuery);
  const scopeScore = tokenOverlap(queryTokens, scopeTokens) * 0.6;

  let tagScore = 0;
  if (manifest.tags && manifest.tags.length > 0) {
    const tagTokens = manifest.tags.flatMap((t) => tokenize(t));
    tagScore = tokenOverlap(queryTokens, tagTokens) * 0.25;
  }

  let summaryScore = 0;
  if (manifest.scopeSummary) {
    const summaryTokens = tokenize(manifest.scopeSummary);
    summaryScore = tokenOverlap(queryTokens, summaryTokens) * 0.15;
  }

  return scopeScore + tagScore + summaryScore;
}

// ── Threshold ─────────────────────────────────────────────────────────────

/** Minimum score to reuse an existing family vs. creating a new one. */
const MATCH_THRESHOLD = 0.25;

// ── Public API ────────────────────────────────────────────────────────────

export interface FamilyResolution {
  family: Family;
  isNew: boolean;
  /** Score of the winning match (0 when creating new). */
  score: number;
  /** Top scored candidates for inspectability, descending. */
  candidates?: { familyId: string; score: number }[];
}

/**
 * Resolve which Family owns an incoming research query.
 *
 * - Scores every existing family's manifest against the query.
 * - If the best score exceeds MATCH_THRESHOLD, reuses that family.
 * - Otherwise creates a new Family (caller emits FAMILY_CREATED event).
 *
 * `now` parameter is for testability; pass `new Date().toISOString()` in
 * production.
 */
export function resolveFamily(
  query: string,
  existingFamilies: Family[],
  opts?: { matchThreshold?: number; now?: string; idGenerator?: () => string },
): FamilyResolution {
  const threshold = opts?.matchThreshold ?? MATCH_THRESHOLD;
  const now = opts?.now ?? new Date().toISOString();
  const generateId = opts?.idGenerator ?? (() => randomUUID());

  const queryTokens = tokenize(query);

  // Score all families and track candidates
  const scored = existingFamilies.map((family) => ({
    family,
    score: manifestScore(queryTokens, family.manifest),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Top 5 for inspectability
  const candidates = scored.slice(0, 5).map(({ family, score }) => ({ familyId: family.id, score }));

  const best = scored[0];
  if (best !== undefined && best.score >= threshold) {
    // Update lastActivity on match
    best.family.lastActivity = now;
    return { family: best.family, isNew: false, score: best.score, candidates };
  }

  // No strong match — create new family
  const id = generateId();
  const family: Family = {
    id,
    label: deriveLabel(query),
    description: query,
    manifest: {
      scopeQuery: query,
      scopeSummary: query,
      tags: queryTokens.slice(0, 10),
    },
    createdAt: now,
    lastActivity: now,
    relatedFamilies: [],
  };

  const result: FamilyResolution = { family, isNew: true, score: 0 };
  if (candidates.length > 0) result.candidates = candidates;
  return result;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Derive a concise label from a query — first 8 meaningful words, title-cased. */
function deriveLabel(query: string): string {
  const words = tokenize(query).slice(0, 8);
  if (words.length === 0) return 'Research Family';
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
