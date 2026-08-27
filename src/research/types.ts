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

import type { ResearchDepth } from './internalTypes.js';

export type ResearchRunStatus =
  | 'queued' | 'starting' | 'running' | 'cancelling' | 'interrupted'
  | 'completed' | 'failed' | 'cancelled' | 'rolled_back';

export type ResearchStrategy = 'agent';

export interface RunFollowUp {
  kind: 'information_gain_v1';
  targetType: 'gap' | 'contradiction';
  targetId: string;
  sourceRunId: string;
}

export type RunErrorClassification = 'transient' | 'permanent' | 'deadline_exceeded' | 'budget_exceeded' | 'interrupted' | 'cancelled' | 'internal';
export interface RunError { code: string; classification: RunErrorClassification; message: string; retryable: boolean; occurredAt: string; provider?: string; }
export interface RunRetryPolicy { maxAttempts: number; autoRetry: boolean; initialBackoffMs: number; maxBackoffMs: number; }
export type ProviderOperation = 'search' | 'read' | 'crawl' | 'academic' | 'github' | 'reddit' | 'redditThread' | 'hackernews' | 'stackoverflow' | 'youtube' | 'youtubeTranscript' | 'wikipedia' | 'semanticSearch' | 'semanticCrawl' | 'semanticCode' | 'browser.open' | 'browser.extract' | 'browser.close';
export interface RunProgressCounts { subquestionsTotal?: number; subquestionsCompleted?: number; sourcesDiscovered?: number; sourcesRead?: number; findings?: number; providerCalls?: number; tokensUsed?: number; }
export interface RunProviderActivity { callId: string; provider: string; operation: ProviderOperation; state: 'started' | 'completed' | 'retrying' | 'failed' | 'cancelled'; attempt?: number; }
export interface RunProgressUpdate { phase: string; percent?: number; counts?: RunProgressCounts; currentSubquestion?: { id: string; text: string }; providerActivity?: RunProviderActivity; message?: string; }
export interface RunProgressPayload extends RunProgressUpdate { runId: string; }
export type ResearchRunProgress = RunProgressUpdate;

export interface RunContext {
  familyId: string;
  threadId?: string;
  researchRunId: string;
  sessionId?: string;
}

export interface ResearchRun {
  runId: string; rootRunId: string; retryOf?: string; attempt: number;
  familyId: string; threadId?: string; sessionId?: string; query: string; topic?: string;
  strategy: ResearchStrategy; depth: ResearchDepth; providerName: string;
  status: ResearchRunStatus; idempotencyKey?: string; requestHash: string; retryPolicy: RunRetryPolicy; nextRetryAt?: string;
  createdAt: string; queuedAt: string; startingAt?: string; startedAt?: string; completedAt?: string; failedAt?: string; cancelledAt?: string; interruptedAt?: string;
  ownerId?: string; heartbeatAt?: string; leaseUntil?: string; deadlineAt: string; error?: RunError;
  followUp?: RunFollowUp;
  progress: ResearchRunProgress; entityCount?: number; claimCount?: number; sourceCount?: number; evidenceCount?: number; artifactPaths?: string[];
  /** @deprecated Compatibility only; derive from error.message when present. */
  lastError?: string;
}
