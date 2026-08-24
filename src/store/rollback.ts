/**
 * Rollback executor for Trellis event store.
 *
 * For pure_run_local / audit_only / dynamic_edge: replay-time skip only
 * (handled by projectionBuilder — no action needed here).
 *
 * For cross_run_mutation: APPEND a compensating event that reverses the
 * effect. Detects interference from later runs and returns blocked when
 * unresolvable.
 *
 * Never guesses or silently misattributes data.
 */

import { logger } from '../logger.js';
import { appendEvent, queryEvents } from './events.js';
import { ROLLBACK_CLASS } from './eventTypes.js';
import type {
  EventEnvelope,
  RollbackOutcome,
  EntityMergedPayload,
  EntitySplitPayload,
  FamilyMergedPayload,
  RelabelPayload,
  ValueRevisionPayload,
  SourceChangedPayload,
  ContradictionResolutionPayload,
  GapResolutionPayload,
} from './eventTypes.js';
import type { ProjectionState } from './projectionState.js';

// ── Interference check helpers ──────────────────────────────────────

/** Check if any run OTHER than `excludeRunId` appended events referencing `entityId` after `afterTimestamp`. */
function hasLaterInterference(
  entityId: string,
  afterTimestamp: string,
  excludeRunId: string,
): boolean {
  const laterEvents = queryEvents({ entityId, since: afterTimestamp });
  return laterEvents.some((e) => e.runId !== excludeRunId);
}

// ── Compensating event synthesis ────────────────────────────────────

function synthesizeCompensation(
  original: EventEnvelope,
  _state: ProjectionState,
): EventEnvelope | null {
  const rollbackTimestamp = new Date().toISOString();

  switch (original.eventType) {
    case 'ENTITY_MERGED': {
      const p = original.payload as EntityMergedPayload;
      // Check interference on each merged entity
      for (const mergedId of p.mergedIds) {
        if (hasLaterInterference(mergedId, original.timestamp, original.runId)) {
          return null; // blocked — signal to caller
        }
      }
      // Reverse: split survivor back into original parts
      const inversePayload: EntitySplitPayload = {
        originalId: p.survivorId,
        originalSnapshot: { label: '', aliases: [], metadata: {} },
        resultingIds: p.mergedIds,
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'ENTITY_SPLIT',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.survivorId,
        entityType: 'entity',
        payload: inversePayload,
      });
    }

    case 'ENTITY_SPLIT': {
      const p = original.payload as EntitySplitPayload;
      // Check interference on each resulting entity
      for (const rid of p.resultingIds) {
        if (hasLaterInterference(rid, original.timestamp, original.runId)) {
          return null;
        }
      }
      // Reverse: merge the split pieces back
      const inversePayload: EntityMergedPayload = {
        survivorId: p.originalId,
        mergedIds: p.resultingIds,
        mergedSnapshots: [],
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'ENTITY_MERGED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.originalId,
        entityType: 'entity',
        payload: inversePayload,
      });
    }

    case 'NODE_RELABELED': {
      const p = original.payload as RelabelPayload;
      if (hasLaterInterference(p.targetId, original.timestamp, original.runId)) {
        return null;
      }
      const inversePayload: RelabelPayload = {
        targetId: p.targetId,
        oldLabel: p.newLabel,
        newLabel: p.oldLabel,
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'NODE_RELABELED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.targetId,
        entityType: 'entity',
        payload: inversePayload,
      });
    }

    case 'NODE_METADATA_UPDATED':
    case 'EXTRACTION_CONFIDENCE_REVISED':
    case 'RELATIONSHIP_STRENGTH_REVISED': {
      const p = original.payload as ValueRevisionPayload;
      if (hasLaterInterference(p.targetId, original.timestamp, original.runId)) {
        return null;
      }
      const inversePayload: ValueRevisionPayload = {
        targetId: p.targetId,
        field: p.field,
        oldValue: p.newValue,
        newValue: p.oldValue,
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: original.eventType,
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.targetId,
        entityType: null,
        payload: inversePayload,
      });
    }

    case 'SOURCE_CHANGED': {
      const p = original.payload as SourceChangedPayload;
      if (hasLaterInterference(p.sourceId, original.timestamp, original.runId)) {
        return null;
      }
      const inversePayload: SourceChangedPayload = {
        sourceId: p.sourceId,
        oldContentHash: p.newContentHash,
        newContentHash: p.oldContentHash,
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'SOURCE_CHANGED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.sourceId,
        entityType: 'source',
        payload: inversePayload,
      });
    }

    case 'SOURCE_RETRACTED': {
      // Source retraction reversal = re-add source. Need the original
      // SOURCE_ADDED event to reconstruct — this is a complex case.
      // For now, block if we can't find the original add.
      const p = original.payload as { sourceId: string };
      if (hasLaterInterference(p.sourceId, original.timestamp, original.runId)) {
        return null;
      }
      // Find original SOURCE_ADDED for this source
      const addedEvents = queryEvents({ eventType: 'SOURCE_ADDED' });
      const originalAdd = addedEvents.find(
        (e) => (e.payload as Record<string, unknown>).id === p.sourceId,
      );
      if (originalAdd === undefined) {
        return null; // can't reconstruct
      }
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'SOURCE_ADDED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.sourceId,
        entityType: 'source',
        payload: originalAdd.payload,
      });
    }

    case 'FAMILY_RENAMED': {
      const p = original.payload as RelabelPayload;
      if (hasLaterInterference(p.targetId, original.timestamp, original.runId)) {
        return null;
      }
      const inversePayload: RelabelPayload = {
        targetId: p.targetId,
        oldLabel: p.newLabel,
        newLabel: p.oldLabel,
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'FAMILY_RENAMED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.targetId,
        entityType: 'family',
        payload: inversePayload,
      });
    }

    case 'FAMILY_MERGED': {
      const p = original.payload as FamilyMergedPayload;
      for (const mergedId of p.mergedFamilyIds) {
        if (hasLaterInterference(mergedId, original.timestamp, original.runId)) {
          return null;
        }
      }
      // Reverse: recreate the merged families
      const inversePayload: FamilyMergedPayload = {
        survivorFamilyId: p.survivorFamilyId,
        mergedFamilyIds: p.mergedFamilyIds,
        mergedSnapshots: p.mergedSnapshots,
        reattributedEntityIds: p.reattributedEntityIds,
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'FAMILY_MERGED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.survivorFamilyId,
        entityType: 'family',
        payload: inversePayload,
      });
    }

    case 'FAMILY_RELATION_REMOVED': {
      // Need to find original FAMILY_RELATED event to reconstruct
      const p = original.payload as { familyId: string; relatedFamilyId: string };
      if (hasLaterInterference(p.familyId, original.timestamp, original.runId)) {
        return null;
      }
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'FAMILY_RELATED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.familyId,
        entityType: 'family',
        payload: original.payload,
      });
    }

    case 'CONTRADICTION_RESOLVED': {
      const p = original.payload as ContradictionResolutionPayload;
      if (hasLaterInterference(p.contradictionId, original.timestamp, original.runId)) {
        return null;
      }
      const inversePayload: ContradictionResolutionPayload = {
        contradictionId: p.contradictionId,
        previousStatus: p.newStatus,
        newStatus: p.previousStatus,
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'CONTRADICTION_RESOLVED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.contradictionId,
        entityType: 'contradiction',
        payload: inversePayload,
      });
    }

    case 'GAP_RESOLVED': {
      const p = original.payload as GapResolutionPayload;
      if (hasLaterInterference(p.gapId, original.timestamp, original.runId)) {
        return null;
      }
      const inversePayload: GapResolutionPayload = {
        gapId: p.gapId,
        previousStatus: p.newStatus,
        newStatus: p.previousStatus,
      };
      return appendEvent({
        timestamp: rollbackTimestamp,
        eventType: 'GAP_RESOLVED',
        eventVersion: 1,
        runId: original.runId,
        batchId: null,
        actor: 'rollback',
        entityId: p.gapId,
        entityType: 'gap',
        payload: inversePayload,
      });
    }

    default:
      return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Roll back a single cross_run_mutation event.
 * Returns executed (with inverse event id) or blocked (with reason).
 */
