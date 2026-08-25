import type {
  AuthorityClass,
  ExtractionStatus,
  SourceType,
  ClaimRelationType,
  ClaimRelationStrength,
} from '../graph/types.js';

/**
 * Trellis event vocabulary — extends search-mcp's existing KgEventType
 * union (src/knowledge/types.ts) rather than replacing it. The 26 legacy
 * event names are kept verbatim even though the domain types they mutate
 * are now named differently (NODE_* -> CanonicalEntity, EDGE_* ->
 * ClaimRelation/graph edges, FAMILY_* -> workspace/types.ts Family):
 * renaming the event log's string tags would force touching every file in
 * the ported event-store/projection machinery for a purely cosmetic gain.
 *
 * ROLLBACK MECHANISM — two different things happen depending on class:
 *   - pure_run_local / audit_only / dynamic_edge: unchanged from
 *     search-mcp today — a REPLAY-TIME SKIP. Rebuilding the projection
 *     from the event log skips these events for rolled-back runs
 *     (dynamic_edge only skips if the edge was added by the SAME run).
 *   - cross_run_mutation: NEVER skipped on replay, in search-mcp or here
 *     — other runs may have built on the mutated state, so retroactively
 *     pretending it never happened would be silently incorrect. Rollback
 *     instead APPENDS A NEW COMPENSATING EVENT that reverses the effect
 *     going forward (never rewrite history). See ReversiblePayload below
 *     and docs/ARCHITECTURE.md §1 (#11) / open decision #2.
 *
 * Source of truth for the legacy classification: search-mcp's
 * src/knowledge/store/projection-state.ts ROLLBACK_CLASSES /
 * AUDIT_ONLY_EVENTS (read directly, not inferred).
 *
 * Owned by Worker 2 (event store + projections + rollback executor).
 * Consumed by every domain that appends events (Worker 3, 4, 6, 7).
 */

// ── Legacy event types, ported verbatim from search-mcp's KgEventType ─────

export type LegacyTrellisEventType =
  | 'RUN_STARTED'
  | 'RUN_COMPLETED'
  | 'RUN_FAILED'
  | 'PROJECTION_REBUILT'
  | 'NODE_ADDED'
  | 'NODE_RELABELED'
  | 'NODE_METADATA_UPDATED'
  | 'EXTRACTION_CONFIDENCE_REVISED'
  | 'EDGE_ADDED'
  | 'EDGE_REMOVED'
  | 'RELATIONSHIP_STRENGTH_REVISED'
  | 'CONTRADICTION_FLAGGED'
  | 'ENTITY_MERGED'
  | 'ENTITY_SPLIT'
  | 'CLAIM_EXTRACTED'
  | 'EXTRACTION_FAILED'
  | 'SOURCE_ADDED'
  | 'SOURCE_CHANGED'
  | 'SOURCE_RETRACTED'
  | 'FAMILY_CLASSIFIED'
  | 'FAMILY_CREATED'
  | 'FAMILY_RELATED'
  | 'FAMILY_RELATION_REMOVED'
  | 'FAMILY_RENAMED'
  | 'FAMILY_MERGED'
  | 'RUN_ROLLED_BACK';

// ── New event types (Trellis additions) ────────────────────────────────────

export type NewTrellisEventType =
  | 'FAMILY_RESOLVED'
  | 'THREAD_CREATED'
  | 'THREAD_RESOLVED'
  | 'SOURCE_READ'
  | 'SOURCE_OBSERVED'
  | 'CLAIM_ACCEPTED'
  | 'CLAIM_OBSERVED'
  | 'EVIDENCE_LINKED'
  | 'CONTRADICTION_IDENTIFIED'
  | 'CONTRADICTION_RESOLVED'
  | 'GAP_OPENED'
  | 'GAP_RESOLVED'
  | 'SYNTHESIS_COMPLETED'
  | 'RUN_CANCELLED'
  | 'RUN_QUEUED'
  | 'RUN_STARTING'
  | 'RUN_RUNNING'
  | 'RUN_PROGRESS'
  | 'RUN_HEARTBEAT'
  | 'RUN_CANCELLATION_REQUESTED'
  | 'RUN_INTERRUPTED'
  // Phase 9 Stage 1 — operator curation lifecycle
  | 'CLAIM_MERGED'
  | 'CLAIM_SPLIT'
  | 'CLAIM_RETRACTION_SET'
  | 'CLAIM_RELATION_CURATED'
  | 'EVIDENCE_STANCE_OVERRIDDEN';

