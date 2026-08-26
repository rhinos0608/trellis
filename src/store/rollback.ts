/**
 * Rollback executor for Trellis event store.
 *
 * For pure_run_local / audit_only / dynamic_edge: replay-time skip only
 * (handled by projectionBuilder — no action needed here).
 *
 * For cross_run_mutation: APPEND compensating events that reverse the
 * original mutation. Detects interference from later runs and returns
 * blocked when unresolvable.
 *
 * Never guesses or silently misattributes data.
 *
 * ## Known limitations
 *
 * - ENTITY_MERGED compensation recreates the merged-away entities with their
 *   pre-merge label/aliases/metadata but does NOT strip the survivor's
 *   accumulated aliases/metadata (the survivor's pre-merge snapshot is never
 *   stored in the forward payload).
 *
 * - FAMILY_MERGED compensation recreates the merged-away families as new
 *   FAMILY_CREATED records but does NOT automatically reattribute entities or
 *   threads back to those families (that requires a FAMILY_CLASSIFIED event
 *   per entity, which the simple flat reattributedEntityIds payload cannot
 *   disambiguate for the multi-family case).
 */

import { logger } from '../logger.js';
import { appendEvents, queryEvents } from './events.js';
import type { NewEventInput } from './events.js';
import { getKnowledgeReadModelStatus } from './readModel/integrity.js';
import { rebuildKnowledgeReadModel } from './readModel/rebuild.js';
import { rebuildProjection } from './projectionBuilder.js';
import { ROLLBACK_CLASS } from './eventTypes.js';
import { CurationRollbackBlockedError } from './eventErrors.js';
import type {
  EventEnvelope,
  TrellisEventType,
  RollbackOutcome,
  EntityMergedPayload,
  EntitySplitPayload,
  EntityMergeSnapshot,
  FamilyMergedPayload,
  FamilyMergeSnapshot,
  RelabelPayload,
  ValueRevisionPayload,
  SourceChangedPayload,
  ContradictionResolutionPayload,
  GapResolutionPayload,
} from './eventTypes.js';
import type { ProjectionState } from './projectionState.js';
import type { AppendContext } from './events.js';

// ── Curation event types — rollback BLOCKED per Phase 9 ─────────────
const CURATION_EVENT_TYPES: ReadonlySet<TrellisEventType> = new Set([
  'CLAIM_MERGED',
  'CLAIM_SPLIT',
  'CLAIM_RETRACTION_SET',
  'CLAIM_RELATION_CURATED',
  'EVIDENCE_STANCE_OVERRIDDEN',
]);

// ── Interference check helpers ──────────────────────────────────────

/** Check if any run OTHER than `excludeRunId` appended events referencing `entityId` after `afterSeq`. */
function hasLaterInterference(
  entityId: string,
  afterSeq: number,
  excludeRunId: string,
): boolean {
  const laterEvents = queryEvents({ entityId, afterSeq });
  return laterEvents.some((e) => e.runId !== excludeRunId);
}

// ── Compensating event synthesis ────────────────────────────────────

/**
 * Pure function: compute compensation event inputs for a cross_run_mutation event.
 * Returns NewEventInput[] on success, null when later interference makes safe reversal impossible.
 * Does NOT append any events — caller batches them atomically.
 */
