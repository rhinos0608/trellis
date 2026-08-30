/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions */
/**
 * Event payload decoding and validation.
 *
 * decodeEventPayload validates event type, version, and payload shape,
 * applying the upcast chain when storedVersion < latestVersion.
 */
import type { TrellisEventType } from './eventTypes.js';
import type { ProjectionState } from './projectionState.js';
import { EventReferenceInvalidError } from './eventErrors.js';
import { EVENT_CODECS } from './eventSchemas/registry.js';
import {
  EventTypeUnknownError,
  EventVersionUnsupportedError,
  EventPayloadInvalidError,
  type ZodIssueSummary,
} from './eventErrors.js';

export interface DecodedPayload {
  eventType: TrellisEventType;
  storedVersion: number;
  latestVersion: number;
  payload: unknown;
}

/** All valid event type strings (from EVENT_CODECS keys — matches decodeEventPayload's lookup). */
const VALID_EVENT_TYPES = new Set<string>(Object.keys(EVENT_CODECS));

export function decodeEventPayload(
  eventType: string,
  storedVersion: number,
  rawPayload: unknown,
): DecodedPayload {
  // 1. Validate event type
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new EventTypeUnknownError(eventType);
  }

  const typedEventType = eventType as TrellisEventType;
  const codec = EVENT_CODECS[typedEventType];

  // 2. Validate version exists
  if (!(storedVersion in codec.versions)) {
    throw new EventVersionUnsupportedError(
      typedEventType,
      storedVersion,
      codec.latestVersion,
    );
  }

  // 3. Parse with version schema
  const versionCodec = codec.versions[storedVersion];
  if (!versionCodec) {
    throw new EventVersionUnsupportedError(typedEventType, storedVersion, codec.latestVersion);
  }
  let payload: unknown;
  try {
    payload = versionCodec.schema.parse(rawPayload);
  } catch (err: unknown) {
    const issues = extractZodIssues(err);
    throw new EventPayloadInvalidError(typedEventType, storedVersion, issues);
  }

  // 4. Apply upcast chain if storedVersion < latestVersion
  if (storedVersion < codec.latestVersion) {
    for (let v = storedVersion; v < codec.latestVersion; v++) {
      const currentCodec = codec.versions[v];
      const nextCodec = codec.versions[v + 1];
      if (!currentCodec || !nextCodec) {
        throw new EventVersionUnsupportedError(typedEventType, v, codec.latestVersion);
      }

      // Re-validate with next version's schema after upcast
      if (currentCodec.upcast) {
        payload = currentCodec.upcast(payload);
      }

      try {
        payload = nextCodec.schema.parse(payload);
      } catch (err: unknown) {
        const issues = extractZodIssues(err);
        throw new EventPayloadInvalidError(typedEventType, v + 1, issues);
      }
    }
  }

  return {
    eventType: typedEventType,
    storedVersion,
    latestVersion: codec.latestVersion,
    payload,
  };
}