export type TrellisEventType = LegacyTrellisEventType | NewTrellisEventType;

// ── Rollback classification ─────────────────────────────────────────────

export type RollbackClass = 'pure_run_local' | 'cross_run_mutation' | 'audit_only' | 'dynamic_edge';

export const ROLLBACK_CLASS: Record<TrellisEventType, RollbackClass> = {
  // legacy — verbatim from search-mcp's ROLLBACK_CLASSES
  RUN_STARTED: 'audit_only',
  RUN_COMPLETED: 'audit_only',
  RUN_FAILED: 'audit_only',
  PROJECTION_REBUILT: 'audit_only',
  NODE_ADDED: 'pure_run_local',
  NODE_RELABELED: 'cross_run_mutation',
  NODE_METADATA_UPDATED: 'cross_run_mutation',
  EXTRACTION_CONFIDENCE_REVISED: 'cross_run_mutation',
  EDGE_ADDED: 'pure_run_local',
  EDGE_REMOVED: 'dynamic_edge',
  RELATIONSHIP_STRENGTH_REVISED: 'cross_run_mutation',
  CONTRADICTION_FLAGGED: 'pure_run_local',
  ENTITY_MERGED: 'cross_run_mutation',
  ENTITY_SPLIT: 'cross_run_mutation',
  CLAIM_EXTRACTED: 'audit_only',
  EXTRACTION_FAILED: 'audit_only',
  SOURCE_ADDED: 'pure_run_local',
  SOURCE_CHANGED: 'cross_run_mutation',
  SOURCE_RETRACTED: 'cross_run_mutation',
  FAMILY_CLASSIFIED: 'pure_run_local',
  FAMILY_CREATED: 'pure_run_local',
  FAMILY_RELATED: 'pure_run_local',
  FAMILY_RELATION_REMOVED: 'cross_run_mutation',
  FAMILY_RENAMED: 'cross_run_mutation',
  FAMILY_MERGED: 'cross_run_mutation',
  RUN_ROLLED_BACK: 'audit_only',
  // new
  FAMILY_RESOLVED: 'audit_only',
  THREAD_CREATED: 'pure_run_local',
  THREAD_RESOLVED: 'pure_run_local',
  SOURCE_READ: 'pure_run_local',
  SOURCE_OBSERVED: 'pure_run_local',
  CLAIM_ACCEPTED: 'pure_run_local',
  CLAIM_OBSERVED: 'pure_run_local',
  EVIDENCE_LINKED: 'pure_run_local',
  CONTRADICTION_IDENTIFIED: 'pure_run_local',
  CONTRADICTION_RESOLVED: 'cross_run_mutation',
  GAP_OPENED: 'pure_run_local',
  GAP_RESOLVED: 'cross_run_mutation',
  SYNTHESIS_COMPLETED: 'audit_only',
  RUN_CANCELLED: 'audit_only',
  RUN_QUEUED: 'audit_only',
  RUN_STARTING: 'audit_only',
  RUN_RUNNING: 'audit_only',
  RUN_PROGRESS: 'audit_only',
  RUN_HEARTBEAT: 'audit_only',
  RUN_CANCELLATION_REQUESTED: 'audit_only',
  RUN_INTERRUPTED: 'audit_only',
  // curation — mutate durable claim state across runs (like ENTITY_MERGED);
  // payloads embed before/after snapshots + curation context so the rollback
  // executor can synthesize compensation in a later stage.
  CLAIM_MERGED: 'cross_run_mutation',
  CLAIM_SPLIT: 'cross_run_mutation',
  CLAIM_RETRACTION_SET: 'cross_run_mutation',
  CLAIM_RELATION_CURATED: 'cross_run_mutation',
  EVIDENCE_STANCE_OVERRIDDEN: 'cross_run_mutation',
};

