import type { EventEnvelope, TrellisEventType } from '../eventTypes.js';
import type { ProjectionState } from '../projectionState.js';

export interface ReadModelImpact {
  dirty?: boolean;
  claimIds?: string[];
  observationIds?: string[];
  sourceIds?: string[];
  evidenceIds?: string[];
  relationIds?: string[];
}
export type ReadModelImpactResolver = (event: EventEnvelope, state: ProjectionState) => ReadModelImpact;
const none: ReadModelImpactResolver = () => ({});
const p = (event: EventEnvelope): Record<string, unknown> => event.payload as Record<string, unknown>;
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const ids = (values: unknown[]): string[] => [...new Set(values.map(string).filter((v): v is string => v !== undefined))];
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const records = (value: unknown): Record<string, unknown>[] => array(value)
  .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null);

export const READ_MODEL_IMPACT = {
  RUN_STARTED: none, RUN_COMPLETED: none, RUN_FAILED: none, PROJECTION_REBUILT: none,
  NODE_ADDED: none, NODE_RELABELED: none, NODE_METADATA_UPDATED: none,
  EXTRACTION_CONFIDENCE_REVISED: none, RELATIONSHIP_STRENGTH_REVISED: none,
  ENTITY_MERGED: none, ENTITY_SPLIT: none, CONTRADICTION_FLAGGED: none,
  CLAIM_EXTRACTED: none, EXTRACTION_FAILED: none,
  SOURCE_ADDED: (e) => ({ sourceIds: ids([p(e).id]) }),
  SOURCE_CHANGED: (e) => ({ sourceIds: ids([p(e).sourceId]) }),
  SOURCE_RETRACTED: (e) => ({ sourceIds: ids([p(e).sourceId]) }),
  FAMILY_CLASSIFIED: none, FAMILY_CREATED: none, FAMILY_RELATED: none,
  FAMILY_RELATION_REMOVED: none, FAMILY_RENAMED: none, FAMILY_MERGED: none,
  RUN_ROLLED_BACK: () => ({ dirty: true }),
  FAMILY_RESOLVED: none, THREAD_CREATED: none, THREAD_RESOLVED: none,
  SOURCE_READ: (e) => ({ sourceIds: ids([p(e).sourceId]) }),
  SOURCE_OBSERVED: (e) => ({ sourceIds: ids([p(e).sourceId]) }),
  CLAIM_ACCEPTED: (e) => ({ claimIds: ids([p(e).id]), observationIds: ids([`obs_legacy_${String(p(e).id)}`]) }),
  CLAIM_OBSERVED: (e, state) => {
    const payload = p(e);
    const reconciliation = payload.reconciliation as { canonicalClaimId?: unknown; matchedClaimId?: unknown; classification?: unknown } | undefined;
    const observation = payload.observation as { id?: unknown } | undefined;
    const relationId = `rel_${e.id}`;
    const classification = string(reconciliation?.classification);
    const relationNeeded = state.claimRelations.has(relationId) || ['near_duplicate', 'elaboration', 'qualification', 'contradiction'].includes(classification ?? '');
    return {
      claimIds: ids([reconciliation?.canonicalClaimId, reconciliation?.matchedClaimId]),
      observationIds: ids([observation?.id]),
      ...(relationNeeded ? { relationIds: [relationId] } : {}),
    };
  },
  EVIDENCE_LINKED: (e) => ({ evidenceIds: ids([p(e).id]), claimIds: ids([p(e).claimId]) }),
  CONTRADICTION_IDENTIFIED: (e) => { const x = p(e); return { claimIds: ids([x.claimIdA, x.claimIdB]) }; },
  CONTRADICTION_RESOLVED: (e, state) => { const x = p(e); const c = state.contradictions.get(String(x.contradictionId)); return { claimIds: ids(c ? [c.claimIdA, c.claimIdB] : []) }; },
  GAP_OPENED: none, GAP_RESOLVED: none, SYNTHESIS_COMPLETED: none,
  RUN_CANCELLED: none, RUN_QUEUED: none, RUN_STARTING: none, RUN_RUNNING: none,
  RUN_PROGRESS: none, RUN_HEARTBEAT: none, RUN_CANCELLATION_REQUESTED: none, RUN_INTERRUPTED: none,
  EDGE_ADDED: (e) => ({ relationIds: ids([p(e).id]) }),
  EDGE_REMOVED: (e) => ({ relationIds: ids([p(e).edgeId]) }),
  // Curation events mutate claim/observation/evidence lifecycle state that the
  // read model cannot represent until their projection handlers land — force a
  // rebuild rather than let the read model silently go stale.
  CLAIM_MERGED: (e) => { const x = p(e); return { dirty: true, claimIds: ids([x.sourceClaimId, x.survivorClaimId]), observationIds: ids(Array.isArray(x.affectedObservationIds) ? x.affectedObservationIds : []), evidenceIds: ids(Array.isArray(x.affectedEvidenceIds) ? x.affectedEvidenceIds : []), relationIds: ids(Array.isArray(x.affectedRelationIds) ? x.affectedRelationIds : []) }; },
  CLAIM_SPLIT: (e) => { const x = p(e); const results = records(x.results); return { dirty: true, claimIds: ids([x.sourceClaimId, ...results.map((r) => r.claimId)]), observationIds: ids(results.flatMap((r) => array(r.observationIds))), evidenceIds: ids(results.flatMap((r) => array(r.evidenceIds))) }; },
  CLAIM_RETRACTION_SET: (e, state) => { const x = p(e); const target = x.target as Record<string, unknown> | undefined; if (target?.kind === 'claim') return { dirty: true, claimIds: ids([target.id]), observationIds: ids([...(state.observationsByClaimId.get(String(target.id)) ?? [])]) }; return { dirty: true, observationIds: ids([target?.id]), claimIds: ids([state.observationToClaimId.get(String(target?.id))]) }; },
  CLAIM_RELATION_CURATED: (e) => { const x = p(e); return { dirty: true, relationIds: ids([x.relationId]) }; },
  EVIDENCE_STANCE_OVERRIDDEN: (e) => { const x = p(e); return { dirty: true, evidenceIds: ids([x.evidenceId]), claimIds: ids([x.claimId]) }; },
  RESEARCH_PLAN_CREATED: none, RESEARCH_PLAN_REVISED: none,
  CLAIM_EXPIRED: (e) => ({ claimIds: ids([p(e).claimId]) }),
} satisfies Record<TrellisEventType, ReadModelImpactResolver>;