export function validateEventReferences(eventType: string, payload: any, state: ProjectionState): void {
  const missing = (ref: string) => { throw new EventReferenceInvalidError(eventType, ref); };
  const family = (id: string) => { if (!state.families.has(id)) missing(`family ${id}`); };
  const claim = (id: string) => { if (!state.claims.has(id)) missing(`claim ${id}`); };
  const entity = (id: string) => { if (!state.entities.has(id)) missing(`entity ${id}`); };
  const thread = (id: string, familyId?: string) => { const t = state.threads.get(id); if (!t) missing(`thread ${id}`); if (familyId && t?.familyId !== familyId) missing(`thread ${id} family`); };
  switch (eventType) {
    case 'CLAIM_OBSERVED': family(payload.observation.familyId); if (payload.observation.threadId !== undefined) thread(payload.observation.threadId, payload.observation.familyId); if (payload.reconciliation.matchedClaimId !== undefined) claim(payload.reconciliation.matchedClaimId); if (payload.observation.subjectEntityId !== undefined) entity(payload.observation.subjectEntityId); if (payload.observation.objectEntityId !== undefined) entity(payload.observation.objectEntityId); break;
    case 'CLAIM_ACCEPTED': family(payload.familyId); if (payload.threadId !== undefined) thread(payload.threadId, payload.familyId); if (payload.subjectEntityId !== undefined) entity(payload.subjectEntityId); if (payload.objectEntityId !== undefined) entity(payload.objectEntityId); break;
    case 'EVIDENCE_LINKED': claim(payload.claimId); if (!state.sources.has(payload.sourceId)) missing(`source ${payload.sourceId}`); break;
    case 'EDGE_ADDED': claim(payload.fromClaimId); claim(payload.toClaimId); break;
    case 'CONTRADICTION_IDENTIFIED': family(payload.familyId); claim(payload.claimIdA); claim(payload.claimIdB); if (state.claims.get(payload.claimIdA)?.familyId !== payload.familyId || state.claims.get(payload.claimIdB)?.familyId !== payload.familyId) missing('contradiction family'); break;
    case 'GAP_OPENED': family(payload.familyId); if (payload.threadId !== undefined) thread(payload.threadId, payload.familyId); if (payload.relatedClaimId !== undefined) { claim(payload.relatedClaimId); if (state.claims.get(payload.relatedClaimId)?.familyId !== payload.familyId) missing('gap claim family'); } if (payload.relatedContradictionId !== undefined && !state.contradictions.has(payload.relatedContradictionId)) missing(`contradiction ${payload.relatedContradictionId}`); break;
    case 'THREAD_CREATED': family(payload.familyId); { const t = state.threads.get(payload.threadId); if (t && t.familyId !== payload.familyId) missing(`thread ${payload.threadId} family`); } break;
    case 'THREAD_RESOLVED': thread(payload.threadId, payload.familyId); break;
    case 'RUN_STARTED': family(payload.familyId); if (payload.threadId !== undefined) thread(payload.threadId, payload.familyId); break;
    case 'RUN_QUEUED': family(payload.familyId); if (payload.threadId !== undefined) thread(payload.threadId, payload.familyId); break;
    case 'NODE_RELABELED': case 'NODE_METADATA_UPDATED': case 'EXTRACTION_CONFIDENCE_REVISED': entity(payload.targetId); break;
    case 'RELATIONSHIP_STRENGTH_REVISED': entity(payload.targetId); break;
    case 'EDGE_REMOVED': if (!state.claimRelations.has(payload.edgeId)) missing(`edge ${payload.edgeId}`); break;
    case 'SOURCE_CHANGED': case 'SOURCE_RETRACTED': case 'SOURCE_READ': if (!state.sources.has(payload.sourceId)) missing(`source ${payload.sourceId}`); break;
    case 'CONTRADICTION_RESOLVED': if (!state.contradictions.has(payload.contradictionId)) missing(`contradiction ${payload.contradictionId}`); break;
    case 'GAP_RESOLVED': if (!state.gaps.has(payload.gapId)) missing(`gap ${payload.gapId}`); break;
    case 'FAMILY_RENAMED': family(payload.targetId); break;
    case 'FAMILY_CLASSIFIED': entity(payload.entity_id); family(payload.family_id); break;
    case 'FAMILY_RELATED': case 'FAMILY_RELATION_REMOVED': family(payload.family_a); family(payload.family_b); if (payload.family_a === payload.family_b) missing('families must differ'); break;
    case 'FAMILY_MERGED': family(payload.survivorFamilyId); for (const id of payload.mergedFamilyIds) family(id); break;
    case 'ENTITY_MERGED': entity(payload.survivorId); for (const id of payload.mergedIds) entity(id); break;
    case 'ENTITY_SPLIT': entity(payload.originalId); break;
    case 'CLAIM_MERGED': claim(payload.sourceClaimId); claim(payload.survivorClaimId); break;
    case 'CLAIM_SPLIT': claim(payload.sourceClaimId); for (const result of payload.results) { for (const id of result.observationIds) if (!state.claimObservations.has(id)) missing(`observation ${id}`); for (const id of result.evidenceIds) if (!state.evidence.has(id)) missing(`evidence ${id}`); } break;
    case 'CLAIM_RETRACTION_SET': if (payload.target.kind === 'claim') claim(payload.target.id); else if (!state.claimObservations.has(payload.target.id)) missing(`observation ${payload.target.id}`); break;
    case 'CLAIM_RELATION_CURATED': if (payload.after) { claim(payload.after.fromClaimId); claim(payload.after.toClaimId); } break;
    case 'EVIDENCE_STANCE_OVERRIDDEN': if (!state.evidence.has(payload.evidenceId)) missing(`evidence ${payload.evidenceId}`); claim(payload.claimId); break;
    case 'CLAIM_EXPIRED': claim(payload.claimId); break;
  }
}

export function validateProjectionReferences(state: ProjectionState): void {
  for (const claim of state.claims.values()) {
    if (!state.families.has(claim.familyId)) throw new EventReferenceInvalidError('PROJECTION', `claim family ${claim.familyId}`);
    if (claim.threadId !== undefined && state.threads.get(claim.threadId)?.familyId !== claim.familyId) throw new EventReferenceInvalidError('PROJECTION', `claim thread ${claim.threadId} family`);
  }
  for (const evidence of state.evidence.values()) if (!state.claims.has(evidence.claimId)) throw new EventReferenceInvalidError('PROJECTION', `evidence claim ${evidence.claimId}`);
  for (const relation of state.claimRelations.values()) if (!state.claims.has(relation.fromClaimId) || !state.claims.has(relation.toClaimId)) throw new EventReferenceInvalidError('PROJECTION', `relation ${relation.id}`);
  for (const thread of state.threads.values()) if (!state.families.has(thread.familyId)) throw new EventReferenceInvalidError('PROJECTION', `thread family ${thread.familyId}`);
}

function extractZodIssues(err: unknown): ZodIssueSummary[] {
  if (
    err !== null &&
    typeof err === 'object' &&
    'issues' in err &&
    Array.isArray(err.issues)
  ) {
    return (err as { issues: { path: (string | number)[]; message: string }[] }).issues.map(
      (issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }),
    );
  }
  return [{ path: '', message: err instanceof Error ? err.message : String(err) }];
}