/** Note: CLAIM_EXTRACTED stays audit_only exactly as it is in search-mcp
 * today (a raw per-passage extraction, logged but not itself queryable) —
 * the new CLAIM_ACCEPTED (pure_run_local) is the event that actually
 * projects into the queryable Claim table, fixing the gap where research's
 * rich claim model never reached a queryable projection (docs/
 * ARCHITECTURE.md §1 #3). */

// ── Executable rollback contract for cross_run_mutation events ────────────

/**
 * Every cross_run_mutation event payload MUST embed whatever pre-mutation
 * state is needed to construct its own exact inverse — not just the fact
 * that a mutation happened. This is what makes cross-run rollback
 * EXECUTABLE (appends a compensating event) instead of merely advisory.
 *
 * Not every cross_run_mutation is safely auto-reversible: if a LATER run
 * added claims/evidence to an entity produced by an earlier merge, undoing
 * that merge can't unambiguously reattribute the later data back to one
 * side or the other. The rollback executor (store/rollback.ts) must detect
 * this — by checking for references into the merged scope created by runs
 * after this event — and return `blocked` with a reason instead of
 * guessing. Silently misattributing data is worse than refusing to roll
 * back. See docs/ARCHITECTURE.md open decision #2.
 */
export interface EntityMergeSnapshot {
  id: string;
  label: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  claimIds: string[];
  evidenceIds: string[];
}

export interface EntityMergedPayload {
  survivorId: string;
  mergedIds: string[];
  mergedSnapshots: EntityMergeSnapshot[];
}

export interface EntitySplitPayload {
  originalId: string;
  originalSnapshot: { label: string; aliases: string[]; metadata: Record<string, unknown> };
  resultingIds: string[];
  /**
   * Full per-entity snapshots for each resulting id, when this split is a
   * rollback compensation for a prior ENTITY_MERGED (the only current
   * producer of ENTITY_SPLIT). Without this the projection handler has no
   * data to recreate the resulting entities' label/aliases/metadata from.
   */
  restoredSnapshots?: EntityMergeSnapshot[];
}

export interface FamilyMergeSnapshot {
  id: string;
  label: string;
  description?: string;
}

export interface FamilyMergedPayload {
  survivorFamilyId: string;
  mergedFamilyIds: string[];
  mergedSnapshots: FamilyMergeSnapshot[];
  reattributedEntityIds: string[];
}

export interface RelabelPayload {
  targetId: string;
  oldLabel: string;
  newLabel: string;
}

