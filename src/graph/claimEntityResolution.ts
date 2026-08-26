/**
 * Entity resolution for claim observations — resolves subject/object text
 * to canonical entity IDs, reusing existing entities or minting new ones.
 *
 * Uses findMergeCandidates from entityResolution.ts with an ambiguity
 * guard (same numeric pattern as workspace/familyResolver.ts) to prefer
 * creating new entities over uncertain reuse when candidates are near-tied.
 */

import { randomUUID } from 'node:crypto';
import type { CanonicalEntity, ClaimObservation } from './types.js';
import type { ProjectionState } from '../store/projectionState.js';
import {
  findMergeCandidates,
  type EntityResolutionOptions,
} from './entityResolution.js';

// ── Event types ────────────────────────────────────────────────────────────

interface NewEventInput {
  eventType: string;
  eventVersion: number;
  runId: string;
  payload: Record<string, unknown>;
}

// ── Ambiguity guard constants ──────────────────────────────────────────────
// Same values as workspace/familyResolver.ts for cross-module consistency,
// but defined locally — no shared constants file for two numbers.

const AMBIGUITY_MIN_GAP = 0.10;
const AMBIGUITY_CONFIDENT_SCORE = 0.50;

// ── Resolution ─────────────────────────────────────────────────────────────

interface ResolveOptions {
  now?: string;
  runId: string;
  idGen?: () => string;
  llmJudgesSameEntity?: EntityResolutionOptions['llmJudgesSameEntity'];
}

export interface ResolveClaimEntitiesResult {
  subjectEntityId?: string;
  objectEntityId?: string;
  entityEvents: NewEventInput[];
}

/**
 * Resolve one claim observation's subject/object text to canonical entity IDs.
 *
 * For each text, finds merge candidates among existing entities. If a single
 * confident candidate is found, reuses its ID (no event emitted). If no
 * confident candidate is found, mints a new entity and emits a NODE_ADDED
 * event. Ambiguous near-tied candidates fall through to new-entity creation.
 */
export function resolveClaimEntities(
  observation: ClaimObservation,
  state: ProjectionState,
  opts: ResolveOptions,
): ResolveClaimEntitiesResult {
  const generateId = opts.idGen ?? (() => randomUUID());
  const entityEvents: NewEventInput[] = [];

  const resolveText = (
    text: string | undefined,
  ): string | undefined => {
    if (!text || text.trim().length === 0) return undefined;

    const entityOpts: EntityResolutionOptions = {};
    if (opts.llmJudgesSameEntity) entityOpts.llmJudgesSameEntity = opts.llmJudgesSameEntity;
    const candidates = findMergeCandidates(
      text,
      'concept',
      [],
      state.entities.values(),
      entityOpts,
    );

    if (candidates.length === 0) return mintEntity(text);
    if (candidates.length === 1) {
      const first = candidates[0];
      if (first === undefined) return mintEntity(text);
      return first.intoId;
    }

    // Multiple candidates — apply ambiguity guard
    const best = candidates[0];
    const second = candidates[1];
    if (best === undefined || second === undefined) return mintEntity(text);
    const gap = best.confidence - second.confidence;

    if (gap < AMBIGUITY_MIN_GAP && best.confidence < AMBIGUITY_CONFIDENT_SCORE) {
      // Ambiguity guard: candidates are near-tied and below confident threshold.
      // Try the LLM judge to break the tie when available.
      if (opts.llmJudgesSameEntity) {
        try {
          const bestEntity = state.entities.get(best.intoId);
          if (bestEntity) {
            const judgment = opts.llmJudgesSameEntity(
              text, 'concept', bestEntity.label, bestEntity.entityType,
            );
            // Only trust synchronous boolean results; Promises are unsafe in sync context.
            if (judgment === true) return best.intoId;
          }
        } catch {
          // LLM threw — fail-safe: mint new entity.
        }
      }
      return mintEntity(text);
    }

    return best.intoId;
  };

  const mintEntity = (label: string): string => {
    const id = `entity_${generateId()}`;
    const entity: CanonicalEntity = {
      id,
      label,
      canonicalLabel: null,
      entityType: 'concept',
      aliases: [],
      extractionConfidence: null,
      firstSeenRunId: opts.runId,
      lastUpdatedRunId: opts.runId,
      metadata: {},
    };
    entityEvents.push({
      eventType: 'NODE_ADDED',
      eventVersion: 1,
      runId: opts.runId,
      payload: {
        id: entity.id,
        label: entity.label,
        canonicalLabel: entity.canonicalLabel,
        entityType: entity.entityType,
        aliases: entity.aliases,
        extractionConfidence: entity.extractionConfidence,
        firstSeenRunId: entity.firstSeenRunId,
        lastUpdatedRunId: entity.lastUpdatedRunId,
        metadata: entity.metadata,
      },
    });
    return id;
  };

  const subjectEntityId = resolveText(observation.subjectText);

  // ponytail: object-entity resolution removed — arbitrary objectText
  // ("revenue grew 20%", "the 2024 report") should not mint spurious
  // concept entities. Re-enable only when extraction pipeline supplies
  // an explicit pre-typed object entity candidate.

  const result: ResolveClaimEntitiesResult = { entityEvents };
  if (subjectEntityId !== undefined) result.subjectEntityId = subjectEntityId;
  // objectEntityId left absent: no automatic resolution for object text.
  return result;
}
