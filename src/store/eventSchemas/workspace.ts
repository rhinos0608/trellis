/**
 * Zod schemas for workspace-domain event payloads: family and thread events.
 *
 * Shapes match the inline interfaces in workspace/projectionHandlers.ts
 * and the actual payload construction in runService.ts.
 */
import { z } from 'zod';

export const familyCreatedPayload = z.strictObject({
  family_id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  entityIds: z.array(z.string()).optional(),
  runIds: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
});

export const familyClassifiedPayload = z.strictObject({
  entity_id: z.string(),
  family_id: z.string(),
  confidence: z.number().nullable().optional(),
  isPrimary: z.boolean().optional(),
});

export const familyRelatedPayload = z.strictObject({
  relation_id: z.string(),
  family_a: z.string(),
  family_b: z.string(),
  relation_type: z.enum(['adjacent', 'contradicts', 'parent', 'child', 'supersedes']),
  reason: z.string().optional(),
});

export const familyRelationRemovedPayload = z.strictObject({
  relation_id: z.string().optional(),
  family_a: z.string(),
  family_b: z.string(),
  relation_type: z.enum(['adjacent', 'contradicts', 'parent', 'child', 'supersedes']),
  reason: z.string().optional(),
});

export const familyRenamedPayload = z.strictObject({
  targetId: z.string(),
  oldLabel: z.string(),
  newLabel: z.string(),
});

export const familyMergedPayload = z.strictObject({
  survivorFamilyId: z.string(),
  mergedFamilyIds: z.array(z.string()),
  mergedSnapshots: z
    .array(
      z.strictObject({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  reattributedEntityIds: z.array(z.string()),
});

export const familyResolvedPayload = z.strictObject({
  familyId: z.string(),
  query: z.string(),
  isNew: z.boolean(),
  score: z.number().optional(),
  method: z.enum(['lexical_manifest_overlap']).optional(),
});

export const threadCreatedPayload = z.strictObject({
  threadId: z.string(),
  familyId: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const threadResolvedPayload = z.strictObject({
  threadId: z.string(),
  familyId: z.string(),
  resolution: z.string().optional(),
});
