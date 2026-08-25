/**
 * Curation application service — Phase 10 Stage 0.
 *
 * Wraps the five operator curation event types (CLAIM_MERGED, CLAIM_SPLIT,
 * CLAIM_RETRACTION_SET, CLAIM_RELATION_CURATED, EVIDENCE_STANCE_OVERRIDDEN)
 * behind typed commands. Every method:
 *
 *   1. Rebuilds the canonical projection (forceGenesis).
 *   2. Checks command idempotency against `runId = curation:<commandId>` —
 *      a replayed command returns its prior result (`deduplicated: true`)
 *      even though the projection has moved on; a reused commandId with a
 *      different request is rejected.
 *   3. Validates optimistic concurrency: `expectedSeq` must equal
 *      `state.lastAppliedSeq`, otherwise `StaleProjectionError`. Never
 *      auto-retries or replans.
 *   4. Derives ALL before/after snapshots, affected-ID lists, and validation
 *      checks FROM the projection state — callers never fabricate them.
 *   5. Appends exactly ONE event with `actor: 'user'`, `actorId` from input.
 */

import { rebuildProjection } from '../store/projectionBuilder.js';
import { appendEvents, queryEvents } from '../store/events.js';
import type { EventHandlerRegistry, ProjectionState } from '../store/projectionState.js';
import type { CurationContext, CuratedRelationSnapshot, EvidenceStance } from '../store/eventTypes.js';
import type { Claim } from '../graph/types.js';
import {
  StaleProjectionError,
  IdempotencyConflictError,
  CurationConflictError,
  CurationPreconditionError,
} from './errors.js';

export type CurationEventType =
  | 'CLAIM_MERGED'
  | 'CLAIM_SPLIT'
  | 'CLAIM_RETRACTION_SET'
  | 'CLAIM_RELATION_CURATED'
  | 'EVIDENCE_STANCE_OVERRIDDEN';

/** Fields shared by every curation command. */
export interface CurationCommandBase {
  commandId: string;
  actorId: string;
  reason: string;
  /** Optimistic-concurrency expectation: projection `lastAppliedSeq` at decision time. */
  expectedSeq: number;
}

export interface MergeClaimsInput extends CurationCommandBase {
  sourceClaimId: string;
  survivorClaimId: string;
}

export interface SplitClaimResultInput {
  claimId: string;
  currentObservationId: string;
  observationIds: string[];
  evidenceIds: string[];
}

export interface SplitClaimInput extends CurationCommandBase {
  sourceClaimId: string;
  results: SplitClaimResultInput[];
}

export interface SetRetractionInput extends CurationCommandBase {
  target: { kind: 'claim' | 'observation'; id: string };
  retracted: boolean;
  observationIds?: string[];
}

export type CurateRelationInput = CurationCommandBase &
  (
    | { action: 'upsert'; relation: CuratedRelationSnapshot }
    | { action: 'remove'; relationId: string }
  );

export interface OverrideEvidenceStanceInput extends CurationCommandBase {
  evidenceId: string;
  stance: EvidenceStance;
}

export interface CurationResult {
  commandId: string;
  eventId: string;
  seq: number;
  eventType: CurationEventType;
  deduplicated: boolean;
}

export interface CurationAppDeps {
  /** Merged graph+workspace handler registry used for rebuild + append. */
  handlers: EventHandlerRegistry;
}

export interface CurationApplicationService {
  mergeClaims(input: MergeClaimsInput): CurationResult;
  splitClaim(input: SplitClaimInput): CurationResult;
  setRetraction(input: SetRetractionInput): CurationResult;
  curateRelation(input: CurateRelationInput): CurationResult;
  overrideEvidenceStance(input: OverrideEvidenceStanceInput): CurationResult;
}

// ── Internals ────────────────────────────────────────────────────────

const isActive = (claim: Claim): boolean => (claim.curationStatus ?? 'active') === 'active';

function requireClaim(state: ProjectionState, claimId: string): Claim {
  const claim = state.claims.get(claimId);
  if (!claim) throw new CurationPreconditionError(`Claim not found: ${claimId}`, { claimId });
  return claim;
}

/**
 * Shared command pipeline. `matchesStored` decides whether a previously
 * appended event with the same `curation:<commandId>` runId represents the
 * SAME request (dedupe) or a conflicting reuse (reject). Only fields
 * derivable from the INPUT alone may participate — never derived snapshots,
 * which legitimately differ once the original command has been applied.
 */
