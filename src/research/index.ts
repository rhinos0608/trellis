// owned by Worker 6 — research orchestrator, strategies, phases, workers, state, gaps, audit, jobs
// Worker 7 — run lifecycle service (research → durable persistence integration)

export { createRunService, rollbackRunById, MissingLlmConfigError } from './runService.js';
export type { RunService, StartRunInput, RetryRunInput, RunStatus, ContinueResearchInput, ContinueResearchResult } from './runService.js';
export { foldRunLedger, RunHistoryCorruptionError } from './runLedger.js';
export { JobScheduler, IdempotencyConflictError } from './scheduler.js';
export type { SchedulerOptions, SchedulerDeps, EnqueuedRun } from './scheduler.js';
