import type { Claim, ClaimObservation, ClaimRelation, Evidence, Source } from '../../graph/types.js';

const json = (value: unknown): string => JSON.stringify(value);
export function serializeClaim(value: Claim) {
  return { id: value.id, curation_status: value.curationStatus ?? 'active', merged_into_claim_id: value.mergedIntoClaimId ?? null, family_id: value.familyId, thread_id: value.threadId ?? null, subject_entity_id: value.subjectEntityId ?? null, subject_text: value.subjectText, predicate: value.predicate, object_entity_id: value.objectEntityId ?? null, object_text: value.objectText ?? null, canonical_subject: value.canonicalKey.subject, canonical_predicate: value.canonicalKey.predicate, quantifier_canonical: value.canonicalKey.quantifierCanonical ?? null, polarity: value.polarity, hedge: value.hedge, evidence_type: value.evidenceType, confidence: value.confidence, epistemic_status: value.epistemicStatus ?? null, contradiction_state: value.contradictionState, current_observation_id: value.currentObservationId ?? null, first_seen_run_id: value.firstSeenRunId, first_seen_at: value.firstSeenAt ?? null, last_seen_run_id: value.lastSeenRunId, last_seen_at: value.lastSeenAt ?? null, observation_count: value.observationCount ?? 0, supporting_evidence_count: value.supportingEvidenceCount ?? 0, opposing_evidence_count: value.opposingEvidenceCount ?? 0, valid_at: value.validAt ?? null, expired_at: value.expiredAt ?? null, payload_json: json(value) };
}
export function serializeClaimObservation(value: ClaimObservation, claimId: string) {
  return { id: value.id, curation_status: value.curationStatus ?? 'active', claim_id: claimId, family_id: value.familyId, thread_id: value.threadId ?? null, run_id: value.runId, observed_at: value.observedAt, subject_text: value.subjectText, predicate: value.predicate, object_text: value.objectText ?? null, polarity: value.polarity, hedge: value.hedge, confidence: value.confidence, payload_json: json(value) };
}
export function serializeSource(value: Source) {
  return { id: value.id, canonical_url: value.canonicalUrl, url: value.url, title: value.title ?? null, domain: value.domain, source_type: value.sourceType, authority_class: value.authorityClass ?? null, quality_score: value.qualityScore ?? null, is_primary: value.isPrimary ? 1 : 0, extraction_status: value.extractionStatus, usage_status: value.usageStatus ?? null, content_hash: value.contentHash ?? null, retrieved_at: value.retrievedAt, published_at: value.publishedAt ?? null, first_seen_run_id: value.firstSeenRunId, last_seen_run_id: value.lastSeenRunId, last_seen_at: value.lastSeenAt, run_count: value.runCount, payload_json: json(value) };
}
export function serializeEvidence(value: Evidence) {
  return { id: value.id, claim_id: value.claimId, source_id: value.sourceId, observation_id: value.observationId ?? null, stance: value.stance ?? null, run_id: value.runId, excerpt: value.excerpt ?? null, alignment_score: value.alignment?.score ?? null, payload_json: json(value) };
}
export function serializeClaimRelation(value: ClaimRelation) {
  return { id: value.id, from_claim_id: value.fromClaimId, to_claim_id: value.toClaimId, relation: value.relation, strength: value.strength, score: value.score, run_id: value.runId, payload_json: json(value) };
}