function commit(
  handlers: EventHandlerRegistry,
  eventType: CurationEventType,
  input: CurationCommandBase,
  matchesStored: (payload: Record<string, unknown>) => boolean,
  prepare: (state: ProjectionState) => Record<string, unknown>,
): CurationResult {
  const runId = `curation:${input.commandId}`;
  const state = rebuildProjection(handlers, { forceGenesis: true });
  const prior = queryEvents({ runId })[0];

  if (prior) {
    const payload = prior.payload as Record<string, unknown>;
    const curation = payload.curation as CurationContext | undefined;
    // actorId is part of command identity (same commandId from a different
    // actor is a conflicting reuse); expectedSeq is NOT — it is a concurrency
    // guard against the projection cursor, not part of the intent.
    if (
      curation?.reason !== input.reason ||
      prior.actorId !== input.actorId ||
      !matchesStored(payload)
    ) {
      // IdempotencyConflictError carries a fixed message by design (research/scheduler).
      throw new IdempotencyConflictError();
    }
    return {
      commandId: input.commandId,
      eventId: prior.id,
      seq: prior.seq,
      eventType: prior.eventType as CurationEventType,
      deduplicated: true,
    };
  }

  if (input.expectedSeq !== state.lastAppliedSeq) {
    throw new StaleProjectionError(input.expectedSeq, state.lastAppliedSeq);
  }

  const curation: CurationContext = {
    commandId: input.commandId,
    reason: input.reason,
    expectedSeq: input.expectedSeq,
  };
  const payload = { ...prepare(state), curation };

  const [envelope] = appendEvents(
    [
      {
        timestamp: new Date().toISOString(),
        eventType,
        eventVersion: 1,
        runId,
        batchId: null,
        actor: 'user',
        actorId: input.actorId,
        entityId: null,
        entityType: null,
        payload,
      },
    ],
    { projection: state, handlers },
  );
  if (!envelope) throw new Error(`appendEvents produced no envelope for command '${input.commandId}'`);

  return { commandId: input.commandId, eventId: envelope.id, seq: envelope.seq, eventType, deduplicated: false };
}

/** Order-insensitive stringify so key insertion order never causes false idempotency conflicts. */
const sortedStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return Object.fromEntries(sorted) as Record<string, unknown>;
    }
    return v;
  });
const jsonEqual = (a: unknown, b: unknown): boolean => sortedStringify(a) === sortedStringify(b);

// ── Service factory ──────────────────────────────────────────────────

