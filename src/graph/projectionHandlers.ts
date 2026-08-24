/**
 * Projection handler functions for Worker 3's domain: entities, claims,
 * evidence, contradictions, gaps, sources, and claim relations.
 *
 * Each handler matches the EventHandler signature from store/projectionState.ts:
 *   (event: EventEnvelope, state: ProjectionState) => void
 *
 * Handlers mutate `state` in place — exactly the pattern used by
 * search-mcp's projection-handlers.ts split (separate files per domain,
 * one shared dispatch table).
 */

import type { ProjectionState, EventHandler } from '../store/projectionState.js';
import type {
  EntityMergedPayload,
  EntitySplitPayload,
  RelabelPayload,
  ValueRevisionPayload,
  SourceChangedPayload,
  SourceRetractedPayload,
  ContradictionResolutionPayload,
  GapResolutionPayload,
} from '../store/eventTypes.js';
import type {
  CanonicalEntity,
  Claim,
  Evidence,
  ClaimRelation,
  Contradiction,
  Source,
  Gap,
} from './types.js';

// ── Reverse index helpers ────────────────────────────────────────────────────

function addClaimRelationIndex(
  state: ProjectionState,
  relation: ClaimRelation,
): void {
  let fromSet = state.claimRelationsByFromClaimId.get(relation.fromClaimId);
  if (!fromSet) {
    fromSet = new Set();
    state.claimRelationsByFromClaimId.set(relation.fromClaimId, fromSet);
  }
  fromSet.add(relation.id);

  let toSet = state.claimRelationsByToClaimId.get(relation.toClaimId);
  if (!toSet) {
    toSet = new Set();
    state.claimRelationsByToClaimId.set(relation.toClaimId, toSet);
  }
  toSet.add(relation.id);
}

function removeClaimRelationIndex(
  state: ProjectionState,
  relation: ClaimRelation,
): void {
  const fromSet = state.claimRelationsByFromClaimId.get(relation.fromClaimId);
  if (fromSet) fromSet.delete(relation.id);
  const toSet = state.claimRelationsByToClaimId.get(relation.toClaimId);
  if (toSet) toSet.delete(relation.id);
}

function addEvidenceIndex(state: ProjectionState, evidence: Evidence): void {
  let set = state.evidenceByClaimId.get(evidence.claimId);
  if (!set) {
    set = new Set();
    state.evidenceByClaimId.set(evidence.claimId, set);
  }
  set.add(evidence.id);
}

