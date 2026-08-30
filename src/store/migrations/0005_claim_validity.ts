import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import type { Migration } from './types.js';

const DDL = `
ALTER TABLE rm_claims ADD COLUMN valid_at TEXT;
ALTER TABLE rm_claims ADD COLUMN expired_at TEXT;
UPDATE rm_claims SET valid_at = COALESCE(first_seen_at, last_seen_at) WHERE valid_at IS NULL;
CREATE INDEX idx_rm_claims_family_expired_last ON rm_claims(family_id, expired_at, last_seen_at DESC, id);`;

function up(db: BetterSqliteDatabase): void {
  db.exec(DDL);
}

const CHECKSUM = 'sha256:' + crypto.createHash('sha256').update('0005_claim_validity:' + DDL).digest('hex');
export const migration0005: Migration = { version: 5, name: 'claim_validity', checksum: CHECKSUM, up };
