/**
 * Knowledge tool handler — read/query surface over the materialized ProjectionState.
 * All actions are pure reads: no mutations, no I/O.
 *
 * SQL fast-path: claims and evidence actions route through KnowledgeQueryService
 * when the read model is ready. Dirty-model fallback uses ProjectionState.
 */

import type { ProjectionState } from '../store/projectionState.js';
import type { KnowledgeToolInput } from './schemas.js';
import type { KnowledgeQueryService } from '../query/service.js';
import type { queryEvents as queryEventsFn, queryEvidenceLinkedEventsByClaimId as queryEvidenceLinkedEventsByClaimIdFn } from '../store/events.js';
import { ReadModelUnavailableError } from '../query/errors.js';
import { getFamilyById, listFamilies, getThreadsByFamily } from '../workspace/queries.js';
import {
  getClaimsByFamily,
  getEvidenceForClaim,
  getContradictionsByFamily,
  getGapsByFamily,
  getEntityById,
  findEntityByLabel,
} from '../graph/queries.js';
import {
  getBelief,
  getProvenance,
  getTimeline,
  getChanges,
  rankResearchNext,
  synthesizeFamilyView,
} from '../query/longitudinal.js';
import type { Claim, Evidence } from '../graph/types.js';

export interface KnowledgeToolDeps {
  getState(): ProjectionState;
  queryService: KnowledgeQueryService;
  queryEvents: typeof queryEventsFn;
  queryEvidenceLinkedEventsByClaimId?: typeof queryEvidenceLinkedEventsByClaimIdFn;
}

// ── SQL adapters (drain paginated results to flat arrays) ─────────

