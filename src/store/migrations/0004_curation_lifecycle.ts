import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import type { Migration } from './types.js';

const DDL = `
ALTER TABLE rm_claims ADD COLUMN curation_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE rm_claims ADD COLUMN merged_into_claim_id TEXT;
ALTER TABLE rm_claim_observations ADD COLUMN curation_status TEXT NOT NULL DEFAULT 'active';
CREATE INDEX idx_rm_claims_curation_family_last ON rm_claims(curation_status, family_id, last_seen_at DESC, id);`;

function up(db: BetterSqliteDatabase): void { db.exec(DDL); }
const CHECKSUM = 'sha256:' + crypto.createHash('sha256').update('0004_curation_lifecycle:' + DDL).digest('hex');
export const migration0004: Migration = { version: 4, name: 'curation_lifecycle', checksum: CHECKSUM, up };
