import { getDb } from '../db.js';
import { rebuildProjection } from '../projectionBuilder.js';
import type { EventHandlerRegistry } from '../projectionState.js';
import { serializeClaim, serializeClaimObservation, serializeClaimRelation, serializeEvidence, serializeSource } from './serializers.js';
import type { KnowledgeReadModelStatus } from './types.js';

export function rebuildKnowledgeReadModel(handlers: EventHandlerRegistry): KnowledgeReadModelStatus {
  const state = rebuildProjection(handlers, { forceGenesis: true });
  const db = getDb();
  if (db === null) throw new Error('Database is not initialized');
  const now = new Date().toISOString();
  const transaction = db.transaction(() => {
    db.exec('DELETE FROM rm_evidence; DELETE FROM rm_claim_relations; DELETE FROM rm_claim_observations; DELETE FROM rm_claims; DELETE FROM rm_sources;');
    const claimInsert = db.prepare(`INSERT INTO rm_claims (id,curation_status,merged_into_claim_id,family_id,thread_id,subject_entity_id,subject_text,predicate,object_entity_id,object_text,canonical_subject,canonical_predicate,quantifier_canonical,polarity,hedge,evidence_type,confidence,epistemic_status,contradiction_state,current_observation_id,first_seen_run_id,first_seen_at,last_seen_run_id,last_seen_at,observation_count,supporting_evidence_count,opposing_evidence_count,valid_at,expired_at,payload_json) VALUES (@id,@curation_status,@merged_into_claim_id,@family_id,@thread_id,@subject_entity_id,@subject_text,@predicate,@object_entity_id,@object_text,@canonical_subject,@canonical_predicate,@quantifier_canonical,@polarity,@hedge,@evidence_type,@confidence,@epistemic_status,@contradiction_state,@current_observation_id,@first_seen_run_id,@first_seen_at,@last_seen_run_id,@last_seen_at,@observation_count,@supporting_evidence_count,@opposing_evidence_count,@valid_at,@expired_at,@payload_json)`);
    const observationInsert = db.prepare(`INSERT INTO rm_claim_observations (id,curation_status,claim_id,family_id,thread_id,run_id,observed_at,subject_text,predicate,object_text,polarity,hedge,confidence,payload_json) VALUES (@id,@curation_status,@claim_id,@family_id,@thread_id,@run_id,@observed_at,@subject_text,@predicate,@object_text,@polarity,@hedge,@confidence,@payload_json)`);
    const sourceInsert = db.prepare(`INSERT INTO rm_sources (id,canonical_url,url,title,domain,source_type,authority_class,quality_score,is_primary,extraction_status,usage_status,content_hash,retrieved_at,published_at,first_seen_run_id,last_seen_run_id,last_seen_at,run_count,payload_json) VALUES (@id,@canonical_url,@url,@title,@domain,@source_type,@authority_class,@quality_score,@is_primary,@extraction_status,@usage_status,@content_hash,@retrieved_at,@published_at,@first_seen_run_id,@last_seen_run_id,@last_seen_at,@run_count,@payload_json)`);
    const evidenceInsert = db.prepare(`INSERT INTO rm_evidence (id,claim_id,source_id,observation_id,stance,run_id,excerpt,alignment_score,payload_json) VALUES (@id,@claim_id,@source_id,@observation_id,@stance,@run_id,@excerpt,@alignment_score,@payload_json)`);
    const relationInsert = db.prepare(`INSERT INTO rm_claim_relations (id,from_claim_id,to_claim_id,relation,strength,score,run_id,payload_json) VALUES (@id,@from_claim_id,@to_claim_id,@relation,@strength,@score,@run_id,@payload_json)`);
    for (const claim of state.claims.values()) claimInsert.run(serializeClaim(claim));
    for (const observation of state.claimObservations.values()) {
      const claimId = state.observationToClaimId.get(observation.id);
      if (claimId !== undefined) observationInsert.run(serializeClaimObservation(observation, claimId));
    }
    for (const source of state.sources.values()) sourceInsert.run(serializeSource(source));
    for (const evidence of state.evidence.values()) evidenceInsert.run(serializeEvidence(evidence));
    for (const relation of state.claimRelations.values()) relationInsert.run(serializeClaimRelation(relation));
    db.prepare("INSERT INTO rm_claims_fts(rm_claims_fts) VALUES ('rebuild')").run();
    db.prepare("INSERT INTO rm_sources_fts(rm_sources_fts) VALUES ('rebuild')").run();
    db.prepare("INSERT INTO rm_claims_fts(rm_claims_fts) VALUES ('integrity-check')").run();
    db.prepare("INSERT INTO rm_sources_fts(rm_sources_fts) VALUES ('integrity-check')").run();
    db.prepare("UPDATE rm_state SET status='ready', last_applied_seq=?, updated_at=? WHERE model_name='knowledge'").run(state.lastAppliedSeq, now);
  });
  transaction.immediate();
  return { version: 1, lastAppliedSeq: state.lastAppliedSeq, status: 'ready' };
}
