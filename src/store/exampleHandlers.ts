/**
 * Example EventHandler: research run lifecycle.
 * Handles RUN_STARTED and RUN_COMPLETED to update state.researchRuns.
 *
 * This proves the dispatch mechanism end-to-end without hardcoding
 * domain logic — it's a minimal example that other workers (3, 4, 7)
 * will follow when registering their own handlers.
 */

import type { EventEnvelope } from './eventTypes.js';
import type { ProjectionState } from './projectionState.js';

interface RunStartedPayload {
  runId: string;
  familyId: string;
  query: string;
  strategy: string;
  topic?: string;
  threadId?: string;
  sessionId?: string;
}

interface RunCompletedPayload {
  runId: string;
  entityCount?: number;
  claimCount?: number;
  sourceCount?: number;
  evidenceCount?: number;
  artifactPaths?: string[];
}

export function handleRunStarted(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as RunStartedPayload;
  const run: import('../research/types.js').ResearchRun = {
    runId: p.runId,
    familyId: p.familyId,
    status: 'running',
    query: p.query,
    strategy: p.strategy as 'agent' | 'pipeline' | 'tree',
    startedAt: event.timestamp,
    progress: { phase: 'started' },
  };
  if (p.threadId !== undefined) run.threadId = p.threadId;
  if (p.sessionId !== undefined) run.sessionId = p.sessionId;
  if (p.topic !== undefined) run.topic = p.topic;
  state.researchRuns.set(p.runId, run);
}

export function handleRunCompleted(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as RunCompletedPayload;
  const run = state.researchRuns.get(p.runId);
  if (run !== undefined) {
    run.status = 'completed';
    run.completedAt = event.timestamp;
    if (p.entityCount !== undefined) run.entityCount = p.entityCount;
    if (p.claimCount !== undefined) run.claimCount = p.claimCount;
    if (p.sourceCount !== undefined) run.sourceCount = p.sourceCount;
    if (p.evidenceCount !== undefined) run.evidenceCount = p.evidenceCount;
    if (p.artifactPaths !== undefined) run.artifactPaths = p.artifactPaths;
  }
}
