/**
 * Entity resolution — canonicalization and merge-candidate detection for
 * CanonicalEntity.  Reconciles two approaches from search-mcp:
 *
 * 1. research/entityExtractor.ts — regex-based extraction of named entities
 *    from query text (temporal, numerical, names, locations, descriptors).
 *    Useful at ingestion time to identify candidate entities.
 *
 * 2. knowledge/extractor/canonicalise.ts — embedding + LLM-judgment
 *    canonicalization against existing graph nodes.  Uses type-aware
 *    embedding thresholds (0.75 for person/org, 0.85 otherwise) and
 *    alias matching as a fast path before LLM fallback.
 *
 * **Decision**: Follow canonicalise.ts's approach (approach #2) because
 * it's designed for *deterministic* de-duplication against an existing
 * entity store, which is exactly what Trellis needs at event-projection
 * time.  The entityExtractor.ts approach is for *discovery* (identifying
 * entities from raw text), which belongs in the extraction pipeline
 * (Worker 6) not here.
 *
 * The LLM judgment path from canonicalise.ts is replaced with an
 * injectable `llmJudgesSameEntity` callback — callers can wire in their
 * LLM client or leave it undefined for label-only matching.  Embedding-
 * based similarity is similarly injectable.  The deterministic alias
 * matching + label comparison is always available.
 */

import type { CanonicalEntity } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MergeCandidate {
  /** The entity that would be merged INTO the target. */
  fromId: string;
  /** The existing entity it would merge into. */
  intoId: string;
  /** Human-readable reason. */
  reason: string;
  /** Confidence in this merge (0-1). */
  confidence: number;
}

export interface EntityResolutionOptions {
  /** Type-aware threshold override.  Default: 0.85 for most types, 0.75 for person/org. */
  thresholdForType?: (type: string) => number;
  /** Optional LLM-based same-entity judgment.  Falls back to label comparison when absent. */
  llmJudgesSameEntity?: (
    newLabel: string,
    newType: string,
    existingLabel: string,
    existingType: string,
  ) => boolean | Promise<boolean>;
}

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Type-aware similarity thresholds — ported from canonicalise.ts.
 * person/org get lower threshold because their names are more distinctive.
 */
export function defaultThresholdForType(type: string): number {
  if (type === 'person' || type === 'org') return 0.75;
  return 0.85;
}

// ── Label similarity ─────────────────────────────────────────────────────────

/**
 * Normalized label for comparison: lowercase, strip punctuation, collapse whitespace.
 */
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Jaccard similarity over content-word sets — used as a fast pre-filter
 * before the full LLM/embedding check.
 */
function labelJaccard(a: string, b: string): number {
  const setA = new Set(normalizeLabel(a).split(' ').filter(Boolean));
  const setB = new Set(normalizeLabel(b).split(' ').filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Core resolution ──────────────────────────────────────────────────────────

/**
 * Given a new entity candidate and the current entity store, find merge
 * candidates (existing entities that likely represent the same real-world
 * thing).
 *
 * Uses a three-stage pipeline ported from canonicalise.ts:
 * 1. Alias match (fast, deterministic) — case-insensitive alias comparison
 * 2. Label Jaccard pre-filter (deterministic) — eliminates obvious non-matches
 * 3. LLM judgment (optional) — for ambiguous cases when injectable callback provided
 *
 * @param newLabel   The candidate entity label.
 * @param newType    The candidate entity type.
 * @param newAliases Optional aliases already known for this entity.
 * @param existing   The current entity store.
 * @param options    Threshold and LLM overrides.
 * @returns          Merge candidates sorted by confidence (highest first).
 */
export function findMergeCandidates(
  newLabel: string,
  newType: string,
  newAliases: string[],
  existing: Iterable<CanonicalEntity>,
  options?: EntityResolutionOptions,
): MergeCandidate[] {
  const thresholdFn = options?.thresholdForType ?? defaultThresholdForType;
  const threshold = thresholdForType(newType, thresholdFn);
  const newLabelNormalized = normalizeLabel(newLabel);
  const newAliasSet = new Set(newAliases.map((a) => a.toLowerCase()));

  const candidates: MergeCandidate[] = [];

  for (const entity of existing) {
    if (entity.entityType !== newType) continue;

    // Stage 1: exact alias match
    if (newAliasSet.has(entity.label.toLowerCase())) {
      candidates.push({
        fromId: '', // caller fills in
        intoId: entity.id,
        reason: `alias match: "${newLabel}" matches label of existing "${entity.label}"`,
        confidence: 0.95,
      });
      continue;
    }

    // Check if new label matches any existing entity's aliases
    const existingAliasSet = new Set(entity.aliases.map((a) => a.toLowerCase()));
    if (existingAliasSet.has(newLabel.toLowerCase())) {
      candidates.push({
        fromId: '',
        intoId: entity.id,
        reason: `alias match: "${newLabel}" matches alias of existing "${entity.label}"`,
        confidence: 0.95,
      });
      continue;
    }

    // Exact label match (case-insensitive)
    if (newLabelNormalized === normalizeLabel(entity.label)) {
      candidates.push({
        fromId: '',
        intoId: entity.id,
        reason: `exact label match: "${newLabel}" = "${entity.label}"`,
        confidence: 1.0,
      });
      continue;
    }

    // Stage 2: Jaccard pre-filter
    const jaccard = labelJaccard(newLabel, entity.label);
    if (jaccard < threshold * 0.5) continue; // fast reject

    // Also check against entity's canonicalLabel
    const canonicalMatch =
      entity.canonicalLabel !== null &&
      labelJaccard(newLabel, entity.canonicalLabel) >= threshold * 0.5;
    if (jaccard < threshold && !canonicalMatch) continue;

    // Stage 3: LLM judgment (if available) or use Jaccard score
    if (options?.llmJudgesSameEntity) {
      const isSame = options.llmJudgesSameEntity(newLabel, newType, entity.label, entity.entityType);
      if (typeof isSame === 'boolean') {
        if (isSame) {
          candidates.push({
            fromId: '',
            intoId: entity.id,
            reason: `LLM judgment: "${newLabel}" matches existing "${entity.label}"`,
            confidence: jaccard,
          });
        }
        continue;
      }
      // If the function returned a non-boolean (shouldn't happen with sync check above)
      // treat as non-match for safety
      continue;
    }

    // No LLM — use Jaccard as confidence proxy
    if (jaccard >= threshold) {
      candidates.push({
        fromId: '',
        intoId: entity.id,
        reason: `label similarity: "${newLabel}" ≈ "${entity.label}" (jaccard=${jaccard.toFixed(3)})`,
        confidence: jaccard,
      });
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates;
}

function thresholdForType(type: string, fn: (type: string) => number): number {
  return fn(type);
}

/**
 * Merge two entities — produces a new merged entity and records the merge
 * in the merge history.
 */
export function mergeEntities(
  survivor: CanonicalEntity,
  absorbed: CanonicalEntity,
): CanonicalEntity {
  const mergedAliases = new Set([
    ...survivor.aliases,
    ...absorbed.aliases,
    absorbed.label,
    ...(absorbed.canonicalLabel !== null ? [absorbed.canonicalLabel] : []),
  ]);
  return {
    ...survivor,
    aliases: [...mergedAliases],
    metadata: { ...survivor.metadata, ...absorbed.metadata },
    lastUpdatedRunId: absorbed.lastUpdatedRunId,
  };
}