function addClaimFamilyIndex(state: ProjectionState, claim: Claim): void {
  let set = state.claimsByFamilyId.get(claim.familyId);
  if (!set) {
    set = new Set();
    state.claimsByFamilyId.set(claim.familyId, set);
  }
  set.add(claim.id);
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/** NODE_ADDED — add a CanonicalEntity. */
const handleNodeAdded: EventHandler = (event, state) => {
  const entity = event.payload as CanonicalEntity;
  state.entities.set(entity.id, entity);
};

/** NODE_RELABELED — update entity label. */
const handleNodeRelabeled: EventHandler = (event, state) => {
  const p = event.payload as RelabelPayload;
  const entity = state.entities.get(p.targetId);
  if (entity) {
    entity.label = p.newLabel;
    entity.lastUpdatedRunId = event.runId;
  }
};

/** NODE_METADATA_UPDATED — update entity metadata field. */
const handleNodeMetadataUpdated: EventHandler = (event, state) => {
  const p = event.payload as ValueRevisionPayload;
  const entity = state.entities.get(p.targetId);
  if (entity) {
    entity.metadata[p.field] = p.newValue;
    entity.lastUpdatedRunId = event.runId;
  }
};

/** ENTITY_MERGED — merge entities into survivor. */
const handleEntityMerged: EventHandler = (event, state) => {
  const p = event.payload as EntityMergedPayload;
  const survivor = state.entities.get(p.survivorId);
  if (!survivor) return;

  for (const snapshot of p.mergedSnapshots) {
    for (const alias of snapshot.aliases) {
      if (!survivor.aliases.includes(alias)) {
        survivor.aliases.push(alias);
      }
    }
    Object.assign(survivor.metadata, snapshot.metadata);
  }
  survivor.lastUpdatedRunId = event.runId;

  for (const mergedId of p.mergedIds) {
    state.entities.delete(mergedId);
  }

  for (const snapshot of p.mergedSnapshots) {
    state.entityMergeHistory.set(snapshot.id, {
      fromId: snapshot.id,
      intoId: p.survivorId,
      fromLabel: snapshot.label,
      mergedEventId: event.id,
    });
  }
};

/** ENTITY_SPLIT — remove original entity, record split. */
const handleEntitySplit: EventHandler = (event, state) => {
  const p = event.payload as EntitySplitPayload;
  state.entities.delete(p.originalId);
  state.entityMergeHistory.set(p.originalId, {
    fromId: p.originalId,
    intoId: p.resultingIds[0] ?? p.originalId,
    fromLabel: p.originalSnapshot.label,
    mergedEventId: event.id,
  });
};

/** CLAIM_ACCEPTED — add a Claim. */
const handleClaimAccepted: EventHandler = (event, state) => {
  const claim = event.payload as Claim;
  state.claims.set(claim.id, claim);
  addClaimFamilyIndex(state, claim);
};

/** EVIDENCE_LINKED — add an Evidence record. */
const handleEvidenceLinked: EventHandler = (event, state) => {
  const evidence = event.payload as Evidence;
  state.evidence.set(evidence.id, evidence);
  addEvidenceIndex(state, evidence);
};

/** CONTRADICTION_IDENTIFIED — add a Contradiction. */
const handleContradictionIdentified: EventHandler = (event, state) => {
  const contradiction = event.payload as Contradiction;
  state.contradictions.set(contradiction.id, contradiction);
};

/** CONTRADICTION_RESOLVED — update resolution status. */
const handleContradictionResolved: EventHandler = (event, state) => {
  const p = event.payload as ContradictionResolutionPayload;
  const c = state.contradictions.get(p.contradictionId);
  if (c) {
    c.resolutionStatus = p.newStatus as Contradiction['resolutionStatus'];
    c.resolvedRunId = event.runId;
  }
};

/** GAP_OPENED — add a Gap. */
const handleGapOpened: EventHandler = (event, state) => {
  const gap = event.payload as Gap;
  state.gaps.set(gap.id, gap);
};

/** GAP_RESOLVED — update gap status and resolution. */
const handleGapResolved: EventHandler = (event, state) => {
  const p = event.payload as GapResolutionPayload;
  const g = state.gaps.get(p.gapId);
  if (g) {
    g.status = p.newStatus as Gap['status'];
    if (p.resolution) g.resolution = p.resolution;
    g.resolvedRunId = event.runId;
  }
};

/** SOURCE_ADDED — add a Source. */
const handleSourceAdded: EventHandler = (event, state) => {
  const source = event.payload as Source;
  state.sources.set(source.id, source);
};

/** SOURCE_READ — mark source as read. */
const handleSourceRead: EventHandler = (event, state) => {
  const p = event.payload as { sourceId: string };
  const source = state.sources.get(p.sourceId);
  if (source) {
    source.usageStatus = 'read';
  }
};

/** SOURCE_CHANGED — update content hash. */
const handleSourceChanged: EventHandler = (event, state) => {
  const p = event.payload as SourceChangedPayload;
  const source = state.sources.get(p.sourceId);
  if (source) {
    source.contentHash = p.newContentHash;
  }
};

/** SOURCE_RETRACTED — mark source as discarded. */
const handleSourceRetracted: EventHandler = (event, state) => {
  const p = event.payload as SourceRetractedPayload;
  const source = state.sources.get(p.sourceId);
  if (source) {
    source.usageStatus = 'discarded';
    const reason = p.reasonType as Source['discardReason'];
    if (reason) source.discardReason = reason;
  }
};

/** EDGE_ADDED — add a ClaimRelation. */
const handleEdgeAdded: EventHandler = (event, state) => {
  const relation = event.payload as ClaimRelation;
  state.claimRelations.set(relation.id, relation);
  addClaimRelationIndex(state, relation);
};

/** EDGE_REMOVED — remove a ClaimRelation. */
const handleEdgeRemoved: EventHandler = (event, state) => {
  const p = event.payload as { edgeId: string };
  const relation = state.claimRelations.get(p.edgeId);
  if (relation) {
    removeClaimRelationIndex(state, relation);
    state.claimRelations.delete(p.edgeId);
  }
};

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Graph-domain event handlers — merge into the central dispatch
 * table at store/ startup (Worker 2).
 */
export const graphEventHandlers = {
  NODE_ADDED: handleNodeAdded,
  NODE_RELABELED: handleNodeRelabeled,
  NODE_METADATA_UPDATED: handleNodeMetadataUpdated,
  ENTITY_MERGED: handleEntityMerged,
  ENTITY_SPLIT: handleEntitySplit,
  CLAIM_ACCEPTED: handleClaimAccepted,
  EVIDENCE_LINKED: handleEvidenceLinked,
  CONTRADICTION_IDENTIFIED: handleContradictionIdentified,
  CONTRADICTION_RESOLVED: handleContradictionResolved,
  GAP_OPENED: handleGapOpened,
  GAP_RESOLVED: handleGapResolved,
  SOURCE_ADDED: handleSourceAdded,
  SOURCE_READ: handleSourceRead,
  SOURCE_CHANGED: handleSourceChanged,
  SOURCE_RETRACTED: handleSourceRetracted,
  EDGE_ADDED: handleEdgeAdded,
  EDGE_REMOVED: handleEdgeRemoved,
} as const;
