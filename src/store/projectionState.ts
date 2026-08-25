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
  ClaimObservation,
  ClaimReconciliation,
  ClaimRelation,
  Contradiction,
  Evidence,
  Source,
  Gap,
} from '../graph/types.js';
import type { Family, Thread } from '../workspace/types.js';
import type { ResearchRun } from '../research/types.js';
import type { EventCursor, EventEnvelope, TrellisEventType } from './eventTypes.js';

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
  lastAppliedSeq: EventCursor;
  entities: Map<string, CanonicalEntity>;
  claims: Map<string, Claim>;
  claimObservations: Map<string, ClaimObservation>;
  claimReconciliations: Map<string, ClaimReconciliation>;
  observationToClaimId: Map<string, string>;
  observationsByClaimId: Map<string, Set<string>>;
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
    lastAppliedSeq: state.lastAppliedSeq,
    entities: [...state.entities],
    claims: [...state.claims],
    claimObservations: [...state.claimObservations],
    claimReconciliations: [...state.claimReconciliations],
    observationToClaimId: [...state.observationToClaimId],
    observationsByClaimId: [...state.observationsByClaimId].map(([k, v]) => [k, [...v]]),
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
    lastAppliedSeq: (raw.lastAppliedSeq as number | undefined) ?? 0,
    entities: new Map(raw.entities as [string, CanonicalEntity][]),
    claims: new Map(raw.claims as [string, Claim][]),
    claimObservations: new Map((raw.claimObservations ?? []) as [string, ClaimObservation][]),
    claimReconciliations: new Map((raw.claimReconciliations ?? []) as [string, ClaimReconciliation][]),
    observationToClaimId: new Map((raw.observationToClaimId ?? []) as [string, string][]),
    observationsByClaimId: new Map(((raw.observationsByClaimId ?? []) as [string, string[]][]).map(([k, v]) => [k, new Set(v)])),
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
    lastAppliedSeq: 0,
    entities: new Map(),
    claims: new Map(),
    claimObservations: new Map(),
    claimReconciliations: new Map(),
    observationToClaimId: new Map(),
    observationsByClaimId: new Map(),
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

// ── Canonical serialization for integrity checksums ─────────────────

/**
 * Reject non-JSON-safe values (undefined, function, bigint, NaN, Infinity)
 * that would be silently coerced by JSON.stringify, making checksum lossy.
 */
function assertJsonSafe(value: unknown, path: string): void {
  if (value === undefined) throw new Error(`Non-JSON-safe value at ${path}: undefined`);
  if (typeof value === 'function') throw new Error(`Non-JSON-safe value at ${path}: function`);
  if (typeof value === 'bigint') throw new Error(`Non-JSON-safe value at ${path}: bigint`);
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Non-JSON-safe value at ${path}: ${String(value)}`);
  }
}

/**
 * Recursively sort object keys for deterministic JSON output.
 * Arrays keep their domain order. Maps/Sets are NOT handled here —
 * callers convert those to sorted arrays before calling this.
 */
function sortKeysDeep(value: unknown, path: string): unknown {
  assertJsonSafe(value, path);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => sortKeysDeep(item, `${path}[${String(i)}]`));
  }
  const obj = value as Record<string, unknown>;
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortKeysDeep(obj[key], `${path}.${key}`);
      return acc;
    }, {});
}

/**
 * Canonical serialization of ProjectionState for integrity checksums.
 * Same logical state always produces the same string regardless of
 * Map/Set insertion order.
 *
 * Canonicalization rules:
 * - Maps → [[key, value], ...] sorted by key string
 * - Sets → sorted array of elements
 * - entityFamilyMemberships → sorted by `${entityId}|${familyId}`
 * - All nested objects → recursively sorted by key
 */
const codeUnitCompare = (a: string, b: string): number => {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
};

export function canonicalSerializeProjectionState(state: ProjectionState): string {
  const s = (v: unknown, p: string) => sortKeysDeep(v, p);
  const mapToSorted = <V>(m: Map<string, V>, path: string) =>
    [...m.entries()].sort(([a], [b]) => codeUnitCompare(a, b)).map(([k, v]) => [k, s(v, `${path}.${k}`)]);
  const setToSorted = (set: Set<string>, path: string) => {
    const arr = [...set];
    arr.forEach((v, i) => { assertJsonSafe(v, `${path}[${String(i)}]`); });
    return arr.sort(codeUnitCompare);
  };
  const reverseIndexToSorted = (m: Map<string, Set<string>>, path: string) =>
    [...m.entries()].sort(([a], [b]) => codeUnitCompare(a, b)).map(([k, v]) => [k, setToSorted(v, `${path}.${k}`)]);

  const canonical = {
    lastAppliedSeq: state.lastAppliedSeq,
    entities: mapToSorted(state.entities, 'entities'),
    claims: mapToSorted(state.claims, 'claims'),
    claimObservations: mapToSorted(state.claimObservations, 'claimObservations'),
    claimReconciliations: mapToSorted(state.claimReconciliations, 'claimReconciliations'),
    observationToClaimId: mapToSorted(state.observationToClaimId, 'observationToClaimId'),
    observationsByClaimId: reverseIndexToSorted(state.observationsByClaimId, 'observationsByClaimId'),
    claimRelations: mapToSorted(state.claimRelations, 'claimRelations'),
    contradictions: mapToSorted(state.contradictions, 'contradictions'),
    evidence: mapToSorted(state.evidence, 'evidence'),
    sources: mapToSorted(state.sources, 'sources'),
    gaps: mapToSorted(state.gaps, 'gaps'),
    families: mapToSorted(state.families, 'families'),
    threads: mapToSorted(state.threads, 'threads'),
    researchRuns: mapToSorted(state.researchRuns, 'researchRuns'),
    claimRelationsByFromClaimId: reverseIndexToSorted(state.claimRelationsByFromClaimId, 'claimRelationsByFromClaimId'),
    claimRelationsByToClaimId: reverseIndexToSorted(state.claimRelationsByToClaimId, 'claimRelationsByToClaimId'),
    evidenceByClaimId: reverseIndexToSorted(state.evidenceByClaimId, 'evidenceByClaimId'),
    claimsByFamilyId: reverseIndexToSorted(state.claimsByFamilyId, 'claimsByFamilyId'),
    threadsByFamilyId: reverseIndexToSorted(state.threadsByFamilyId, 'threadsByFamilyId'),
    entityFamilyMemberships: [...state.entityFamilyMemberships]
      .sort((a, b) => codeUnitCompare(`${a.entityId}|${a.familyId}`, `${b.entityId}|${b.familyId}`))
      .map((m, i) => s(m, `entityFamilyMemberships[${String(i)}]`) as Record<string, unknown>),
    entityFamilyKeys: setToSorted(state.entityFamilyKeys, 'entityFamilyKeys'),
    rolledBackRuns: setToSorted(state.rolledBackRuns, 'rolledBackRuns'),
    entityMergeHistory: mapToSorted(state.entityMergeHistory, 'entityMergeHistory'),
    familyMergeHistory: mapToSorted(state.familyMergeHistory, 'familyMergeHistory'),
  };

  return JSON.stringify(canonical);
}
