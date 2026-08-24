/**
 * Zod schemas for the two MCP tools: `research` and `knowledge`.
 * Each uses a discriminated `action` field — one tool per family,
 * not one tool per action.
 */

import { z } from 'zod';

// ── Research tool ──────────────────────────────────────────────────

const ResearchStartSchema = z.object({
  action: z.literal('start'),
  query: z.string().describe('Research query'),
  strategy: z.enum(['agent', 'pipeline']).optional().describe('Research strategy (default: pipeline)'),
  depth: z.enum(['quick', 'standard', 'deep', 'exhaustive', 'tree']).optional().describe('Research depth (default: standard)'),
  familyId: z.string().optional().describe('Explicit family ID — skips resolution'),
  threadId: z.string().optional().describe('Thread ID for thread-level scoping'),
  sessionId: z.string().optional().describe('Session ID for correlation'),
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

export const ResearchToolSchema = z.discriminatedUnion('action', [
  ResearchStartSchema,
  ResearchStatusSchema,
  ResearchCancelSchema,
  ResearchRollbackSchema,
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
