/**
 * ProjectionState — the in-memory materialized view rebuilt deterministically
 * by replaying the event log. Mirrors search-mcp's knowledge/store/
 * projection-state.ts ProjectionState shape (nodes/edges/families/sources
 * Maps + reverse indices + rolledBackRuns + mergeHistory), extended with
 * Trellis's fuller domain model (claims, evidence, claim relations,
 * contradictions, gaps, threads, research runs) instead of generic
 * nodes/edges.
 *
 * Owned by Worker 2 (event store + projection builder/rebuild mechanism,
 * rollback executor). Domain handler functions — Worker 3 (entities/claims/
 * evidence/contradictions/gaps), Worker 4 (families/threads), Worker 7
 * (research runs) — each read and mutate this shape in response to one
 * EventEnvelope at a time via the EventHandler signature below, matching
 * search-mcp's real projection-handlers*.ts split (separate files per
 * domain, one shared dispatch table).
 */

import type {
  CanonicalEntity,
  Claim,
  ClaimRelation,
  Contradiction,
  Evidence,
  Source,
  Gap,
} from '../graph/types.js';
import type { Family, Thread } from '../workspace/types.js';
import type { ResearchRun } from '../research/types.js';
import type { EventEnvelope, TrellisEventType } from './eventTypes.js';

export interface EntityMergeRecord {
  fromId: string;
  intoId: string;
  fromLabel: string;
  mergedEventId: string;
}

export interface FamilyMergeRecord {
  fromId: string;
  intoId: string;
  fromLabel: string;
  mergedEventId: string;
}

export interface EntityFamilyMembership {
  entityId: string;
  familyId: string;
  confidence: number | null;
  isPrimary: boolean;
  runId: string | null;
}

export interface ProjectionState {
  entities: Map<string, CanonicalEntity>;
  claims: Map<string, Claim>;
  claimRelations: Map<string, ClaimRelation>;
  contradictions: Map<string, Contradiction>;
  evidence: Map<string, Evidence>;
  sources: Map<string, Source>;
  gaps: Map<string, Gap>;
  families: Map<string, Family>;
  threads: Map<string, Thread>;
  researchRuns: Map<string, ResearchRun>;

  /** Reverse indices for O(1) traversal — mirrors search-mcp's
   * edgesByFromId/edgesByToId pattern. */
  claimRelationsByFromClaimId: Map<string, Set<string>>;
  claimRelationsByToClaimId: Map<string, Set<string>>;
  evidenceByClaimId: Map<string, Set<string>>;
  claimsByFamilyId: Map<string, Set<string>>;
  threadsByFamilyId: Map<string, Set<string>>;
  entityFamilyMemberships: EntityFamilyMembership[];
  /** "entityId|familyId" keys for O(1) duplicate-membership lookup. */
  entityFamilyKeys: Set<string>;

  rolledBackRuns: Set<string>;
  entityMergeHistory: Map<string, EntityMergeRecord>;
  familyMergeHistory: Map<string, FamilyMergeRecord>;
}

// ── Serialization ──────────────────────────────────────────────────

/** Serialize ProjectionState to JSON-safe object. All Maps → [key,value][] arrays, Sets → arrays. */
export function serializeProjectionState(state: ProjectionState): string {
  return JSON.stringify({
    entities: [...state.entities],
    claims: [...state.claims],
    claimRelations: [...state.claimRelations],
    contradictions: [...state.contradictions],
    evidence: [...state.evidence],
    sources: [...state.sources],
    gaps: [...state.gaps],
    families: [...state.families],
    threads: [...state.threads],
    researchRuns: [...state.researchRuns],
    claimRelationsByFromClaimId: [...state.claimRelationsByFromClaimId].map(([k, v]) => [k, [...v]]),
    claimRelationsByToClaimId: [...state.claimRelationsByToClaimId].map(([k, v]) => [k, [...v]]),
    evidenceByClaimId: [...state.evidenceByClaimId].map(([k, v]) => [k, [...v]]),
    claimsByFamilyId: [...state.claimsByFamilyId].map(([k, v]) => [k, [...v]]),
    threadsByFamilyId: [...state.threadsByFamilyId].map(([k, v]) => [k, [...v]]),
    entityFamilyMemberships: state.entityFamilyMemberships,
    entityFamilyKeys: [...state.entityFamilyKeys],
    rolledBackRuns: [...state.rolledBackRuns],
    entityMergeHistory: [...state.entityMergeHistory],
    familyMergeHistory: [...state.familyMergeHistory],
  });
}

