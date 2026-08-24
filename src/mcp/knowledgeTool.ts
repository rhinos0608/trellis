/**
 * Knowledge tool handler — read/query surface over the materialized ProjectionState.
 * All actions are pure reads: no mutations, no I/O.
 */

import type { ProjectionState } from '../store/projectionState.js';
import type { KnowledgeToolInput } from './schemas.js';
import { getFamilyById, listFamilies, getThreadsByFamily } from '../workspace/queries.js';
import {
  getClaimsByFamily,
  getEvidenceForClaim,
  getContradictionsByFamily,
  getGapsByFamily,
  getEntityById,
  findEntityByLabel,
} from '../graph/queries.js';

export function handleKnowledgeTool(
  input: KnowledgeToolInput,
  state: ProjectionState,
): Record<string, unknown> {
  switch (input.action) {
    case 'families': {
      if (input.familyId) {
        const family = getFamilyById(state, input.familyId);
        return family
          ? { found: true, family: serialize(family) }
          : { found: false, error: `Family not found: ${input.familyId}` };
      }
      return { families: listFamilies(state).map(serialize) };
    }

    case 'threads': {
      const threads = getThreadsByFamily(state, input.familyId);
      return { familyId: input.familyId, threads: threads.map(serialize) };
    }

    case 'claims': {
      const allClaims = getClaimsByFamily(state, input.familyId);
      const claims = input.threadId
        ? allClaims.filter((c) => c.threadId === input.threadId)
        : allClaims;
      return { familyId: input.familyId, threadId: input.threadId, claims: claims.map(serialize) };
    }

    case 'evidence': {
      const evidence = getEvidenceForClaim(state, input.claimId);
      return { claimId: input.claimId, evidence: evidence.map(serialize) };
    }

    case 'contradictions': {
      const contradictions = getContradictionsByFamily(state, input.familyId);
      return { familyId: input.familyId, contradictions: contradictions.map(serialize) };
    }

    case 'gaps': {
      const gaps = getGapsByFamily(state, input.familyId);
      return { familyId: input.familyId, gaps: gaps.map(serialize) };
    }

    case 'entity': {
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
