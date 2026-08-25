/**
 * Projection builder — replays the append-only event store through a
 * handler registry to produce a ProjectionState. Does NOT hardcode any
 * domain handlers — those come from the registry passed in.
 *
 * Rollback-skip logic ported from search-mcp's isEventSkippedByRollback.
 */

import { logger } from '../logger.js';
import { queryEvents, queryStoredRows, countEvents, getLatestEventCursor, hashPayload, rowToEnvelope } from './events.js';
import { decodeEventPayload, validateEventReferences, validateProjectionReferences } from './eventValidation.js';
import { createCheckpoint, getLatestCompatibleCheckpoint, computeProjectionChecksum, CURRENT_PROJECTION_VERSION } from './checkpoints.js';
import { ROLLBACK_CLASS } from './eventTypes.js';
import type { TrellisEventType } from './eventTypes.js';
import type { EventEnvelope } from './eventTypes.js';
import {
  createEmptyProjectionState,
  serializeProjectionState,
  deserializeProjectionState,
} from './projectionState.js';
import type { ProjectionState, EventHandlerRegistry } from './projectionState.js';

// ── Audit-only events (never project, just logged) ──────────────────
// Derived from ROLLBACK_CLASS so there is a single source of truth.
// Previously a parallel hardcoded set drifted: THREAD_RESOLVED was
// audit_only here but pure_run_local in ROLLBACK_CLASS, causing
// handleThreadResolved to be dead code.
const AUDIT_ONLY_EVENTS: ReadonlySet<TrellisEventType> = new Set(
  (Object.entries(ROLLBACK_CLASS) as [TrellisEventType, string][])
    .filter(([, cls]) => cls === 'audit_only')
    .map(([type]) => type),
);

// ── Rollback skip logic ─────────────────────────────────────────────

/**
 * Port of search-mcp's isEventSkippedByRollback. For dynamic_edge,
 * checks whether the edge referenced was added by the same rolled-back run.
 */
function isEventSkippedByRollback(
  event: EventEnvelope,
  state: ProjectionState,
): boolean {
  if (AUDIT_ONLY_EVENTS.has(event.eventType)) return true;

  const rollbackClass = ROLLBACK_CLASS[event.eventType];
  if (!state.rolledBackRuns.has(event.runId)) return false;

  if (rollbackClass === 'pure_run_local') return true;
  if (rollbackClass === 'audit_only') return true;

  // dynamic_edge: skip only if the edge was added by this same rolled-back run
  if (rollbackClass === 'dynamic_edge') {
    const payload = event.payload as Record<string, unknown>;
    // EDGE_REMOVED payload uses `edgeId` (camelCase);
    // EDGE_ADDED payload is a ClaimRelation with field `id`.
    const edgeId = (payload.edgeId ?? payload.id) as string | undefined;
    if (edgeId !== undefined) {
      const existingEdge = state.claimRelations.get(edgeId);
      if (existingEdge?.runId === event.runId) {
        return true;
      }
    }
    return false;
  }

  // cross_run_mutation: never skipped on replay
  return false;
}

// ── Rebuild result ──────────────────────────────────────────────────

export interface ProjectionRebuildResult {
  rebuiltAt: string;
  eventsProcessed: number;
  durationMs: number;
  fromGenesis: boolean;
  checksum?: string;
}

// ── Main rebuild function ───────────────────────────────────────────

/**
 * Collect the full set of runIds that have been rolled back across all history.
 * Very cheap — only scans RUN_ROLLED_BACK events (indexed by event_type).
 */
function collectRolledBackRuns(): Set<string> {
  const rolledBackRuns = new Set<string>();
  const rollbackEvents = queryEvents({ eventType: 'RUN_ROLLED_BACK' });
  for (const event of rollbackEvents) {
    const payload = event.payload as Record<string, unknown>;
    const runId = payload.run_id as string | undefined;
    if (runId !== undefined) {
      rolledBackRuns.add(runId);
    }
  }
  return rolledBackRuns;
}

/**
 * Check if a checkpoint is stale due to a rollback that occurred before its cursor.
 * A checkpoint is stale if any run in `currentRolledBackRuns` that is NOT in
 * `checkpointRolledBackRunIds` has events with id <= checkpoint.eventCursor,
 * because those events are already baked into the snapshot.
 */
function isCheckpointStale(
  currentRolledBackRuns: Set<string>,
  checkpointRolledBackRunIds: string[] | undefined,
  checkpointCursor: number,
): boolean {
  const checkpointRollbackSet = new Set(checkpointRolledBackRunIds ?? []);
  for (const runId of currentRolledBackRuns) {
    if (checkpointRollbackSet.has(runId)) continue;
    // This run was rolled back AFTER the checkpoint — check if its events
    // are before/at the cursor (meaning they're baked into the snapshot).
    const runEvents = queryEvents({ runId });
    const firstEvent = runEvents[0];
    if (firstEvent !== undefined && firstEvent.seq <= checkpointCursor) {
      return true;
    }
  }
  return false;
}

/**
 * Replay events through handler dispatch. Shared by genesis and incremental paths.
 */
