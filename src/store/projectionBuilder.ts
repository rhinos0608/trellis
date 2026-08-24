/**
 * Projection builder — replays the append-only event store through a
 * handler registry to produce a ProjectionState. Does NOT hardcode any
 * domain handlers — those come from the registry passed in.
 *
 * Rollback-skip logic ported from search-mcp's isEventSkippedByRollback.
 */

import { logger } from '../logger.js';
import { queryEvents, countEvents } from './events.js';
import { createCheckpoint, computeProjectionChecksum } from './checkpoints.js';
import { ROLLBACK_CLASS } from './eventTypes.js';
import type { TrellisEventType } from './eventTypes.js';
import type { EventEnvelope } from './eventTypes.js';
import {
  createEmptyProjectionState,
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
 * Replay all events in timestamp order through the provided handler
 * registry. Returns the fully materialized ProjectionState.
 *
 * This does NOT touch DB projection tables — Trellis keeps projections
 * in memory (ProjectionState maps). Checkpoints are saved for
 * potential future incremental optimization.
 */
export function rebuildProjection(
  handlers: EventHandlerRegistry,
): ProjectionState {
  const startTime = Date.now();
  const state = createEmptyProjectionState();

  const events = queryEvents({});

  logger.info(
    { eventCount: events.length },
    'store: rebuilding projection',
  );

  if (events.length === 0) {
    logger.info('store: projection rebuild complete (empty)');
    return state;
  }

  // Pre-scan for RUN_ROLLED_BACK events to populate rolledBackRuns
  // Must happen before main loop since RUN_ROLLED_BACK is audit_only.
  for (const event of events) {
    if (event.eventType === 'RUN_ROLLED_BACK') {
      const payload = event.payload as Record<string, unknown>;
      const runId = payload.run_id as string | undefined;
      if (runId !== undefined) {
        state.rolledBackRuns.add(runId);
      }
    }
  }

  // Replay events
  for (const event of events) {
    // Skip audit-only events
    if (AUDIT_ONLY_EVENTS.has(event.eventType)) continue;

    // Check rollback status
    if (isEventSkippedByRollback(event, state)) continue;

    // Dispatch to handler if one is registered
    const handler = handlers[event.eventType];
    if (handler !== undefined) {
      handler(event, state);
    }
    // No warning for unregistered types — domain workers register their own.
  }

  const durationMs = Date.now() - startTime;

  logger.info(
    {
      eventsProcessed: events.length,
      durationMs,
      entityCount: state.entities.size,
      claimCount: state.claims.size,
      familyCount: state.families.size,
    },
    'store: projection rebuild complete',
  );

  // Create checkpoint for future incremental rebuilds
  const lastEvent = events.at(-1);
  if (lastEvent !== undefined) {
    const checksum = computeProjectionChecksum(state);
    createCheckpoint(lastEvent.id, countEvents(), checksum);
  }

  return state;
}

export { AUDIT_ONLY_EVENTS, isEventSkippedByRollback };
