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
  claimObservedPayload,
  evidenceLinkedPayloadV1,
  evidenceLinkedPayloadV2,
  edgeAddedPayload,
  edgeRemovedPayload,
  contradictionIdentifiedPayload,
  contradictionResolvedPayload,
  contradictionFlaggedPayload,
  gapOpenedPayload,
  gapResolvedPayload,
  sourceAddedPayload,
  sourceObservedPayload,
  sourceReadPayload,
  sourceChangedPayload,
  sourceRetractedPayload,
  claimMergedPayload,
  claimSplitPayload,
  claimRetractionSetPayload,
  claimRelationCuratedPayload,
  evidenceStanceOverriddenPayload,
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
  runStartedPayload, runCompletedPayload, runFailedPayload, runFailedPayloadV2,
  runCancelledPayload, runCancelledPayloadV2, runRolledBackPayload,
  runQueuedPayload, runStartingPayload, runRunningPayload, runProgressPayload,
  runHeartbeatPayload, runCancellationRequestedPayload, runInterruptedPayload,
  upcastRunFailed, upcastRunCancelled,
  projectionRebuiltPayload,
  synthesisCompletedPayload,
} from './research.js';

// ── Schemas — legacy ──────────────────────────────────────────────────

import {
  claimExtractedPayload,
  extractionFailedPayload,
} from './legacy.js';

// ── Codec helper ──────────────────────────────────────────────────────

function v1(schema: z.ZodType): EventCodec { return { latestVersion: 1, versions: { 1: { schema } } }; }
function v2(v1Schema: z.ZodType, v2Schema: z.ZodType, upcast: (payload: unknown) => unknown): EventCodec {
  return { latestVersion: 2, versions: { 1: { schema: v1Schema, upcast }, 2: { schema: v2Schema } } };
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
  CLAIM_OBSERVED: v1(claimObservedPayload),
  EVIDENCE_LINKED: v2(evidenceLinkedPayloadV1, evidenceLinkedPayloadV2, (payload) => ({ ...(payload as Record<string, unknown>), observationId: (payload as Record<string, unknown>).claimId, stance: 'supports' })), 
  EDGE_ADDED: v1(edgeAddedPayload),
  EDGE_REMOVED: v1(edgeRemovedPayload),
  CONTRADICTION_IDENTIFIED: v1(contradictionIdentifiedPayload),
  CONTRADICTION_RESOLVED: v1(contradictionResolvedPayload),
  CONTRADICTION_FLAGGED: v1(contradictionFlaggedPayload),
  GAP_OPENED: v1(gapOpenedPayload),
  GAP_RESOLVED: v1(gapResolvedPayload),
  SOURCE_ADDED: v1(sourceAddedPayload),
  SOURCE_OBSERVED: v1(sourceObservedPayload),
  SOURCE_READ: v1(sourceReadPayload),
  SOURCE_CHANGED: v1(sourceChangedPayload),
  SOURCE_RETRACTED: v1(sourceRetractedPayload),

  // curation domain
  CLAIM_MERGED: v1(claimMergedPayload),
  CLAIM_SPLIT: v1(claimSplitPayload),
  CLAIM_RETRACTION_SET: v1(claimRetractionSetPayload),
  CLAIM_RELATION_CURATED: v1(claimRelationCuratedPayload),
  EVIDENCE_STANCE_OVERRIDDEN: v1(evidenceStanceOverriddenPayload),

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
  RUN_FAILED: v2(runFailedPayload, runFailedPayloadV2, upcastRunFailed),
  RUN_CANCELLED: v2(runCancelledPayload, runCancelledPayloadV2, upcastRunCancelled),
  RUN_ROLLED_BACK: v1(runRolledBackPayload),
  PROJECTION_REBUILT: v1(projectionRebuiltPayload),
  SYNTHESIS_COMPLETED: v1(synthesisCompletedPayload),
  RUN_QUEUED: v1(runQueuedPayload),
  RUN_STARTING: v1(runStartingPayload),
  RUN_RUNNING: v1(runRunningPayload),
  RUN_PROGRESS: v1(runProgressPayload),
  RUN_HEARTBEAT: v1(runHeartbeatPayload),
  RUN_CANCELLATION_REQUESTED: v1(runCancellationRequestedPayload),
  RUN_INTERRUPTED: v1(runInterruptedPayload),

  // legacy extraction-lifecycle
  CLAIM_EXTRACTED: v1(claimExtractedPayload),
  EXTRACTION_FAILED: v1(extractionFailedPayload),
} satisfies Record<TrellisEventType, EventCodec>;
