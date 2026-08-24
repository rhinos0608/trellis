// owned by Worker 6 — research orchestrator, strategies, phases, workers, state, gaps, audit, jobs
// Worker 7 — run lifecycle service (research → durable persistence integration)

export { createRunService, rollbackRunById } from './runService.js';
export type { RunService, StartRunInput, RunStatus } from './runService.js';