export function createCurationApplicationService(deps: CurationAppDeps): CurationApplicationService {
  const { handlers } = deps;

  return {
    mergeClaims(input: MergeClaimsInput): CurationResult {
      return commit(
        handlers,
        'CLAIM_MERGED',
        input,
        (p) =>
          p.sourceClaimId === input.sourceClaimId &&
          p.survivorClaimId === input.survivorClaimId,
        (state) => {
          if (input.sourceClaimId === input.survivorClaimId) {
            throw new CurationConflictError('Cannot merge a claim into itself');
          }
          const source = requireClaim(state, input.sourceClaimId);
          const survivor = requireClaim(state, input.survivorClaimId);
          if ((source.curationStatus ?? 'active') === 'merged') {
            // Another merge was ALREADY applied to this source — a conflict,
            // not a precondition failure.
            throw new CurationConflictError(
              `Source claim was already merged${source.mergedIntoClaimId ? ` into ${source.mergedIntoClaimId}` : ''}: ${source.id}`,
            );
          }
          if (!isActive(source)) {
            throw new CurationPreconditionError(
              `Source claim is not active (${source.curationStatus ?? 'active'}): ${source.id}`,
            );
          }
          if (!isActive(survivor)) {
            throw new CurationPreconditionError(
              `Survivor claim is not active (${survivor.curationStatus ?? 'active'}): ${survivor.id}`,
            );
          }
          if (source.familyId !== survivor.familyId) {
            throw new CurationConflictError(
              `Cross-family merge rejected: ${source.familyId} vs ${survivor.familyId}`,
            );
          }
          return {
            sourceClaimId: source.id,
            survivorClaimId: survivor.id,
            affectedObservationIds: [...(source.observationIds ?? [])],
            affectedEvidenceIds: [...(source.evidenceIds ?? [])],
            affectedRelationIds: [...state.claimRelations.values()]
              .filter((r) => r.fromClaimId === source.id || r.toClaimId === source.id)
              .map((r) => r.id),
            affectedContradictionIds: [...state.contradictions.values()]
              .filter((c) => c.claimIdA === source.id || c.claimIdB === source.id)
              .map((c) => c.id),
            affectedGapIds: [...state.gaps.values()]
              .filter((g) => g.relatedClaimId === source.id)
              .map((g) => g.id),
          };
        },
      );
    },

    splitClaim(input: SplitClaimInput): CurationResult {
      return commit(
        handlers,
        'CLAIM_SPLIT',
        input,
        (p) =>
          p.sourceClaimId === input.sourceClaimId &&
          jsonEqual(p.results, input.results),
        (state) => {
          const source = requireClaim(state, input.sourceClaimId);
          if (!isActive(source)) {
            throw new CurationPreconditionError(
              `Source claim is not active (${source.curationStatus ?? 'active'}): ${source.id}`,
            );
          }
          if (input.results.length < 2) {
            throw new CurationConflictError('Split requires at least 2 results');
          }
          const sourceObservations = new Set(source.observationIds ?? []);
          const sourceEvidence = new Set(source.evidenceIds ?? []);
          const seenObservations = new Set<string>();
          const seenEvidence = new Set<string>();
          for (const result of input.results) {
            if (state.claims.has(result.claimId)) {
              throw new CurationConflictError(`Split result claim already exists: ${result.claimId}`);
            }
            if (!result.observationIds.includes(result.currentObservationId)) {
              throw new CurationConflictError(
                `currentObservationId must be a member of observationIds for ${result.claimId}`,
              );
            }
            for (const id of result.observationIds) {
              if (!sourceObservations.has(id)) {
                throw new CurationConflictError(`Observation ${id} does not belong to ${source.id}`);
              }
              if (seenObservations.has(id)) {
                throw new CurationConflictError(`Observation ${id} appears in multiple split results`);
              }
              seenObservations.add(id);
            }
            for (const id of result.evidenceIds) {
              if (!sourceEvidence.has(id)) {
                throw new CurationConflictError(`Evidence ${id} does not belong to ${source.id}`);
              }
              if (seenEvidence.has(id)) {
                throw new CurationConflictError(`Evidence ${id} appears in multiple split results`);
              }
              seenEvidence.add(id);
            }
          }
          if (seenObservations.size !== sourceObservations.size || seenEvidence.size !== sourceEvidence.size) {
            throw new CurationConflictError(
              'Split partition does not cover every source observation and evidence record exactly once',
            );
          }
          return { sourceClaimId: source.id, results: input.results.map((r) => ({ ...r })) };
        },
      );
    },

    setRetraction(input: SetRetractionInput): CurationResult {
      return commit(
        handlers,
        'CLAIM_RETRACTION_SET',
        input,
        (p) => jsonEqual(p.target, input.target) && jsonEqual(p.newStatus, input.retracted ? 'retracted' : 'active'),
        (state) => {
          let previousStatus: 'active' | 'retracted';
          if (input.target.kind === 'claim') {
            const claim = requireClaim(state, input.target.id);
            const status = claim.curationStatus ?? 'active';
            if (status !== 'active' && status !== 'retracted') {
              throw new CurationPreconditionError(
                `Claim is '${status}' — retraction lifecycle only applies to active/retracted claims`,
              );
            }
            previousStatus = status;
          } else {
            const observation = state.claimObservations.get(input.target.id);
            if (!observation) {
              throw new CurationPreconditionError(`Observation not found: ${input.target.id}`);
            }
            previousStatus = observation.curationStatus ?? 'active';
          }
          const newStatus = input.retracted ? 'retracted' : 'active';
          if (newStatus === previousStatus) {
            throw new CurationConflictError(`Target is already '${newStatus}'`);
          }
          const observationIds = input.target.kind === 'claim'
            ? input.observationIds ?? (newStatus === 'retracted' ? [...(state.claims.get(input.target.id)?.observationIds ?? [])] : [])
            : [];
          return { target: input.target, previousStatus, newStatus, observationIds };
        },
      );
    },

    curateRelation(input: CurateRelationInput): CurationResult {
      const relationId = input.action === 'upsert' ? input.relation.id : input.relationId;
      const requestedAfter = input.action === 'upsert' ? input.relation : null;
      return commit(
        handlers,
        'CLAIM_RELATION_CURATED',
        input,
        (p) => p.relationId === relationId && jsonEqual(p.after, requestedAfter),
        (state) => {
          const current = state.claimRelations.get(relationId);
          if (input.action === 'remove') {
            if (!current) {
              throw new CurationPreconditionError(`Relation not found: ${relationId}`);
            }
            return { relationId, before: { ...current }, after: null };
          }
          const relation = input.relation;
          if (relation.fromClaimId === relation.toClaimId) {
            throw new CurationConflictError('Self-edge rejected');
          }
          const from = requireClaim(state, relation.fromClaimId);
          const to = requireClaim(state, relation.toClaimId);
          if (from.familyId !== to.familyId) {
            throw new CurationConflictError(
              `Cross-family relation rejected: ${from.familyId} vs ${to.familyId}`,
            );
          }
          // Handler enforces exact before/current equality — pass a copy of
          // the live relation so concurrent edits surface as append-time failures.
          return { relationId: relation.id, before: current ? { ...current } : null, after: { ...relation } };
        },
      );
    },

    overrideEvidenceStance(input: OverrideEvidenceStanceInput): CurationResult {
      return commit(
        handlers,
        'EVIDENCE_STANCE_OVERRIDDEN',
        input,
        (p) => p.evidenceId === input.evidenceId && jsonEqual(p.newStance, input.stance),
        (state) => {
          const evidence = state.evidence.get(input.evidenceId);
          if (!evidence) {
            throw new CurationPreconditionError(`Evidence not found: ${input.evidenceId}`);
          }
          return {
            evidenceId: evidence.id,
            claimId: evidence.claimId,
            previousStance: evidence.stance ?? null,
            newStance: input.stance,
          };
        },
      );
    },
  };
}