export interface ValueRevisionPayload {
  targetId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface SourceObservedPayload {
  sourceId: string;
  observedSourceId: string;
  canonicalUrl: string;
  url: string;
  title?: string;
  domain: string;
  sourceType: SourceType;
  authorityClass?: AuthorityClass;
  qualityScore?: number;
  isPrimary: boolean;
  extractionStatus: ExtractionStatus;
  contentHash?: string;
  runId: string;
  observedAt: string;
}

export interface SourceChangedPayload {
  sourceId: string;
  oldContentHash: string;
  newContentHash: string;
}

export interface SourceRetractedPayload {
  sourceId: string;
  reasonType: string;
  wasUsageStatus?: string;
}

export interface ContradictionResolutionPayload {
  contradictionId: string;
  previousStatus: string;
  newStatus: string;
  resolvedBy?: string;
}

export interface GapResolutionPayload {
  gapId: string;
  previousStatus: string;
  newStatus: string;
  resolution?: { answer: string; evidenceSummary: string };
}

// ── Curation events (Phase 9 Stage 1) ────────────────────────────────

/** Shared context block for every curation event: identifies the idempotent
 * operator command, who issued it (within the envelope's actor kind), why,
 * and the append-time optimistic-concurrency expectation. */
export interface CurationContext {
  commandId: string;
  reason: string;
  expectedSeq: number;
}

export interface ClaimMergedPayload {
  curation: CurationContext;
  sourceClaimId: string;
  survivorClaimId: string;
  affectedObservationIds: string[];
  affectedEvidenceIds: string[];
  affectedRelationIds: string[];
  affectedContradictionIds: string[];
  affectedGapIds: string[];
}

export interface ClaimSplitResult {
  claimId: string;
  currentObservationId: string;
  observationIds: string[];
  evidenceIds: string[];
}

export interface ClaimSplitPayload {
  curation: CurationContext;
  sourceClaimId: string;
  /** Minimum 2 results — a split that yields fewer than two claims is a no-op. */
  results: ClaimSplitResult[];
}

export interface ClaimRetractionSetPayload {
  curation: CurationContext;
  target: { kind: 'claim'; id: string } | { kind: 'observation'; id: string };
  previousStatus: 'active' | 'retracted';
  newStatus: 'active' | 'retracted';
  /** Observations explicitly affected; claim retraction defaults to all. */
  observationIds?: string[];
}

/** Full pre/post state of a claim relation, mirroring ClaimRelation from
 * graph/types.ts so curation is self-documenting and reversible. */
export interface CuratedRelationSnapshot {
  id: string;
  fromClaimId: string;
  toClaimId: string;
  relation: ClaimRelationType;
  strength: ClaimRelationStrength;
  score: number;
  rationale?: string;
  runId: string;
}

export interface ClaimRelationCuratedPayload {
  curation: CurationContext;
  relationId: string;
  /** null = no prior relation existed (creation) or none remains (removal); never both. */
  before: CuratedRelationSnapshot | null;
  after: CuratedRelationSnapshot | null;
}

export interface EvidenceStanceOverriddenPayload {
  curation: CurationContext;
  evidenceId: string;
  claimId: string;
  previousStance: EvidenceStance | null;
  newStance: EvidenceStance;
}

export type RollbackOutcome =
  | { kind: 'executed'; inverseEventId: string }
  | { kind: 'blocked'; reason: string };

// ── Event envelope ──────────────────────────────────────────────────────

/**
 * Authoritative monotonic cursor — the `seq` column from the events table.
 * Replaces the old ULID-string ordering; ordering is now by seq only.
 */
export type EventCursor = number;

/**
 * Application-level typed event, as domain code (Worker 3/4/6/7) appends
 * and reads it. The DB row itself stores `payload` as a serialized JSON
 * string (matching search-mcp's KgEvent) — that raw-row <-> typed-envelope
 * mapping is store/'s internal concern (Worker 2), not exposed here.
 */
export type EvidenceStance = 'supports' | 'opposes' | 'context';
export interface EvidenceV2 {
  id: string; claimId: string; sourceId: string; observationId: string; stance: EvidenceStance;
  excerpt?: string; alignment?: unknown; runId: string;
}

export interface EventEnvelope<TPayload = unknown> {
  seq: EventCursor;
  id: string;
  timestamp: string;
  eventType: TrellisEventType;
  eventVersion: number;
  runId: string;
  batchId: string | null;
  actor: 'system' | 'user' | 'classifier' | 'rollback';
  /** Identity WITHIN the actor kind (e.g. actor:'user', actorId:'operator-jane').
   * Nullable — legacy events predating migration 0003 have NULL. */
  actorId: string | null;
  entityId: string | null;
  entityType: string | null;
  payload: TPayload;
  payloadHash: string;
}
