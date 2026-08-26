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
import { EventReferenceInvalidError } from '../store/eventErrors.js';
import type {
  EntityMergedPayload,
  EntitySplitPayload,
  RelabelPayload,
  ValueRevisionPayload,
  SourceChangedPayload,
  SourceObservedPayload,
  SourceRetractedPayload,
  ContradictionResolutionPayload,
  GapResolutionPayload,
  ClaimMergedPayload,
  ClaimSplitPayload,
  ClaimRetractionSetPayload,
  ClaimRelationCuratedPayload,
  EvidenceStanceOverriddenPayload,
  CuratedRelationSnapshot,
} from '../store/eventTypes.js';
import type {
  CanonicalEntity,
  Claim,
  ClaimAssertion,
  Evidence,
  ClaimRelation,
  Contradiction,
  Source,
  Gap,
  ClaimObservation,
  ClaimReconciliation,
} from './types.js';
import { canonicalizeSourceUrl } from './sourceIdentity.js';
import { classifySourceAuthority } from './sourceAuthority.js';
import { deriveEpistemicState } from './epistemics.js';

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

const LEGACY_CLAIM_EXTRACTION_VERSION = 'claim-accepted-v1';

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
  if (claim.observationIds === undefined) {
    const legacy = claim;
    // Strip claim-level curation lifecycle fields — a fresh synthetic
    // observation starts active and ClaimObservation's narrower status union
    // ('active' | 'retracted') must not inherit the claim-level one.
    const { curationStatus: _curationStatus, lastCuration: _lastCuration, ...observationBase } = legacy;
    const observation: ClaimObservation = { ...observationBase, id: `obs_legacy_${claim.id}`, runId: claim.firstSeenRunId, observedAt: event.timestamp, confidence: claim.confidence, sourceIds: [], extractionVersion: LEGACY_CLAIM_EXTRACTION_VERSION };
    state.claimObservations.set(observation.id, observation);
    state.observationToClaimId.set(observation.id, claim.id);
    state.observationsByClaimId.set(claim.id, new Set([observation.id]));
    legacy.currentObservationId = observation.id; legacy.firstSeenAt = event.timestamp; legacy.lastSeenAt = event.timestamp;
    legacy.observationIds = [observation.id]; legacy.observationCount = 1; legacy.evidenceIds = legacy.evidenceIds ?? [];
    legacy.supportingEvidenceCount = legacy.supportingEvidenceCount ?? 0; legacy.opposingEvidenceCount = legacy.opposingEvidenceCount ?? 0;
    legacy.confidenceHistory = [{ observationId: observation.id, runId: observation.runId, observedAt: observation.observedAt, confidence: observation.confidence }]; legacy.revisionHistory = [];
  }
  state.claims.set(claim.id, claim); addClaimFamilyIndex(state, claim);
};