/** Deserialize a JSON string back into a live ProjectionState. */
export function deserializeProjectionState(json: string): ProjectionState {
  const raw = JSON.parse(json) as Record<string, unknown>;
  return {
    entities: new Map(raw.entities as [string, CanonicalEntity][]),
    claims: new Map(raw.claims as [string, Claim][]),
    claimRelations: new Map(raw.claimRelations as [string, ClaimRelation][]),
    contradictions: new Map(raw.contradictions as [string, Contradiction][]),
    evidence: new Map(raw.evidence as [string, Evidence][]),
    sources: new Map(raw.sources as [string, Source][]),
    gaps: new Map(raw.gaps as [string, Gap][]),
    families: new Map(raw.families as [string, Family][]),
    threads: new Map(raw.threads as [string, Thread][]),
    researchRuns: new Map(raw.researchRuns as [string, ResearchRun][]),
    claimRelationsByFromClaimId: new Map((raw.claimRelationsByFromClaimId as [string, string[]][]).map(([k, v]) => [k, new Set(v)])),
    claimRelationsByToClaimId: new Map((raw.claimRelationsByToClaimId as [string, string[]][]).map(([k, v]) => [k, new Set(v)])),
    evidenceByClaimId: new Map((raw.evidenceByClaimId as [string, string[]][]).map(([k, v]) => [k, new Set(v)])),
    claimsByFamilyId: new Map((raw.claimsByFamilyId as [string, string[]][]).map(([k, v]) => [k, new Set(v)])),
    threadsByFamilyId: new Map((raw.threadsByFamilyId as [string, string[]][]).map(([k, v]) => [k, new Set(v)])),
    entityFamilyMemberships: raw.entityFamilyMemberships as EntityFamilyMembership[],
    entityFamilyKeys: new Set(raw.entityFamilyKeys as string[]),
    rolledBackRuns: new Set(raw.rolledBackRuns as string[]),
    entityMergeHistory: new Map(raw.entityMergeHistory as [string, EntityMergeRecord][]),
    familyMergeHistory: new Map(raw.familyMergeHistory as [string, FamilyMergeRecord][]),
  };
}

export function createEmptyProjectionState(): ProjectionState {
  return {
    entities: new Map(),
    claims: new Map(),
    claimRelations: new Map(),
    contradictions: new Map(),
    evidence: new Map(),
    sources: new Map(),
    gaps: new Map(),
    families: new Map(),
    threads: new Map(),
    researchRuns: new Map(),
    claimRelationsByFromClaimId: new Map(),
    claimRelationsByToClaimId: new Map(),
    evidenceByClaimId: new Map(),
    claimsByFamilyId: new Map(),
    threadsByFamilyId: new Map(),
    entityFamilyMemberships: [],
    entityFamilyKeys: new Set(),
    rolledBackRuns: new Set(),
    entityMergeHistory: new Map(),
    familyMergeHistory: new Map(),
  };
}

/**
 * One handler per event type, mutating `state` in place. Mirrors
 * search-mcp's `EventHandler = (event: KgEvent, state: ProjectionState) =>
 * void`. Handlers live in the module that owns the domain they mutate
 * (graph/projectionHandlers.ts, workspace/projectionHandlers.ts, etc.) and
 * are wired into store/'s central dispatch table at startup.
 */
export type EventHandler = (event: EventEnvelope, state: ProjectionState) => void;

export type EventHandlerRegistry = Partial<Record<TrellisEventType, EventHandler>>;