function drainClaims(
  qs: KnowledgeQueryService,
  opts: { familyId?: string; threadId?: string },
  maxCount?: number,
): { items: Claim[]; truncated: boolean } {
  const all: Claim[] = [];
  let cursor: string | undefined;
  for (;;) {
    const remaining = maxCount !== undefined ? maxCount - all.length : undefined;
    if (remaining !== undefined && remaining <= 0) break;
    const page = qs.listClaims({ ...opts, limit: Math.min(100, remaining ?? 100), ...(cursor !== undefined ? { cursor } : {}) });
    all.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  const truncated = maxCount !== undefined && all.length > maxCount;
  if (truncated) all.length = maxCount;
  return { items: all, truncated };
}

function drainEvidence(
  qs: KnowledgeQueryService,
  opts: { claimId: string },
  maxCount?: number,
): { items: Evidence[]; truncated: boolean } {
  const all: Evidence[] = [];
  let cursor: string | undefined;
  for (;;) {
    const remaining = maxCount !== undefined ? maxCount - all.length : undefined;
    if (remaining !== undefined && remaining <= 0) break;
    const page = qs.listEvidenceForClaim({ ...opts, limit: Math.min(100, remaining ?? 100), ...(cursor !== undefined ? { cursor } : {}) });
    all.push(...page.items);
    if (!page.nextCursor || page.items.length === 0) break;
    cursor = page.nextCursor;
  }
  const truncated = maxCount !== undefined && all.length > maxCount;
  if (truncated) all.length = maxCount;
  return { items: all, truncated };
}

export function handleKnowledgeTool(
  input: KnowledgeToolInput,
  deps: KnowledgeToolDeps,
): Record<string, unknown> {
  switch (input.action) {
    case 'families': {
      const state = deps.getState();
      if (input.familyId) {
        const family = getFamilyById(state, input.familyId);
        return family
          ? { found: true, family: serialize(family) }
          : { found: false, error: `Family not found: ${input.familyId}` };
      }
      return { families: listFamilies(state).map(serialize) };
    }

    case 'threads': {
      const state = deps.getState();
      const threads = getThreadsByFamily(state, input.familyId);
      return { familyId: input.familyId, threads: threads.map(serialize) };
    }

    case 'claims': {
      let claims: Claim[];
      let truncated = false;
      try {
        const opts: { familyId?: string; threadId?: string } = { familyId: input.familyId };
        if (input.threadId !== undefined) opts.threadId = input.threadId;
        const drained = drainClaims(deps.queryService, opts);
        claims = drained.items;
        truncated = drained.truncated;
      } catch (err) {
        if (err instanceof ReadModelUnavailableError) {
          const state = deps.getState();
          const allClaims = getClaimsByFamily(state, input.familyId);
          claims = input.threadId !== undefined
            ? allClaims.filter((c) => c.threadId === input.threadId)
            : allClaims;
        } else {
          throw err;
        }
      }
      return { familyId: input.familyId, threadId: input.threadId, claims: claims.map(serialize), ...(truncated ? { truncated: true } : {}) };
    }

    case 'evidence': {
      let evidence: Evidence[];
      let truncated = false;
      try {
        const drained = drainEvidence(deps.queryService, { claimId: input.claimId });
        evidence = drained.items;
        truncated = drained.truncated;
      } catch (err) {
        if (err instanceof ReadModelUnavailableError) {
          const state = deps.getState();
          evidence = getEvidenceForClaim(state, input.claimId);
        } else {
          throw err;
        }
      }
      return { claimId: input.claimId, evidence: evidence.map(serialize), ...(truncated ? { truncated: true } : {}) };
    }

    case 'contradictions': {
      const state = deps.getState();
      const contradictions = getContradictionsByFamily(state, input.familyId);
      return { familyId: input.familyId, contradictions: contradictions.map(serialize) };
    }

    case 'gaps': {
      const state = deps.getState();
      const gaps = getGapsByFamily(state, input.familyId);
      return { familyId: input.familyId, gaps: gaps.map(serialize) };
    }

    case 'entity': {
      const state = deps.getState();
      if (input.entityId) {
        const entity = getEntityById(state, input.entityId);
        return entity
          ? { found: true, entity: serialize(entity) }
          : { found: false, error: `Entity not found: ${input.entityId}` };
      }
      if (input.label) {
        const entity = findEntityByLabel(state, input.label);
        return entity
          ? { found: true, entity: serialize(entity) }
          : { found: false, error: `No entity with label: ${input.label}` };
      }
      return { error: 'Either entityId or label must be provided' };
    }

    case 'belief': {
      const state = deps.getState();
      const belief = getBelief(state, input.claimId);
      return belief
        ? { found: true, belief: serialize(belief) }
        : { found: false, error: `Claim not found: ${input.claimId}` };
    }

    case 'why': {
      const state = deps.getState();
      const provenance = getProvenance(state, input.claimId);
      return provenance
        ? { found: true, provenance: serialize(provenance) }
        : { found: false, error: `Claim not found: ${input.claimId}` };
    }

    case 'timeline': {
      // timeline reads raw event log — no projection needed
      const target: { claimId?: string; sourceId?: string; contradictionId?: string; gapId?: string } = {};
      if (input.claimId?.trim()) target.claimId = input.claimId.trim();
      if (input.sourceId?.trim()) target.sourceId = input.sourceId.trim();
      if (input.contradictionId?.trim()) target.contradictionId = input.contradictionId.trim();
      if (input.gapId?.trim()) target.gapId = input.gapId.trim();
      if (!target.claimId && !target.sourceId && !target.contradictionId && !target.gapId) {
        return { error: 'Either claimId, sourceId, contradictionId, or gapId must be provided' };
      }
      const timelineOpts = input.limit !== undefined ? { limit: input.limit } : undefined;
      const entries = getTimeline({ queryEvents: deps.queryEvents, ...(deps.queryEvidenceLinkedEventsByClaimId !== undefined ? { queryEvidenceLinkedEventsByClaimId: deps.queryEvidenceLinkedEventsByClaimId } : {}) }, target, timelineOpts);
      return { entries };
    }

    case 'changes': {
      // changes needs projection only for family resolution (familyId present)
      let state: ProjectionState | undefined;
      if (input.familyId !== undefined) {
        state = deps.getState();
      }
      const changesOpts: { familyId?: string; limit?: number } = {};
      if (input.familyId !== undefined) changesOpts.familyId = input.familyId;
      if (input.limit !== undefined) changesOpts.limit = input.limit;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const depsObj: { queryEvents: any; state?: ProjectionState } = { queryEvents: deps.queryEvents };
      if (state !== undefined) depsObj.state = state;
      const changeSet = getChanges(depsObj, input.sinceSeq, changesOpts);
      return { changeSet: serialize(changeSet) };
    }

    case 'research-next': {
      const state = deps.getState();
      const ranked = rankResearchNext(state, input.familyId);
      return { familyId: input.familyId, researchNext: ranked };
    }

    case 'family-view': {
      const state = deps.getState();
      const familyView = synthesizeFamilyView(state, input.familyId);
      return familyView
        ? { found: true, familyView: serialize(familyView) }
        : { found: false, error: `Family not found: ${input.familyId}` };
    }
  }
}

/** Serialize Map/Set values to JSON-safe structures. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serialize(obj: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v instanceof Map) {
      out[k] = Object.fromEntries(v);
    } else if (v instanceof Set) {
      out[k] = [...v];
    } else {
      out[k] = v;
    }
  }
  return out;
}
