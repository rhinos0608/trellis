import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import type { Migration } from './types.js';

const DDL = `
CREATE TABLE rm_state (
  model_name TEXT PRIMARY KEY, model_version INTEGER NOT NULL CHECK(model_version > 0),
  last_applied_seq INTEGER NOT NULL CHECK(last_applied_seq >= 0),
  status TEXT NOT NULL CHECK(status IN ('ready', 'dirty')), updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE rm_claims (
  id TEXT PRIMARY KEY, family_id TEXT NOT NULL, thread_id TEXT, subject_entity_id TEXT, subject_text TEXT NOT NULL, predicate TEXT NOT NULL,
  object_entity_id TEXT, object_text TEXT, canonical_subject TEXT NOT NULL, canonical_predicate TEXT NOT NULL, quantifier_canonical TEXT,
  polarity TEXT NOT NULL, hedge TEXT NOT NULL, evidence_type TEXT NOT NULL, confidence REAL NOT NULL, epistemic_status TEXT, contradiction_state TEXT NOT NULL,
  current_observation_id TEXT, first_seen_run_id TEXT NOT NULL, first_seen_at TEXT, last_seen_run_id TEXT NOT NULL, last_seen_at TEXT, observation_count INTEGER NOT NULL,
  supporting_evidence_count INTEGER NOT NULL, opposing_evidence_count INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX idx_rm_claims_family_last ON rm_claims(family_id, last_seen_at DESC, id);
CREATE INDEX idx_rm_claims_thread_last ON rm_claims(thread_id, last_seen_at DESC, id);
CREATE INDEX idx_rm_claims_epistemic ON rm_claims(family_id, epistemic_status, contradiction_state);
CREATE INDEX idx_rm_claims_canonical ON rm_claims(family_id, canonical_subject, canonical_predicate);
CREATE TABLE rm_claim_observations (
  id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, family_id TEXT NOT NULL, thread_id TEXT, run_id TEXT NOT NULL, observed_at TEXT NOT NULL,
  subject_text TEXT NOT NULL, predicate TEXT NOT NULL, object_text TEXT, polarity TEXT NOT NULL, hedge TEXT NOT NULL, confidence REAL NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX idx_rm_observations_claim_time ON rm_claim_observations(claim_id, observed_at, id);
CREATE INDEX idx_rm_observations_family_time ON rm_claim_observations(family_id, observed_at DESC, id);
CREATE INDEX idx_rm_observations_run ON rm_claim_observations(run_id, id);
CREATE TABLE rm_sources (
  id TEXT PRIMARY KEY, canonical_url TEXT NOT NULL UNIQUE, url TEXT NOT NULL, title TEXT, domain TEXT NOT NULL, source_type TEXT NOT NULL,
  authority_class TEXT, quality_score REAL, is_primary INTEGER NOT NULL CHECK(is_primary IN (0, 1)), extraction_status TEXT NOT NULL, usage_status TEXT,
  content_hash TEXT, retrieved_at TEXT NOT NULL, published_at TEXT, first_seen_run_id TEXT NOT NULL, last_seen_run_id TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  run_count INTEGER NOT NULL CHECK(run_count >= 1), payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX idx_rm_sources_domain_last ON rm_sources(domain, last_seen_at DESC, id);
CREATE INDEX idx_rm_sources_type_last ON rm_sources(source_type, last_seen_at DESC, id);
CREATE INDEX idx_rm_sources_hash ON rm_sources(content_hash);
CREATE TABLE rm_evidence (
  id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, source_id TEXT NOT NULL, observation_id TEXT, stance TEXT, run_id TEXT NOT NULL, excerpt TEXT, alignment_score REAL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX idx_rm_evidence_claim ON rm_evidence(claim_id, id);
CREATE INDEX idx_rm_evidence_source ON rm_evidence(source_id, id);
CREATE INDEX idx_rm_evidence_observation ON rm_evidence(observation_id, id);
CREATE INDEX idx_rm_evidence_run ON rm_evidence(run_id, id);
CREATE TABLE rm_claim_relations (
  id TEXT PRIMARY KEY, from_claim_id TEXT NOT NULL, to_claim_id TEXT NOT NULL, relation TEXT NOT NULL, strength TEXT NOT NULL, score REAL NOT NULL, run_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX idx_rm_relations_from ON rm_claim_relations(from_claim_id, relation);
CREATE INDEX idx_rm_relations_to ON rm_claim_relations(to_claim_id, relation);
CREATE INDEX idx_rm_relations_run ON rm_claim_relations(run_id, id);
CREATE VIRTUAL TABLE rm_claims_fts USING fts5(subject_text, predicate, object_text, content='rm_claims', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE rm_sources_fts USING fts5(title, url, domain, content='rm_sources', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER rm_claims_fts_ai AFTER INSERT ON rm_claims BEGIN INSERT INTO rm_claims_fts(rowid, subject_text, predicate, object_text) VALUES (new.rowid, new.subject_text, new.predicate, new.object_text); END;
CREATE TRIGGER rm_claims_fts_ad AFTER DELETE ON rm_claims BEGIN INSERT INTO rm_claims_fts(rm_claims_fts, rowid, subject_text, predicate, object_text) VALUES ('delete', old.rowid, old.subject_text, old.predicate, old.object_text); END;
CREATE TRIGGER rm_claims_fts_au AFTER UPDATE ON rm_claims BEGIN INSERT INTO rm_claims_fts(rm_claims_fts, rowid, subject_text, predicate, object_text) VALUES ('delete', old.rowid, old.subject_text, old.predicate, old.object_text); INSERT INTO rm_claims_fts(rowid, subject_text, predicate, object_text) VALUES (new.rowid, new.subject_text, new.predicate, new.object_text); END;
CREATE TRIGGER rm_sources_fts_ai AFTER INSERT ON rm_sources BEGIN INSERT INTO rm_sources_fts(rowid, title, url, domain) VALUES (new.rowid, new.title, new.url, new.domain); END;
CREATE TRIGGER rm_sources_fts_ad AFTER DELETE ON rm_sources BEGIN INSERT INTO rm_sources_fts(rm_sources_fts, rowid, title, url, domain) VALUES ('delete', old.rowid, old.title, old.url, old.domain); END;
CREATE TRIGGER rm_sources_fts_au AFTER UPDATE ON rm_sources BEGIN INSERT INTO rm_sources_fts(rm_sources_fts, rowid, title, url, domain) VALUES ('delete', old.rowid, old.title, old.url, old.domain); INSERT INTO rm_sources_fts(rowid, title, url, domain) VALUES (new.rowid, new.title, new.url, new.domain); END;`;

function up(db: BetterSqliteDatabase): void {
  db.exec(DDL);
  db.prepare("INSERT INTO rm_state (model_name, model_version, last_applied_seq, status, updated_at) VALUES ('knowledge', 1, 0, 'dirty', ?)").run(new Date().toISOString());
}

const CHECKSUM = 'sha256:' + crypto.createHash('sha256').update('0002_durable_knowledge_read_model:' + DDL).digest('hex');
export const migration0002: Migration = { version: 2, name: 'durable_knowledge_read_model', checksum: CHECKSUM, up };
