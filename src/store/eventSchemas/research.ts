/**
 * Zod schemas for research-domain event payloads: run lifecycle and synthesis.
 *
 * Shapes match the call sites in runService.ts, exampleHandlers.ts,
 * and rollback.ts.
 */
import { z } from 'zod';

export const runStartedPayload = z.strictObject({
  runId: z.string(),
  familyId: z.string(),
  query: z.string(),
  strategy: z.enum(['agent', 'pipeline', 'tree']),
  topic: z.string().optional(),
  threadId: z.string().optional(),
  sessionId: z.string().optional(),
});

export const runCompletedPayload = z.strictObject({
  runId: z.string(),
  entityCount: z.number().optional(),
  claimCount: z.number().optional(),
  sourceCount: z.number().optional(),
  evidenceCount: z.number().optional(),
  artifactPaths: z.array(z.string()).optional(),
});

export const runFailedPayload = z.strictObject({
  runId: z.string(),
  error: z.string(),
});

export const runCancelledPayload = z.strictObject({
  runId: z.string(),
});

export const runRolledBackPayload = z.strictObject({
  run_id: z.string(),
});

/** Legacy — no call sites in current codebase. Permissive. */
export const projectionRebuiltPayload = z.json();

/** Legacy — no call sites in current codebase. Permissive. */
export const synthesisCompletedPayload = z.json();
