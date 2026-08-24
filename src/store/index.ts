// Event store + projections + checkpoints + rollback
export { initDb, getDb, closeDb, getDbPath } from './db.js';
export { initializeSchema, SCHEMA_VERSION } from './schema.js';
export { generateUlid, appendEvent, appendEvents, queryEvents, countEvents, getLatestEventCursor } from './events.js';
export type { NewEventInput, QueryEventsOpts } from './events.js';
export { createCheckpoint, getLatestCompatibleCheckpoint, invalidateAllCheckpoints, computeProjectionChecksum, CURRENT_PROJECTION_VERSION } from './checkpoints.js';
export type { ProjectionCheckpoint } from './checkpoints.js';
export { rebuildProjection, AUDIT_ONLY_EVENTS, isEventSkippedByRollback } from './projectionBuilder.js';
export type { ProjectionRebuildResult } from './projectionBuilder.js';
export { rollbackCrossRunMutation, rollbackRun } from './rollback.js';
export { handleRunStarted, handleRunCompleted } from './exampleHandlers.js';
export { createEmptyProjectionState } from './projectionState.js';
export type { ProjectionState, EventHandlerRegistry } from './projectionState.js';
