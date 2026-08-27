import { z } from 'zod';

const strategy = z.enum(['agent', 'pipeline']); // 'pipeline' is legacy-replay-only, no longer accepted for new run requests
const depth = z.enum(['quick', 'standard', 'deep', 'exhaustive', 'tree']);
const retryPolicy = z.strictObject({ maxAttempts: z.number(), autoRetry: z.boolean(), initialBackoffMs: z.number(), maxBackoffMs: z.number() });
const runError = z.strictObject({ code: z.string(), classification: z.enum(['transient','permanent','deadline_exceeded','budget_exceeded','interrupted','cancelled','internal']), message: z.string().max(500), retryable: z.boolean(), occurredAt: z.string(), provider: z.string().optional() });

export const runStartedPayload = z.strictObject({ runId: z.string(), familyId: z.string(), query: z.string(), strategy, topic: z.string().optional(), threadId: z.string().optional(), sessionId: z.string().optional() });
export const runCompletedPayload = z.strictObject({ runId: z.string(), entityCount: z.number().optional(), claimCount: z.number().optional(), sourceCount: z.number().optional(), evidenceCount: z.number().optional(), artifactPaths: z.array(z.string()).optional() });
export const runFailedPayload = z.strictObject({ runId: z.string(), error: z.string() });
export const runFailedPayloadV2 = z.strictObject({ runId: z.string(), error: runError });
export const runCancelledPayload = z.strictObject({ runId: z.string() });
export const runCancelledPayloadV2 = z.strictObject({ runId: z.string(), reason: z.string().max(500) });

export const runQueuedPayload = z.strictObject({ runId:z.string(), rootRunId:z.string(), familyId:z.string(), threadId:z.string().optional(), sessionId:z.string().optional(), query:z.string(), topic:z.string().optional(), strategy, depth, providerName:z.string(), idempotencyKey:z.string().optional(), requestHash:z.string(), retryPolicy, deadlineAt:z.string(), attempt:z.number(), retryOf:z.string().optional(), queuedAt:z.string(), followUp: z.strictObject({ kind: z.literal('information_gain_v1'), targetType: z.enum(['gap', 'contradiction']), targetId: z.string(), sourceRunId: z.string() }).optional() });
export const runStartingPayload = z.strictObject({ runId:z.string(), ownerId:z.string(), startingAt:z.string() });
export const runRunningPayload = z.strictObject({ runId:z.string(), ownerId:z.string(), startedAt:z.string(), heartbeatAt:z.string(), leaseUntil:z.string() });
const providerOperation = z.enum(['search','read','crawl','academic','github','reddit','redditThread','hackernews','stackoverflow','youtube','youtubeTranscript','wikipedia','semanticSearch','semanticCrawl','semanticCode','browser.open','browser.extract','browser.close']);
const progressCounts = z.strictObject({ subquestionsTotal:z.number().optional(), subquestionsCompleted:z.number().optional(), sourcesDiscovered:z.number().optional(), sourcesRead:z.number().optional(), findings:z.number().optional(), providerCalls:z.number().optional(), tokensUsed:z.number().optional() });
const progressUpdate = z.strictObject({ phase:z.string(), percent:z.number().int().min(0).max(100).optional(), counts:progressCounts.optional(), currentSubquestion:z.strictObject({id:z.string(),text:z.string().max(500)}).optional(), providerActivity:z.strictObject({callId:z.string(),provider:z.string(),operation:providerOperation,state:z.enum(['started','completed','retrying','failed','cancelled']),attempt:z.number().optional()}).optional(), message:z.string().max(500).optional() });
export const runProgressPayload = progressUpdate.extend({ runId:z.string() });
export const runHeartbeatPayload = z.strictObject({ runId:z.string(), ownerId:z.string(), heartbeatAt:z.string(), leaseUntil:z.string() });
export const runCancellationRequestedPayload = z.strictObject({ runId:z.string(), requestedAt:z.string(), reason:z.string().optional() });
export const runInterruptedPayload = z.strictObject({ runId:z.string(), interruptedAt:z.string(), reason:z.string(), previousOwnerId:z.string().optional() });
export const runRolledBackPayload = z.strictObject({ run_id: z.string() });
export const projectionRebuiltPayload = z.json();
export const synthesisCompletedPayload = z.json();

// ── Agent strategy plan lifecycle ────────────────────────────────────────

const researchPlanPerspective = z.strictObject({
  name: z.string().max(200),
  question: z.string().max(1000),
});

const researchPlan = z.strictObject({
  scope: z.string().max(2000),
  assumptions: z.array(z.string().max(500)),
  perspectives: z.array(researchPlanPerspective),
  falsificationQuestions: z.array(z.string().max(1000)),
});

export const researchPlanCreatedPayload = z.strictObject({
  runId: z.string(),
  query: z.string(),
  plan: researchPlan,
  createdAt: z.string(),
});

export const researchPlanRevisedPayload = z.strictObject({
  runId: z.string(),
  query: z.string(),
  revisionReason: z.string().max(500),
  plan: researchPlan,
  revisedAt: z.string(),
  revisionNumber: z.number(),
});

export function upcastRunFailed(payload: unknown): unknown {
  const p = payload as {runId:string; error:string};
  // Legacy v1 payload cannot recover true occurrence time; sentinel preserves deterministic replay.
  return { runId:p.runId, error:{code:'legacy',classification:'internal',message:p.error.slice(0,500),retryable:false,occurredAt:'1970-01-01T00:00:00.000Z'} };
}
export function upcastRunCancelled(payload: unknown): unknown {
  const p = payload as {runId:string};
  return {runId:p.runId, reason:'legacy cancellation'};
}