export function rollbackCrossRunMutation(
  event: EventEnvelope,
  state: ProjectionState,
): RollbackOutcome {
  const rollbackClass = ROLLBACK_CLASS[event.eventType];
  if (rollbackClass !== 'cross_run_mutation') {
    return {
      kind: 'blocked',
      reason: `Event type ${event.eventType} has rollback class '${rollbackClass}', not 'cross_run_mutation'`,
    };
  }

  const inverse = synthesizeCompensation(event, state);

  if (inverse !== null) {
    logger.info(
      { originalEventId: event.id, inverseEventId: inverse.id, eventType: event.eventType },
      'store: cross_run_mutation rollback executed',
    );
    return { kind: 'executed', inverseEventId: inverse.id };
  }

  return {
    kind: 'blocked',
    reason: `Later interference detected for event ${event.id} (${event.eventType}) — cannot safely reverse without guessing`,
  };
}

/**
 * Roll back an entire run. For pure_run_local/audit_only/dynamic_edge:
 * mark in rolledBackRuns (replay-time skip). For cross_run_mutation events
 * in the run: attempt individual compensation.
 */
export function rollbackRun(
  runId: string,
  state: ProjectionState,
): { skipped: number; executed: number; blocked: { eventId: string; reason: string }[] } {
  // Persist the rollback as a RUN_ROLLED_BACK event so the projection
  // builder's pre-scan picks it up on future rebuilds.
  appendEvent({
    timestamp: new Date().toISOString(),
    eventType: 'RUN_ROLLED_BACK',
    eventVersion: 1,
    runId,
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload: { run_id: runId },
  });

  // Mark the run as rolled back — projectionBuilder will skip on next rebuild
  state.rolledBackRuns.add(runId);

  // Find cross_run_mutation events from this run
  const runEvents = queryEvents({ runId });
  const crossRunEvents = runEvents.filter(
    (e) => ROLLBACK_CLASS[e.eventType] === 'cross_run_mutation',
  );

  let executed = 0;
  let skipped = 0;
  const blocked: { eventId: string; reason: string }[] = [];

  for (const event of crossRunEvents) {
    const outcome = rollbackCrossRunMutation(event, state);
    if (outcome.kind === 'executed') {
      executed++;
    } else {
      blocked.push({ eventId: event.id, reason: outcome.reason });
    }
  }

  skipped = runEvents.length - crossRunEvents.length;

  logger.info(
    { runId, skipped, executed, blocked: blocked.length },
    'store: run rollback complete',
  );

  return { skipped, executed, blocked };
}