function replayEvents(
  events: EventEnvelope[],
  handlers: EventHandlerRegistry,
  validationState: ProjectionState,
  projectionState: ProjectionState,
): void {
  for (const event of events) {
    const decoded = decodeEventPayload(event.eventType, event.eventVersion, event.payload);
    // Handlers mutate domain objects. Give validation and materialized replay
    // independent payload graphs so one pass cannot mutate the other pass.
    const validationEvent = { ...event, payload: structuredClone(decoded.payload) };
    const decodedEvent = { ...event, payload: structuredClone(decoded.payload) };

    // Validate against complete historical state, including events later skipped by rollback.
    validateEventReferences(event.eventType, validationEvent.payload, validationState);
    const validationHandler = handlers[event.eventType];
    if (validationHandler !== undefined) validationHandler(validationEvent, validationState);
    validationState.lastAppliedSeq = event.seq;

    // Materialized projection preserves existing rollback skip semantics.
    if (AUDIT_ONLY_EVENTS.has(event.eventType)) {
      projectionState.lastAppliedSeq = event.seq;
      continue;
    }
    if (isEventSkippedByRollback(event, projectionState)) {
      projectionState.lastAppliedSeq = event.seq;
      continue;
    }
    const handler = handlers[event.eventType];
    if (handler !== undefined) handler(decodedEvent, projectionState);
    projectionState.lastAppliedSeq = event.seq;
  }
}

/**
 * Replay all events in seq order through the provided handler
 * registry. Returns the fully materialized ProjectionState.
 *
 * Uses checkpoints for incremental rebuilds when available and not stale.
 * Falls back to full genesis replay when checkpoints are missing or stale.
 */
export function rebuildProjection(
  handlers: EventHandlerRegistry,
  // writeCheckpoint: false = checkpoint-free replay for read-only consumers
  // (verify/doctor) — the replay result is compared in memory, never persisted.
  options: { forceGenesis?: boolean; writeCheckpoint?: boolean } = {},
): ProjectionState {
  const startTime = Date.now();

  // Step 1: collect full rolled-back runs (cheap — indexed query)
  const fullRolledBackRuns = collectRolledBackRuns();

  // Step 2: try to find a compatible checkpoint
  const checkpoint = options.forceGenesis ? null : getLatestCompatibleCheckpoint(CURRENT_PROJECTION_VERSION);

  let state: ProjectionState;
  let validationState: ProjectionState;
  let eventsProcessed: number;

  if (checkpoint?.snapshotJson !== undefined && checkpoint.snapshotJson !== '' &&
      checkpoint.rolledBackRunIds !== undefined && !isCheckpointStale(
        fullRolledBackRuns,
        checkpoint.rolledBackRunIds,
        checkpoint.eventCursor,
      )) {
    // ── Incremental path ──
    state = deserializeProjectionState(checkpoint.snapshotJson);
    state.rolledBackRuns = fullRolledBackRuns;
    validationState = deserializeProjectionState(checkpoint.snapshotJson);
    validationState.rolledBackRuns = fullRolledBackRuns;

    const storedDelta = queryStoredRows({ afterSeq: checkpoint.eventCursor });
    for (const [i, row] of storedDelta.entries()) {
      if (hashPayload(row.payload) !== row.payload_hash) throw new Error(`Payload hash mismatch at seq ${String(row.seq)}`);
      if (i > 0 && i % 10_000 === 0) logger.info({ checked: i, total: storedDelta.length }, 'store: hash validation progress (incremental)');
    }
    state.lastAppliedSeq = checkpoint.eventCursor;
    validationState.lastAppliedSeq = checkpoint.eventCursor;
    const deltaEvents = storedDelta.map(rowToEnvelope);
    replayEvents(deltaEvents, handlers, validationState, state);
    eventsProcessed = deltaEvents.length;

    logger.info(
      {
        path: 'incremental',
        checkpointCursor: checkpoint.eventCursor,
        deltaEvents: deltaEvents.length,
        durationMs: Date.now() - startTime,
      },
      'store: rebuilding projection',
    );
  } else {
    // ── Genesis path ──
    state = createEmptyProjectionState();
    state.rolledBackRuns = fullRolledBackRuns;
    validationState = createEmptyProjectionState();
    validationState.rolledBackRuns = fullRolledBackRuns;

    const stored = queryStoredRows();
    for (const [i, row] of stored.entries()) {
      if (hashPayload(row.payload) !== row.payload_hash) throw new Error(`Payload hash mismatch at seq ${String(row.seq)}`);
      if (i > 0 && i % 10_000 === 0) logger.info({ checked: i, total: stored.length }, 'store: hash validation progress (genesis)');
    }
    const allEvents = stored.map(rowToEnvelope);
    replayEvents(allEvents, handlers, validationState, state);
    eventsProcessed = allEvents.length;

    logger.info(
      {
        path: checkpoint !== null ? 'stale-fallback' : 'genesis',
        eventCount: allEvents.length,
        durationMs: Date.now() - startTime,
      },
      'store: rebuilding projection',
    );
  }

  validateProjectionReferences(state);
  const durationMs = Date.now() - startTime;

  logger.info(
    {
      eventsProcessed,
      durationMs,
      entityCount: state.entities.size,
      claimCount: state.claims.size,
      familyCount: state.families.size,
    },
    'store: projection rebuild complete',
  );

  // Write checkpoint (best-effort) — skipped when writeCheckpoint is false
  // so read-only verification never persists a snapshot.
  if (options.writeCheckpoint !== false) {
    const lastCursor = getLatestEventCursor();
    if (lastCursor !== null) {
      const checksum = computeProjectionChecksum(state);
      const snapshotJson = serializeProjectionState(state);
      const rolledBackRunIds = [...fullRolledBackRuns];
      createCheckpoint(lastCursor, countEvents(), checksum, snapshotJson, rolledBackRunIds);
    }
  }

  return state;
}

export { AUDIT_ONLY_EVENTS, isEventSkippedByRollback };