/** CLAIM_OBSERVED — persist observation and reconcile into canonical claim. */
const handleClaimObserved: EventHandler = (event, state) => {
  const { observation, reconciliation } = event.payload as { observation: ClaimObservation; reconciliation: ClaimReconciliation };
  state.claimObservations.set(observation.id, observation);
  state.claimReconciliations.set(observation.id, reconciliation);
  state.observationToClaimId.set(observation.id, reconciliation.canonicalClaimId);
  let observations = state.observationsByClaimId.get(reconciliation.canonicalClaimId);
  if (!observations) { observations = new Set(); state.observationsByClaimId.set(reconciliation.canonicalClaimId, observations); }
  observations.add(observation.id);
  const matched = reconciliation.matchedClaimId ? state.claims.get(reconciliation.matchedClaimId) : undefined;
  // Rolled-back founders are absent from materialized state. Surviving observations
  // may still carry their canonical ID; bootstrap claim instead of dropping observation.
  if (reconciliation.classification === 'same_claim' && !matched) {
    const founderRolledBack = [...(state.observationsByClaimId.get(reconciliation.canonicalClaimId) ?? [])]
      .filter((id) => id !== observation.id)
      .some((id) => state.rolledBackRuns.has(state.claimObservations.get(id)?.runId ?? ''));
    if (!founderRolledBack) throw new EventReferenceInvalidError('CLAIM_OBSERVED', reconciliation.matchedClaimId ?? reconciliation.canonicalClaimId);
    const { id: _id, familyId: _family, threadId: _thread, runId: _run, observedAt: _at, confidence: _conf, sourceIds: _sources, extractionVersion: _version, ...assertion } = observation;
    const claim: Claim = { ...assertion, id: reconciliation.canonicalClaimId, familyId: observation.familyId, ...(observation.threadId !== undefined ? { threadId: observation.threadId } : {}), confidence: observation.confidence, currentObservationId: observation.id, firstSeenRunId: observation.runId, firstSeenAt: observation.observedAt, lastSeenRunId: observation.runId, lastSeenAt: observation.observedAt, contradictionState: 'none', epistemicStatus: 'unknown', observationIds: [observation.id], observationCount: 1, evidenceIds: [], supportingEvidenceCount: 0, opposingEvidenceCount: 0, confidenceHistory: [{ observationId: observation.id, runId: observation.runId, observedAt: observation.observedAt, confidence: observation.confidence }], revisionHistory: [] };
    state.claims.set(claim.id, claim); addClaimFamilyIndex(state, claim); recomputeClaim(state, claim); return;
  }
  if (reconciliation.classification === 'same_claim' && matched) {
    matched.observationIds = [...(matched.observationIds ?? []), observation.id];
    matched.observationCount = matched.observationIds.length;
    matched.lastSeenRunId = observation.runId; matched.lastSeenAt = observation.observedAt;
    matched.currentObservationId = observation.id;
    matched.subjectText = observation.subjectText; matched.predicate = observation.predicate; matched.polarity = observation.polarity; matched.hedge = observation.hedge; matched.evidenceType = observation.evidenceType; matched.canonicalKey = observation.canonicalKey;
    if (observation.objectText !== undefined) matched.objectText = observation.objectText;
    matched.confidence = matched.observationIds.reduce((sum, id) => sum + (state.claimObservations.get(id)?.confidence ?? matched.confidence), 0) / matched.observationIds.length;
    matched.confidenceHistory = [...(matched.confidenceHistory ?? []), { observationId: observation.id, runId: observation.runId, observedAt: observation.observedAt, confidence: observation.confidence }];
    recomputeClaim(state, matched);
    return;
  }
  if (reconciliation.classification === 'supersedes' && matched) {
    const supersedes = reconciliation.supersedes;
    if (!supersedes) return;
    const before = supersedes.previousAssertion;
    const { id: _id, familyId: _family, threadId: _thread, runId: _run, observedAt: _at, confidence: _conf, sourceIds: _sources, extractionVersion: _version, ...updatedAssertion } = observation;
    Object.assign(matched, updatedAssertion, { observationIds: [...(matched.observationIds ?? []), observation.id], observationCount: (matched.observationIds?.length ?? 0) + 1, currentObservationId: observation.id, lastSeenRunId: observation.runId, lastSeenAt: observation.observedAt, confidence: observation.confidence });
    matched.confidenceHistory = [...(matched.confidenceHistory ?? []), { observationId: observation.id, runId: observation.runId, observedAt: observation.observedAt, confidence: observation.confidence }];
    matched.revisionHistory = [...(matched.revisionHistory ?? []), { revision: (matched.revisionHistory?.length ?? 0) + 1, classification: 'supersedes', fromObservationId: supersedes.previousObservationId, toObservationId: observation.id, runId: observation.runId, revisedAt: observation.observedAt, before, after: observation, rationale: reconciliation.rationale }];
    recomputeClaim(state, matched);
    return;
  }
  const { id: _observationId, familyId: _familyId, threadId: _threadId, runId: _runId, observedAt: _observedAt, confidence: _confidence, sourceIds: _sourceIds, extractionVersion: _extractionVersion, ...assertion } = observation;
  const claim: Claim = {
    ...assertion, id: reconciliation.canonicalClaimId, familyId: observation.familyId, ...(observation.threadId !== undefined ? { threadId: observation.threadId } : {}), confidence: observation.confidence, currentObservationId: observation.id,
    firstSeenRunId: observation.runId, firstSeenAt: observation.observedAt, lastSeenRunId: observation.runId,
    lastSeenAt: observation.observedAt, contradictionState: 'none', epistemicStatus: 'unknown',
    observationIds: [observation.id], observationCount: 1, evidenceIds: [], supportingEvidenceCount: 0,
    opposingEvidenceCount: 0, confidenceHistory: [{ observationId: observation.id, runId: observation.runId, observedAt: observation.observedAt, confidence: observation.confidence }], revisionHistory: [],
  };
  state.claims.set(claim.id, claim); addClaimFamilyIndex(state, claim);
  if (matched && ['near_duplicate', 'elaboration', 'qualification', 'contradiction'].includes(reconciliation.classification)) {
    const relation = { id: `rel_${event.id}`, fromClaimId: claim.id, toClaimId: matched.id, relation: reconciliation.classification === 'elaboration' ? 'elaborates' : reconciliation.classification === 'qualification' ? 'qualifies' : reconciliation.classification === 'contradiction' ? 'contradicts' : 'near_duplicate', strength: reconciliation.score >= 0.8 ? 'strong' : 'weak', score: reconciliation.score, rationale: reconciliation.rationale, runId: event.runId } as ClaimRelation;
    state.claimRelations.set(relation.id, relation); addClaimRelationIndex(state, relation);
    if (reconciliation.classification === 'contradiction') state.contradictions.set(`contra_${event.id}`, { id: `contra_${event.id}`, familyId: claim.familyId, claimIdA: claim.id, claimIdB: matched.id, contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved', firstSeenRunId: event.runId });
  }
  recomputeClaim(state, claim);
  if (matched) recomputeClaim(state, matched);
};

/** EVIDENCE_LINKED — add an Evidence record. */
const handleEvidenceLinked: EventHandler = (event, state) => {
  const evidence = event.payload as Evidence;
  const previous = state.evidence.get(evidence.id);
  if (previous && previous.claimId !== evidence.claimId) {
    state.evidenceByClaimId.get(previous.claimId)?.delete(evidence.id);
    const prevClaim = state.claims.get(previous.claimId);
    if (prevClaim) {
      prevClaim.evidenceIds = (prevClaim.evidenceIds ?? []).filter((id) => id !== evidence.id);
      recomputeClaim(state, prevClaim);
    }
  }
  state.evidence.set(evidence.id, evidence);
  addEvidenceIndex(state, evidence);
  const claim = state.claims.get(evidence.claimId);
  if (claim && !(claim.evidenceIds ?? []).includes(evidence.id)) claim.evidenceIds = [...(claim.evidenceIds ?? []), evidence.id];
  if (claim) {
    recomputeClaim(state, claim);
  }
};

/** CONTRADICTION_IDENTIFIED — add a Contradiction. */
const handleContradictionIdentified: EventHandler = (event, state) => {
  const contradiction = event.payload as Contradiction;
  state.contradictions.set(contradiction.id, contradiction);
  // Re-derive both affected claims
  const claimA = state.claims.get(contradiction.claimIdA);
  if (claimA) recomputeClaim(state, claimA);
  const claimB = state.claims.get(contradiction.claimIdB);
  if (claimB) recomputeClaim(state, claimB);
};

/** CONTRADICTION_RESOLVED — update resolution status. */
const handleContradictionResolved: EventHandler = (event, state) => {
  const p = event.payload as ContradictionResolutionPayload;
  const c = state.contradictions.get(p.contradictionId);
  if (c) {
    c.resolutionStatus = p.newStatus as Contradiction['resolutionStatus'];
    c.resolvedRunId = event.runId;
    // Re-derive both affected claims
    const claimA = state.claims.get(c.claimIdA);
    if (claimA) recomputeClaim(state, claimA);
    const claimB = state.claims.get(c.claimIdB);
    if (claimB) recomputeClaim(state, claimB);
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

/** SOURCE_ADDED — add a legacy Source, deriving observation fields for replay. */
const handleSourceAdded: EventHandler = (event, state) => {
  const source = event.payload as Omit<Source, 'canonicalUrl' | 'firstSeenRunId' | 'lastSeenRunId' | 'lastSeenAt' | 'runCount' | 'retrievedAt'> & Partial<Pick<Source, 'canonicalUrl' | 'firstSeenRunId' | 'lastSeenRunId' | 'lastSeenAt' | 'runCount' | 'retrievedAt'>> & { runId?: string };
  const firstSeenRunId = source.firstSeenRunId ?? source.runId ?? event.runId;
  const firstSeenAt = source.retrievedAt ?? event.timestamp;
  const adapted = {
    ...source,
    canonicalUrl: source.canonicalUrl ?? canonicalizeSourceUrl(source.url),
    retrievedAt: firstSeenAt,
    firstSeenRunId,
    lastSeenRunId: source.lastSeenRunId ?? firstSeenRunId,
    lastSeenAt: source.lastSeenAt ?? firstSeenAt,
    runCount: source.runCount ?? 1,
  } as Source;
  state.sources.set(source.id, adapted);
};

/** SOURCE_OBSERVED — upsert cross-run source observation by canonical ID. */
const handleSourceObserved: EventHandler = (event, state) => {
  const payload = event.payload as SourceObservedPayload;
  const existing = state.sources.get(payload.sourceId);
  if (!existing) {
    const authorityClass = payload.authorityClass ?? classifySourceAuthority({ url: payload.url, domain: payload.domain, sourceType: payload.sourceType });
    const source: Source = {
      id: payload.sourceId,
      url: payload.url,
      canonicalUrl: payload.canonicalUrl,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      domain: payload.domain,
      sourceType: payload.sourceType,
      authorityClass,
      ...(payload.qualityScore !== undefined ? { qualityScore: payload.qualityScore } : {}),
      isPrimary: payload.isPrimary,
      extractionStatus: payload.extractionStatus,
      ...(payload.contentHash !== undefined ? { contentHash: payload.contentHash } : {}),
      retrievedAt: payload.observedAt,
      firstSeenRunId: payload.runId,
      lastSeenRunId: payload.runId,
      lastSeenAt: payload.observedAt,
      runCount: 1,
    };
    state.sources.set(source.id, source);
    return;
  }
  if (existing.authorityClass === undefined) {
    existing.authorityClass = classifySourceAuthority({ url: payload.url, domain: payload.domain, sourceType: payload.sourceType });
  }
  existing.runCount += 1;
  existing.lastSeenRunId = payload.runId;
  existing.lastSeenAt = payload.observedAt;
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
  // Dynamic edges can outlive a rolled-back claim; never materialize dangling edges.
  // Preserve direct legacy handler calls with no claims loaded; skip only partial/dangling edges.
  const hasFrom = state.claims.has(relation.fromClaimId);
  const hasTo = state.claims.has(relation.toClaimId);
  if (relation.fromClaimId === relation.toClaimId || !hasFrom || !hasTo) return;
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

// ── Curation handlers ─────────────────────────────────────────────────────────

const activeClaim = (claim: Claim | undefined): claim is Claim => !!claim && (claim.curationStatus ?? 'active') === 'active';
const activeObservation = (observation: ClaimObservation): boolean => (observation.curationStatus ?? 'active') === 'active';

function markCuration(event: Parameters<EventHandler>[0], reason: string) {
  return { commandId: (event.payload as { curation: { commandId: string } }).curation.commandId, actorId: event.actorId ?? event.actor, reason, at: event.timestamp };
}
function projectClaimAssertion(claim: Claim, assertion: ClaimAssertion): void {
  Object.assign(claim, assertion);
  if (assertion.subjectEntityId === undefined) delete claim.subjectEntityId;
  if (assertion.objectEntityId === undefined) delete claim.objectEntityId;
  if (assertion.objectText === undefined) delete claim.objectText;
  if (assertion.quantifier === undefined) delete claim.quantifier;
  if (assertion.temporalScope === undefined) delete claim.temporalScope;
  if (assertion.authorityClass === undefined) delete claim.authorityClass;
  if (assertion.authorityRequirement === undefined) delete claim.authorityRequirement;
  if (assertion.supportLevel === undefined) delete claim.supportLevel;
}
function recomputeClaim(state: ProjectionState, claim: Claim): void {
  const observations = (claim.observationIds ?? [])
    .map((id) => state.claimObservations.get(id))
    .filter((o): o is ClaimObservation => !!o);
  // CLAIM_ACCEPTED legacy payloads synthesize one compatibility observation.
  // Once real CLAIM_OBSERVED records exist, synthetic record must not skew
  // lifecycle counts/confidence.
  // Only exclude synthetic records when real observations exist — a claim
  // whose observations are ALL legacy must keep its legacy-derived confidence.
  const realObs = observations.filter((o) => o.extractionVersion !== LEGACY_CLAIM_EXTRACTION_VERSION);
  const materialized = realObs.length > 0 ? realObs : observations;
  const active = materialized.filter(activeObservation);
  claim.observationCount = active.length;
  claim.supportingEvidenceCount = countStance(state, claim, 'supports');
  claim.opposingEvidenceCount = countStance(state, claim, 'opposes');
  const current = active.slice().sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id))[0];
  if (current) {
    claim.currentObservationId = current.id;
    const { id: _id, familyId: _family, threadId: _thread, runId: _run, observedAt: _at, confidence: _confidence, sourceIds: _sources, extractionVersion: _version, curationStatus: _status, lastCuration: _last, ...assertion } = current;
    projectClaimAssertion(claim, assertion);
  } else delete claim.currentObservationId;
  // Derive epistemic state from observations, evidence, sources, contradictions
  const asOf = claim.lastSeenAt ?? new Date().toISOString();
  const derived = deriveEpistemicState(state, claim, asOf);
  claim.confidence = derived.confidence;
  claim.epistemicStatus = derived.epistemicStatus;
  claim.contradictionState = derived.contradictionState;
  claim.supportLevel = derived.supportLevel;
}
/** Evidence counts ignore records whose observation was retracted — retracted
 * observations must not contribute support to the canonical claim. Evidence
 * without an observationId has no lifecycle linkage and always counts. */
function evidenceActive(state: ProjectionState, e: Evidence | undefined): e is Evidence {
  return !!e && !(e.observationId !== undefined && state.claimObservations.get(e.observationId)?.curationStatus === 'retracted');
}
function countStance(state: ProjectionState, claim: Claim, stance: NonNullable<Evidence['stance']>): number {
  return (claim.evidenceIds ?? []).map((id) => state.evidence.get(id)).filter((e) => e?.stance === stance && evidenceActive(state, e)).length;
}
function setObservationClaimIndex(state: ProjectionState, observationId: string, claimId: string): void {
  const old = state.observationToClaimId.get(observationId);
  if (old) state.observationsByClaimId.get(old)?.delete(observationId);
  state.observationToClaimId.set(observationId, claimId);
  let set = state.observationsByClaimId.get(claimId);
  if (!set) { set = new Set(); state.observationsByClaimId.set(claimId, set); }
  set.add(observationId);
}
function relationSnapshotEqual(a: ClaimRelation, b: CuratedRelationSnapshot): boolean {
  return a.id === b.id && a.fromClaimId === b.fromClaimId && a.toClaimId === b.toClaimId
    && a.relation === b.relation && a.strength === b.strength && a.score === b.score
    && a.rationale === b.rationale && a.runId === b.runId;
}
function putRelation(state: ProjectionState, relation: CuratedRelationSnapshot): void {
  const from = state.claims.get(relation.fromClaimId); const to = state.claims.get(relation.toClaimId);
  if (relation.fromClaimId === relation.toClaimId || !from || !to) throw new EventReferenceInvalidError('CLAIM_RELATION_CURATED', relation.id);
  if (from.familyId !== to.familyId) throw new EventReferenceInvalidError('CLAIM_RELATION_CURATED', `cross-family ${relation.id}`);
  const value: ClaimRelation = { ...relation };
  state.claimRelations.set(value.id, value); addClaimRelationIndex(state, value);
}

const handleClaimMerged: EventHandler = (event, state) => {
  const p = event.payload as ClaimMergedPayload;
  const source = state.claims.get(p.sourceClaimId); const survivor = state.claims.get(p.survivorClaimId);
  if (!activeClaim(source) || !activeClaim(survivor) || source.id === survivor.id) throw new EventReferenceInvalidError('CLAIM_MERGED', `${p.sourceClaimId}/${p.survivorClaimId}`);
  if (source.familyId !== survivor.familyId) throw new EventReferenceInvalidError('CLAIM_MERGED', 'cross-family');
  { const actualObs = new Set(source.observationIds ?? []); const declaredObs = new Set(p.affectedObservationIds); if (declaredObs.size > 0 && ![...declaredObs].every((id) => actualObs.has(id))) throw new EventReferenceInvalidError('CLAIM_MERGED', 'affected observation mismatch'); }
  { const actualEvidence = new Set(source.evidenceIds ?? []); const declaredEvidence = new Set(p.affectedEvidenceIds); if (declaredEvidence.size > 0 && ![...declaredEvidence].every((id) => actualEvidence.has(id))) throw new EventReferenceInvalidError('CLAIM_MERGED', 'affected evidence mismatch'); }
  { const actualRelations = new Set([...state.claimRelations.values()].filter((r) => r.fromClaimId === source.id || r.toClaimId === source.id).map((r) => r.id)); const declaredRelations = new Set(p.affectedRelationIds); if (declaredRelations.size > 0 && ![...declaredRelations].every((id) => actualRelations.has(id))) throw new EventReferenceInvalidError('CLAIM_MERGED', 'affected relation mismatch'); }
  source.curationStatus = 'merged'; source.mergedIntoClaimId = survivor.id; source.lastCuration = markCuration(event, p.curation.reason);
  const sourceObs = source.observationIds ?? [];
  for (const id of sourceObs) { if (!survivor.observationIds?.includes(id)) survivor.observationIds = [...(survivor.observationIds ?? []), id]; setObservationClaimIndex(state, id, survivor.id); const o = state.claimObservations.get(id); if (o && o.threadId === undefined && survivor.threadId !== undefined) o.threadId = survivor.threadId; }
  for (const id of source.evidenceIds ?? []) { const evidence = state.evidence.get(id); if (evidence) { evidence.claimId = survivor.id; if (!survivor.evidenceIds?.includes(id)) survivor.evidenceIds = [...(survivor.evidenceIds ?? []), id]; state.evidenceByClaimId.get(source.id)?.delete(id); addEvidenceIndex(state, evidence); } }
  survivor.confidenceHistory = [...(survivor.confidenceHistory ?? []), ...(source.confidenceHistory ?? [])].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.observationId.localeCompare(b.observationId));
  survivor.revisionHistory = [...(survivor.revisionHistory ?? []), ...(source.revisionHistory ?? [])].sort((a, b) => b.revisedAt.localeCompare(a.revisedAt) || a.toObservationId.localeCompare(b.toObservationId));
  if (source.firstSeenAt && (!survivor.firstSeenAt || source.firstSeenAt < survivor.firstSeenAt)) { survivor.firstSeenAt = source.firstSeenAt; survivor.firstSeenRunId = source.firstSeenRunId; }
  if (source.lastSeenAt && (!survivor.lastSeenAt || source.lastSeenAt > survivor.lastSeenAt)) { survivor.lastSeenAt = source.lastSeenAt; survivor.lastSeenRunId = source.lastSeenRunId; }
  for (const [id, relation] of [...state.claimRelations]) if (relation.fromClaimId === source.id || relation.toClaimId === source.id) { removeClaimRelationIndex(state, relation); state.claimRelations.delete(id); const rewritten = { ...relation, fromClaimId: relation.fromClaimId === source.id ? survivor.id : relation.fromClaimId, toClaimId: relation.toClaimId === source.id ? survivor.id : relation.toClaimId }; if (rewritten.fromClaimId !== rewritten.toClaimId) putRelation(state, rewritten); }
  for (const contradiction of state.contradictions.values()) { if (contradiction.claimIdA === source.id) contradiction.claimIdA = survivor.id; if (contradiction.claimIdB === source.id) contradiction.claimIdB = survivor.id; }
  for (const [id, contradiction] of [...state.contradictions]) if (contradiction.claimIdA === contradiction.claimIdB) state.contradictions.delete(id);
  for (const gap of state.gaps.values()) if (gap.relatedClaimId === source.id) gap.relatedClaimId = survivor.id;
  source.observationIds = []; source.evidenceIds = []; source.observationCount = 0;
  delete source.currentObservationId; source.confidence = 0; source.supportingEvidenceCount = 0; source.opposingEvidenceCount = 0; source.confidenceHistory = []; source.revisionHistory = [];
  recomputeClaim(state, survivor);
};

const handleClaimSplit: EventHandler = (event, state) => {
  const p = event.payload as ClaimSplitPayload; const source = state.claims.get(p.sourceClaimId);
  if (!activeClaim(source)) throw new EventReferenceInvalidError('CLAIM_SPLIT', p.sourceClaimId);
  if ([...state.claimRelations.values()].some((r) => r.fromClaimId === source.id || r.toClaimId === source.id)) throw new EventReferenceInvalidError('CLAIM_SPLIT', `incident relations ${source.id}`);
  if ([...state.contradictions.values()].some((c) => c.claimIdA === source.id || c.claimIdB === source.id)) throw new EventReferenceInvalidError('CLAIM_SPLIT', `incident contradictions ${source.id}`);
  if ([...state.gaps.values()].some((g) => g.relatedClaimId === source.id)) throw new EventReferenceInvalidError('CLAIM_SPLIT', `related gaps ${source.id}`);
  const ids = p.results.map((r) => r.claimId); if (new Set(ids).size !== ids.length) throw new EventReferenceInvalidError('CLAIM_SPLIT', 'duplicate result ids');
  const sourceObs = new Set(source.observationIds ?? []); const sourceEvidence = new Set(source.evidenceIds ?? []); const seenObs = new Set<string>(); const seenEvidence = new Set<string>();
  for (const result of p.results) { if (state.claims.has(result.claimId) || !sourceObs.has(result.currentObservationId) || !result.observationIds.every((id) => sourceObs.has(id)) || !result.evidenceIds.every((id) => sourceEvidence.has(id)) || result.observationIds.some((id) => seenObs.has(id)) || result.evidenceIds.some((id) => seenEvidence.has(id))) throw new EventReferenceInvalidError('CLAIM_SPLIT', result.claimId); result.observationIds.forEach((id) => seenObs.add(id)); result.evidenceIds.forEach((id) => seenEvidence.add(id)); }
  if (seenObs.size !== sourceObs.size || seenEvidence.size !== sourceEvidence.size) throw new EventReferenceInvalidError('CLAIM_SPLIT', source.id);
  for (const result of p.results) {
    const current = state.claimObservations.get(result.currentObservationId);
    if (!current) throw new EventReferenceInvalidError('CLAIM_SPLIT', result.currentObservationId);
    const { id: _id, familyId: _family, threadId: _thread, runId: _run, observedAt: _at, confidence: _confidence, sourceIds: _sources, extractionVersion: _version, curationStatus: _status, lastCuration: _last, ...assertion } = current;
    const claim: Claim = { ...assertion, id: result.claimId, familyId: source.familyId, ...(source.threadId !== undefined ? { threadId: source.threadId } : {}), confidence: current.confidence, currentObservationId: current.id, firstSeenRunId: current.runId, firstSeenAt: current.observedAt, lastSeenRunId: current.runId, lastSeenAt: current.observedAt, contradictionState: 'none', epistemicStatus: 'unknown', observationIds: [...result.observationIds], observationCount: result.observationIds.length, evidenceIds: [...result.evidenceIds], supportingEvidenceCount: 0, opposingEvidenceCount: 0, confidenceHistory: result.observationIds.map((id) => { const o = state.claimObservations.get(id); if (!o) throw new EventReferenceInvalidError('CLAIM_SPLIT', id); return { observationId: id, runId: o.runId, observedAt: o.observedAt, confidence: o.confidence }; }), revisionHistory: [] };
    state.claims.set(claim.id, claim); addClaimFamilyIndex(state, claim); for (const id of result.observationIds) setObservationClaimIndex(state, id, claim.id); for (const id of result.evidenceIds) { const evidence = state.evidence.get(id); if (!evidence) throw new EventReferenceInvalidError('CLAIM_SPLIT', id); evidence.claimId = claim.id; state.evidenceByClaimId.get(source.id)?.delete(id); addEvidenceIndex(state, evidence); } recomputeClaim(state, claim);
  }
  source.curationStatus = 'split'; source.splitIntoClaimIds = p.results.map((r) => r.claimId); source.lastCuration = markCuration(event, p.curation.reason); source.observationIds = []; source.evidenceIds = []; source.observationCount = 0;
  delete source.currentObservationId; source.confidence = 0; source.supportingEvidenceCount = 0; source.opposingEvidenceCount = 0; source.confidenceHistory = []; source.revisionHistory = [];
};

const handleClaimRetractionSet: EventHandler = (event, state) => {
  const p = event.payload as ClaimRetractionSetPayload;
  if (p.target.kind === 'claim') {
    const claim = state.claims.get(p.target.id);
    if (!claim || (claim.curationStatus ?? 'active') !== p.previousStatus) throw new EventReferenceInvalidError('CLAIM_RETRACTION_SET', p.target.id);
    claim.curationStatus = p.newStatus;
    claim.lastCuration = markCuration(event, p.curation.reason);
    const observationIds = p.newStatus === 'retracted'
      ? (claim.observationIds ?? [])
      : [...new Set([
        ...(p.observationIds ?? []),
        ...(claim.observationIds ?? []).filter((id) => state.claimObservations.get(id)?.extractionVersion === LEGACY_CLAIM_EXTRACTION_VERSION),
      ])];
    for (const id of observationIds) {
      const observation = state.claimObservations.get(id);
      if (!observation || !(claim.observationIds ?? []).includes(id)) throw new EventReferenceInvalidError('CLAIM_RETRACTION_SET', id);
      if ((observation.curationStatus ?? 'active') !== p.previousStatus) continue;
      observation.curationStatus = p.newStatus;
      observation.lastCuration = markCuration(event, p.curation.reason);
    }
    recomputeClaim(state, claim);
    if (p.newStatus === 'retracted') { claim.supportingEvidenceCount = 0; claim.opposingEvidenceCount = 0; }
    return;
  }
  const observation = state.claimObservations.get(p.target.id); const claimId = state.observationToClaimId.get(p.target.id); const claim = claimId ? state.claims.get(claimId) : undefined;
  if (!observation || !claim || (observation.curationStatus ?? 'active') !== p.previousStatus) throw new EventReferenceInvalidError('CLAIM_RETRACTION_SET', p.target.id);
  observation.curationStatus = p.newStatus; observation.lastCuration = markCuration(event, p.curation.reason);
  if (p.newStatus === 'retracted' && claim.currentObservationId === p.target.id) {
    const activeObs = (claim.observationIds ?? []).map((id) => state.claimObservations.get(id)).filter((o): o is ClaimObservation => o !== undefined && (o.curationStatus ?? 'active') === 'active');
    activeObs.sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.id.localeCompare(b.id));
    const next = activeObs[0];
    if (next) { claim.currentObservationId = next.id; claim.subjectText = next.subjectText; claim.predicate = next.predicate; if (next.objectText !== undefined) claim.objectText = next.objectText; claim.polarity = next.polarity; claim.hedge = next.hedge; claim.evidenceType = next.evidenceType; claim.canonicalKey = next.canonicalKey; }
  }
  recomputeClaim(state, claim);
};

const handleClaimRelationCurated: EventHandler = (event, state) => {
  const p = event.payload as ClaimRelationCuratedPayload; const current = state.claimRelations.get(p.relationId);
  if (p.before && (!current || !relationSnapshotEqual(current, p.before))) throw new EventReferenceInvalidError('CLAIM_RELATION_CURATED', `stale ${p.relationId}`);
  if (!p.before && current) throw new EventReferenceInvalidError('CLAIM_RELATION_CURATED', `exists ${p.relationId}`);
  if (current) { removeClaimRelationIndex(state, current); state.claimRelations.delete(current.id); }
  if (p.after) putRelation(state, p.after);
};

const handleEvidenceStanceOverridden: EventHandler = (event, state) => {
  const p = event.payload as EvidenceStanceOverriddenPayload; const evidence = state.evidence.get(p.evidenceId); const claim = state.claims.get(p.claimId);
  if (!evidence || !claim || evidence.claimId !== p.claimId || (evidence.stance ?? null) !== p.previousStance) throw new EventReferenceInvalidError('EVIDENCE_STANCE_OVERRIDDEN', p.evidenceId);
  evidence.stance = p.newStance; claim.supportingEvidenceCount = countStance(state, claim, 'supports'); claim.opposingEvidenceCount = countStance(state, claim, 'opposes');
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
  CLAIM_OBSERVED: handleClaimObserved,
  EVIDENCE_LINKED: handleEvidenceLinked,
  CONTRADICTION_IDENTIFIED: handleContradictionIdentified,
  CONTRADICTION_RESOLVED: handleContradictionResolved,
  GAP_OPENED: handleGapOpened,
  GAP_RESOLVED: handleGapResolved,
  SOURCE_ADDED: handleSourceAdded,
  SOURCE_OBSERVED: handleSourceObserved,
  SOURCE_READ: handleSourceRead,
  SOURCE_CHANGED: handleSourceChanged,
  SOURCE_RETRACTED: handleSourceRetracted,
  EDGE_ADDED: handleEdgeAdded,
  EDGE_REMOVED: handleEdgeRemoved,
  CLAIM_MERGED: handleClaimMerged,
  CLAIM_SPLIT: handleClaimSplit,
  CLAIM_RETRACTION_SET: handleClaimRetractionSet,
  CLAIM_RELATION_CURATED: handleClaimRelationCurated,
  EVIDENCE_STANCE_OVERRIDDEN: handleEvidenceStanceOverridden,
} as const;
