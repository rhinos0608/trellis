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
