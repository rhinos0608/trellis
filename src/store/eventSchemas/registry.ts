/**
 * EVENT_CODECS registry — one codec entry per TrellisEventType.
 *
 * The `satisfies Record<TrellisEventType, EventCodec>` clause makes
 * TypeScript fail to compile if even one event type is missing.
 */
import { z } from 'zod';
import type { TrellisEventType } from '../eventTypes.js';

// ── Codec contract ────────────────────────────────────────────────────

export interface EventVersionCodec {
  readonly schema: z.ZodType;
  /** Apply upcast from this version to exactly next version. */
  readonly upcast?: (payload: unknown) => unknown;
}

export interface EventCodec {
  readonly latestVersion: number;
  readonly versions: Readonly<Record<number, EventVersionCodec>>;
}

// ── Schemas — graph ───────────────────────────────────────────────────

import {
  nodeAddedPayload,
  nodeRelabeledPayload,
  nodeMetadataUpdatedPayload,
  extractionConfidenceRevisedPayload,
  relationshipStrengthRevisedPayload,
  entityMergedPayload,
  entitySplitPayload,
  claimAcceptedPayload,
  evidenceLinkedPayload,
  edgeAddedPayload,
  edgeRemovedPayload,
  contradictionIdentifiedPayload,
  contradictionResolvedPayload,
  contradictionFlaggedPayload,
  gapOpenedPayload,
  gapResolvedPayload,
  sourceAddedPayload,
  sourceReadPayload,
  sourceChangedPayload,
  sourceRetractedPayload,
} from './graph.js';

// ── Schemas — workspace ───────────────────────────────────────────────

import {
  familyCreatedPayload,
  familyClassifiedPayload,
  familyRelatedPayload,
  familyRelationRemovedPayload,
  familyRenamedPayload,
  familyMergedPayload,
  familyResolvedPayload,
  threadCreatedPayload,
  threadResolvedPayload,
} from './workspace.js';

// ── Schemas — research ────────────────────────────────────────────────

import {
  runStartedPayload,
  runCompletedPayload,
  runFailedPayload,
  runCancelledPayload,
  runRolledBackPayload,
  projectionRebuiltPayload,
  synthesisCompletedPayload,
} from './research.js';

// ── Schemas — legacy ──────────────────────────────────────────────────

import {
  claimExtractedPayload,
  extractionFailedPayload,
} from './legacy.js';

// ── Codec helper ──────────────────────────────────────────────────────

function v1(schema: z.ZodType): EventCodec {
  return { latestVersion: 1, versions: { 1: { schema } } };
}

// ── Registry ──────────────────────────────────────────────────────────

export const EVENT_CODECS = {
  // graph domain
  NODE_ADDED: v1(nodeAddedPayload),
  NODE_RELABELED: v1(nodeRelabeledPayload),
  NODE_METADATA_UPDATED: v1(nodeMetadataUpdatedPayload),
  EXTRACTION_CONFIDENCE_REVISED: v1(extractionConfidenceRevisedPayload),
  RELATIONSHIP_STRENGTH_REVISED: v1(relationshipStrengthRevisedPayload),
  ENTITY_MERGED: v1(entityMergedPayload),
  ENTITY_SPLIT: v1(entitySplitPayload),
  CLAIM_ACCEPTED: v1(claimAcceptedPayload),
  EVIDENCE_LINKED: v1(evidenceLinkedPayload),
  EDGE_ADDED: v1(edgeAddedPayload),
  EDGE_REMOVED: v1(edgeRemovedPayload),
  CONTRADICTION_IDENTIFIED: v1(contradictionIdentifiedPayload),
  CONTRADICTION_RESOLVED: v1(contradictionResolvedPayload),
  CONTRADICTION_FLAGGED: v1(contradictionFlaggedPayload),
  GAP_OPENED: v1(gapOpenedPayload),
  GAP_RESOLVED: v1(gapResolvedPayload),
  SOURCE_ADDED: v1(sourceAddedPayload),
  SOURCE_READ: v1(sourceReadPayload),
  SOURCE_CHANGED: v1(sourceChangedPayload),
  SOURCE_RETRACTED: v1(sourceRetractedPayload),

  // workspace domain
  FAMILY_CREATED: v1(familyCreatedPayload),
  FAMILY_CLASSIFIED: v1(familyClassifiedPayload),
  FAMILY_RELATED: v1(familyRelatedPayload),
  FAMILY_RELATION_REMOVED: v1(familyRelationRemovedPayload),
  FAMILY_RENAMED: v1(familyRenamedPayload),
  FAMILY_MERGED: v1(familyMergedPayload),
  FAMILY_RESOLVED: v1(familyResolvedPayload),
  THREAD_CREATED: v1(threadCreatedPayload),
  THREAD_RESOLVED: v1(threadResolvedPayload),

  // research domain
  RUN_STARTED: v1(runStartedPayload),
  RUN_COMPLETED: v1(runCompletedPayload),
  RUN_FAILED: v1(runFailedPayload),
  RUN_CANCELLED: v1(runCancelledPayload),
  RUN_ROLLED_BACK: v1(runRolledBackPayload),
  PROJECTION_REBUILT: v1(projectionRebuiltPayload),
  SYNTHESIS_COMPLETED: v1(synthesisCompletedPayload),

  // legacy extraction-lifecycle
  CLAIM_EXTRACTED: v1(claimExtractedPayload),
  EXTRACTION_FAILED: v1(extractionFailedPayload),
} satisfies Record<TrellisEventType, EventCodec>;
