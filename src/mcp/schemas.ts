/**
 * Zod schemas for the two MCP tools: `research` and `knowledge`.
 * Each uses a discriminated `action` field — one tool per family,
 * not one tool per action.
 */

import { z } from 'zod';

// ── Research tool ──────────────────────────────────────────────────

const ResearchStartSchema = z.object({
  action: z.literal('start'),
  query: z.string().trim().min(1).describe('Research query'),
  strategy: z.enum(['agent', 'pipeline']).optional().describe('Research strategy (default: pipeline)'),
  depth: z.enum(['quick', 'standard', 'deep', 'exhaustive', 'tree']).optional().describe('Research depth (default: standard)'),
  familyId: z.string().trim().min(1).optional().describe('Explicit family ID — skips resolution'),
  threadId: z.string().trim().min(1).optional().describe('Thread ID for thread-level scoping'),
  sessionId: z.string().trim().min(1).optional().describe('Session ID for correlation'),
});

const ResearchStatusSchema = z.object({
  action: z.literal('status'),
  runId: z.string().describe('Run ID to query'),
});

const ResearchCancelSchema = z.object({
  action: z.literal('cancel'),
  runId: z.string().describe('Run ID to cancel'),
});

const ResearchRollbackSchema = z.object({
  action: z.literal('rollback'),
  runId: z.string().describe('Run ID to roll back'),
});

const ResearchListSchema = z.object({
  action: z.literal('list'),
  status: z.string().optional(),
  familyId: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  beforeSeq: z.number().int().min(0).optional(),
});

const ResearchHistorySchema = z.object({
  action: z.literal('history'),
  runId: z.string(),
  limit: z.number().int().min(1).max(100).optional(),
});

const ResearchRetrySchema = z.object({
  action: z.literal('retry'),
  runId: z.string(),
  idempotencyKey: z.string().optional(),
  deadlineMs: z.number().int().min(1).optional(),
});

const ResearchContinueSchema = z.object({
  action: z.literal('continue'),
  familyId: z.string().trim().min(1),
  depth: z.enum(['quick', 'standard']).optional(),
  idempotencyKey: z.string().optional(),
});

export const ResearchToolSchema = z.discriminatedUnion('action', [
  ResearchStartSchema,
  ResearchStatusSchema,
  ResearchCancelSchema,
  ResearchRollbackSchema,
  ResearchListSchema,
  ResearchHistorySchema,
  ResearchRetrySchema,
  ResearchContinueSchema,
]);

export type ResearchToolInput = z.infer<typeof ResearchToolSchema>;

// ── Knowledge tool ─────────────────────────────────────────────────

const KnowledgeFamiliesSchema = z.object({
  action: z.literal('families'),
  familyId: z.string().optional().describe('Single family ID to query; omit to list all'),
});

const KnowledgeThreadsSchema = z.object({
  action: z.literal('threads'),
  familyId: z.string().describe('Family ID to list threads for'),
});

const KnowledgeClaimsSchema = z.object({
  action: z.literal('claims'),
  familyId: z.string().describe('Family ID'),
  threadId: z.string().optional().describe('Thread ID to filter by'),
});

const KnowledgeEvidenceSchema = z.object({
  action: z.literal('evidence'),
  claimId: z.string().describe('Claim ID to get evidence for'),
});

const KnowledgeContradictionsSchema = z.object({
  action: z.literal('contradictions'),
  familyId: z.string().describe('Family ID'),
});

const KnowledgeGapsSchema = z.object({
  action: z.literal('gaps'),
  familyId: z.string().describe('Family ID'),
});

const KnowledgeEntitySchema = z.object({
  action: z.literal('entity'),
  entityId: z.string().optional().describe('Entity ID'),
  label: z.string().optional().describe('Entity label (case-insensitive exact match)'),
});

export const KnowledgeToolSchema = z.discriminatedUnion('action', [
  KnowledgeFamiliesSchema,
  KnowledgeThreadsSchema,
  KnowledgeClaimsSchema,
  KnowledgeEvidenceSchema,
  KnowledgeContradictionsSchema,
  KnowledgeGapsSchema,
  KnowledgeEntitySchema,
]);

export type KnowledgeToolInput = z.infer<typeof KnowledgeToolSchema>;
