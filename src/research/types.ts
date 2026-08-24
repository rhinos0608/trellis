/**
 * ResearchRun — durable deep-research job/run state. Replaces search-mcp's
 * in-memory ResearchJobManager Map + JSON-directory rehydration
 * (research/jobManager.ts:169,683; deepResearch.ts:659-716) with rows/
 * events in Trellis's own store. See docs/ARCHITECTURE.md §1 (#9, #12).
 *
 * familyId is resolved BEFORE execution starts (§1 #7) — never assigned
 * retroactively. No global "active run" singleton: every call that needs
 * run context takes {familyId, threadId?, researchRunId, sessionId?}
 * explicitly (§1 #9).
 *
 * Owned by Worker 6 (deep research core port) and Worker 7 (research ->
 * persistence integration, which makes this durable instead of in-memory).
 */

export type ResearchRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rolled_back';

export type ResearchStrategy = 'agent' | 'pipeline' | 'tree';

export interface ResearchRunProgress {
  phase: string;
  percent?: number;
  message?: string;
}

export interface RunContext {
  familyId: string;
  threadId?: string;
  researchRunId: string;
  sessionId?: string;
}

export interface ResearchRun {
  runId: string;
  familyId: string;
  threadId?: string;
  sessionId?: string;
  status: ResearchRunStatus;
  query: string;
  topic?: string;
  strategy: ResearchStrategy;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  lastError?: string;
  progress: ResearchRunProgress;
  entityCount?: number;
  claimCount?: number;
  sourceCount?: number;
  evidenceCount?: number;
  /** Full report/narrative artifacts on disk, non-authoritative — the
   * event store is authoritative, these are rendered views for humans. */
  artifactPaths?: string[];
  idempotencyKey?: string;
}