function buildCompensationInputs(
  original: EventEnvelope,
  state: ProjectionState,
  rollbackTimestamp: string,
): NewEventInput[] | null {

  switch (original.eventType) {
    case 'ENTITY_MERGED': {
      const p = original.payload as EntityMergedPayload;
      // Interference check: survivor + every merged entity.
      // If any of them was touched by a later run, compensation is unsafe.
      if (hasLaterInterference(p.survivorId, original.seq, original.runId)) {
        return null;
      }
      for (const mergedId of p.mergedIds) {
        if (hasLaterInterference(mergedId, original.seq, original.runId)) {
          return null;
        }
      }

      // Build EntitySplitPayload: recreate the merged-away entities using
      // the real snapshots from the forward event (these carry pre-merge
      // label/aliases/metadata for each merged entity).
      const restoredSnapshots: EntityMergeSnapshot[] = p.mergedSnapshots.map(
        (snap) => ({
          id: snap.id,
          label: snap.label,
          aliases: [...snap.aliases],
          metadata: { ...snap.metadata },
          claimIds: [...snap.claimIds],
          evidenceIds: [...snap.evidenceIds],
        }),
      );

      // Survivor snapshot: the survivor's current state in the projection
      // includes accumulated aliases/metadata from the merge — we record
      // that so the EntitySplit handler at least knows what it was working
      // with, even though we cannot perfectly restore the pre-merge survivor.
      const survivorEntity = state.entities.get(p.survivorId);
      const originalSnapshot = survivorEntity
        ? {
            label: survivorEntity.label,
            aliases: [...survivorEntity.aliases],
            metadata: { ...survivorEntity.metadata },
          }
        : { label: '', aliases: [], metadata: {} };

      const inversePayload: EntitySplitPayload = {
        originalId: p.survivorId,
        originalSnapshot,
        resultingIds: [...p.mergedIds],
        restoredSnapshots,
      };

      return [{
        timestamp: rollbackTimestamp,
        eventType: 'ENTITY_SPLIT',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.survivorId,
        entityType: 'entity',
        payload: inversePayload,
      }];
    }

    case 'ENTITY_SPLIT': {
      const p = original.payload as EntitySplitPayload;
      // Interference check: original entity + every resulting entity.
      if (hasLaterInterference(p.originalId, original.seq, original.runId)) {
        return null;
      }
      for (const rid of p.resultingIds) {
        if (hasLaterInterference(rid, original.seq, original.runId)) {
          return null;
        }
      }

      // Build mergedSnapshots for the compensating ENTITY_MERGED event.
      // Prefer restoredSnapshots (carry full per-entity data) when present;
      // fall back to live projection state for the current label/aliases/metadata.
      const mergedSnapshots: EntityMergeSnapshot[] = p.restoredSnapshots
        ? p.restoredSnapshots.map((snap) => ({
            id: snap.id,
            label: snap.label,
            aliases: [...snap.aliases],
            metadata: { ...snap.metadata },
            claimIds: [...snap.claimIds],
            evidenceIds: [...snap.evidenceIds],
          }))
        : p.resultingIds.map((rid) => {
            const entity = state.entities.get(rid);
            return {
              id: rid,
              label: entity?.label ?? '',
              aliases: entity ? [...entity.aliases] : [],
              metadata: entity ? { ...entity.metadata } : {},
              claimIds: [] as string[],
              evidenceIds: [] as string[],
            };
          });

      const inversePayload: EntityMergedPayload = {
        survivorId: p.originalId,
        mergedIds: [...p.resultingIds],
        mergedSnapshots,
      };

      return [{
        timestamp: rollbackTimestamp,
        eventType: 'ENTITY_MERGED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.originalId,
        entityType: 'entity',
        payload: inversePayload,
      }];
    }

    case 'NODE_RELABELED': {
      const p = original.payload as RelabelPayload;
      if (hasLaterInterference(p.targetId, original.seq, original.runId)) {
        return null;
      }
      const inversePayload: RelabelPayload = {
        targetId: p.targetId,
        oldLabel: p.newLabel,
        newLabel: p.oldLabel,
      };
      return [{
        timestamp: rollbackTimestamp,
        eventType: 'NODE_RELABELED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.targetId,
        entityType: 'entity',
        payload: inversePayload,
      }];
    }

    case 'NODE_METADATA_UPDATED':
    case 'EXTRACTION_CONFIDENCE_REVISED':
    case 'RELATIONSHIP_STRENGTH_REVISED': {
      const p = original.payload as ValueRevisionPayload;
      if (hasLaterInterference(p.targetId, original.seq, original.runId)) {
        return null;
      }
      const inversePayload: ValueRevisionPayload = {
        targetId: p.targetId,
        field: p.field,
        oldValue: p.newValue,
        newValue: p.oldValue,
      };
      return [{
        timestamp: rollbackTimestamp,
        eventType: original.eventType,
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.targetId,
        entityType: null,
        payload: inversePayload,
      }];
    }

    case 'SOURCE_CHANGED': {
      const p = original.payload as SourceChangedPayload;
      if (hasLaterInterference(p.sourceId, original.seq, original.runId)) {
        return null;
      }
      const inversePayload: SourceChangedPayload = {
        sourceId: p.sourceId,
        oldContentHash: p.newContentHash,
        newContentHash: p.oldContentHash,
      };
      return [{
        timestamp: rollbackTimestamp,
        eventType: 'SOURCE_CHANGED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.sourceId,
        entityType: 'source',
        payload: inversePayload,
      }];
    }

    case 'SOURCE_RETRACTED': {
      // Source retraction reversal = re-add source from original SOURCE_ADDED.
      const p = original.payload as { sourceId: string };
      if (hasLaterInterference(p.sourceId, original.seq, original.runId)) {
        return null;
      }
      const addedEvents = queryEvents({ eventType: 'SOURCE_ADDED' });
      const originalAdd = addedEvents.find(
        (e) => (e.payload as Record<string, unknown>).id === p.sourceId,
      );
      if (originalAdd === undefined) {
        return null; // can't reconstruct
      }
      return [{
        timestamp: rollbackTimestamp,
        eventType: 'SOURCE_ADDED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.sourceId,
        entityType: 'source',
        payload: originalAdd.payload,
      }];
    }

    case 'FAMILY_RENAMED': {
      const p = original.payload as RelabelPayload;
      if (hasLaterInterference(p.targetId, original.seq, original.runId)) {
        return null;
      }
      const inversePayload: RelabelPayload = {
        targetId: p.targetId,
        oldLabel: p.newLabel,
        newLabel: p.oldLabel,
      };
      return [{
        timestamp: rollbackTimestamp,
        eventType: 'FAMILY_RENAMED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.targetId,
        entityType: 'family',
        payload: inversePayload,
      }];
    }

    case 'FAMILY_MERGED': {
      const p = original.payload as FamilyMergedPayload;
      // Interference check: survivor + every merged family.
      if (hasLaterInterference(p.survivorFamilyId, original.seq, original.runId)) {
        return null;
      }
      for (const mergedId of p.mergedFamilyIds) {
        if (hasLaterInterference(mergedId, original.seq, original.runId)) {
          return null;
        }
      }

      // Recreate each merged-away family as a FAMILY_CREATED event.
      // Using FamilyCreatedPayload shape (snake_case family_id) matching
      // workspace/projectionHandlers.ts's handleFamilyCreated.
      const compensationInputs: NewEventInput[] = [];
      const snapshots: FamilyMergeSnapshot[] = p.mergedSnapshots;
      for (const mergedId of p.mergedFamilyIds) {
        const snap = snapshots.find((s) => s.id === mergedId);
        compensationInputs.push({
          timestamp: rollbackTimestamp,
          eventType: 'FAMILY_CREATED',
          eventVersion: 1,
          runId: original.runId,
          batchId: null,
          actor: 'rollback',
          entityId: mergedId,
          entityType: 'family',
          payload: {
            family_id: mergedId,
            label: snap?.label ?? mergedId,
            description: snap?.description,
          },
        });
      }
      return compensationInputs.length > 0 ? compensationInputs : null;
    }

    case 'FAMILY_RELATION_REMOVED': {
      const p = original.payload as { family_a: string; family_b: string; relation_type: string; relation_id?: string; reason?: string };
      if (hasLaterInterference(p.family_a, original.seq, original.runId)) {
        return null;
      }
      if (hasLaterInterference(p.family_b, original.seq, original.runId)) {
        return null;
      }
      const compensatingPayload = {
        relation_id: p.relation_id ?? `rollback-${original.id}`,
        family_a: p.family_a,
        family_b: p.family_b,
        relation_type: p.relation_type,
        ...(p.reason !== undefined ? { reason: p.reason } : {}),
      };
      return [{
        timestamp: rollbackTimestamp,
        eventType: 'FAMILY_RELATED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.family_a,
        entityType: 'family',
        payload: compensatingPayload,
      }];
    }

    case 'CONTRADICTION_RESOLVED': {
      const p = original.payload as ContradictionResolutionPayload;
      if (hasLaterInterference(p.contradictionId, original.seq, original.runId)) {
        return null;
      }
      const inversePayload: ContradictionResolutionPayload = {
        contradictionId: p.contradictionId,
        previousStatus: p.newStatus,
        newStatus: p.previousStatus,
      };
      return [{
        timestamp: rollbackTimestamp,
        eventType: 'CONTRADICTION_RESOLVED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.contradictionId,
        entityType: 'contradiction',
        payload: inversePayload,
      }];
    }

    case 'GAP_RESOLVED': {
      const p = original.payload as GapResolutionPayload;
      if (hasLaterInterference(p.gapId, original.seq, original.runId)) {
        return null;
      }
      const inversePayload: GapResolutionPayload = {
        gapId: p.gapId,
        previousStatus: p.newStatus,
        newStatus: p.previousStatus,
      };
      return [{
        timestamp: rollbackTimestamp,
        eventType: 'GAP_RESOLVED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.gapId,
        entityType: 'gap',
        payload: inversePayload,
      }];
    }

    default:
      return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Roll back a single cross_run_mutation event.
 * Returns executed (with representative inverse event id) or blocked (with reason).
 */
export function rollbackCrossRunMutation(
  event: EventEnvelope,
  state: ProjectionState,
  context: AppendContext,
): RollbackOutcome {
  const rollbackClass = ROLLBACK_CLASS[event.eventType];
  if (rollbackClass !== 'cross_run_mutation') {
    return {
      kind: 'blocked',
      reason: `Event type ${event.eventType} has rollback class '${rollbackClass}', not 'cross_run_mutation'`,
    };
  }

  const rollbackTimestamp = new Date().toISOString();
  const inputs = buildCompensationInputs(event, state, rollbackTimestamp);

  if (inputs === null || inputs.length === 0) {
    return {
      kind: 'blocked',
      reason: `Later interference detected for event ${event.id} (${event.eventType}) — cannot safely reverse without guessing`,
    };
  }

  // Batch-append all compensation events.
  const envelopes = appendEvents(inputs, context);
  const first = envelopes[0];
  if (!first) {
    return {
      kind: 'blocked',
      reason: `Failed to append compensation events for ${event.id} (${event.eventType})`,
    };
  }

  logger.info(
    {
      originalEventId: event.id,
      eventType: event.eventType,
      inverseCount: envelopes.length,
      representativeInverseId: first.id,
    },
    'store: cross_run_mutation rollback executed',
  );
  return { kind: 'executed', inverseEventId: first.id };
}

/**
 * Roll back an entire run. For pure_run_local/audit_only/dynamic_edge:
 * mark in rolledBackRuns (replay-time skip). For cross_run_mutation events
 * in the run: attempt individual compensation.
 *
 * Atomic: marker + all compensating events commit in a single transaction,
 * or none do. Curation streams are rejected before any event append.
 *
 * Idempotent: if the run was already rolled back (RUN_ROLLED_BACK event
 * exists), returns the previous outcome without reprocessing.
 */
export function rollbackRun(
  runId: string,
  state: ProjectionState,
  context: AppendContext,
): { skipped: number; executed: number; blocked: { eventId: string; reason: string }[]; readModelRebuilt: boolean; readModelError?: string } {
  // Idempotency: if already rolled back, skip.
  if (state.rolledBackRuns.has(runId)) {
    logger.info({ runId }, 'store: run already rolled back — skipping');
    return { skipped: 0, executed: 0, blocked: [], readModelRebuilt: getKnowledgeReadModelStatus().status === 'ready' };
  }

  // PREFLIGHT: reject curation streams before any mutations begin.
  // Curation events (Phase 9) are BLOCKED from rollback, not silently mislabeled.
  const runEvents = queryEvents({ runId });
  const hasCurationEvents = runEvents.some((e) => CURATION_EVENT_TYPES.has(e.eventType));
  if (hasCurationEvents) {
    throw new CurationRollbackBlockedError(runId);
  }

  // Find cross_run_mutation events from this run
  const crossRunEvents = runEvents.filter(
    (e) => ROLLBACK_CLASS[e.eventType] === 'cross_run_mutation',
  );

  // Build all compensation inputs (pure data, no appends).
  const rollbackTimestamp = new Date().toISOString();
  const compensationInputs: NewEventInput[] = [];
  const blocked: { eventId: string; reason: string }[] = [];

  for (const event of crossRunEvents) {
    const inputs = buildCompensationInputs(event, state, rollbackTimestamp);
    if (inputs === null) {
      blocked.push({ eventId: event.id, reason: 'Later interference detected — cannot safely reverse without guessing' });
    } else {
      compensationInputs.push(...inputs);
    }
  }

  // If ANY cross_run_mutation compensation is blocked, abort the entire rollback
  // (no marker, no partial compensations — atomic all-or-nothing).
  if (blocked.length > 0) {
    logger.warn(
      { runId, blocked: blocked.length },
      'store: rollback aborted — some compensations blocked by interference',
    );
    return {
      skipped: runEvents.length - crossRunEvents.length,
      executed: 0,
      blocked,
      readModelRebuilt: getKnowledgeReadModelStatus().status === 'ready',
    };
  }

  // Build marker event.
  const markerEvent: NewEventInput = {
    timestamp: rollbackTimestamp,
    eventType: 'RUN_ROLLED_BACK',
    eventVersion: 1,
    runId,
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload: { run_id: runId },
  };

  // Atomic batch: marker + all compensations commit together.
  const allInputs: NewEventInput[] = [markerEvent, ...compensationInputs];
  appendEvents(allInputs, context);

  // Mark the run as rolled back — projectionBuilder will skip on next rebuild
  state.rolledBackRuns.add(runId);

  const executed = crossRunEvents.length;
  const skipped = runEvents.length - crossRunEvents.length;

  // Event-log rollback is already committed. Rebuild is best effort so a
  // read-model failure cannot report successful rollback as failed.
  let readModelRebuilt = true;
  let readModelError: string | undefined;
  try {
    rebuildKnowledgeReadModel(context.handlers);
    // Keep caller's hot projection aligned with rebuilt read model.
    Object.assign(state, rebuildProjection(context.handlers, { forceGenesis: true }));
  } catch (err) {
    readModelRebuilt = false;
    readModelError = err instanceof Error ? err.message : String(err);
    logger.error({ err, runId, readModelRebuilt, readModelError }, 'store: rollback committed but read-model rebuild failed');
  }

  logger.info(
    { runId, skipped, executed, blocked: blocked.length, readModelRebuilt, ...(readModelError === undefined ? {} : { readModelError }) },
    'store: run rollback complete',
  );

  return { skipped, executed, blocked, readModelRebuilt, ...(readModelError === undefined ? {} : { readModelError }) };
}
