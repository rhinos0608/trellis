import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import type { Migration } from './types.js';

/**
 * Migration 0003: envelope-level actor identity.
 *
 * Adds a nullable `events.actor_id` column (WHO within the actor kind,
 * e.g. actor='user', actor_id='operator-jane') plus the same (col, seq)
 * index pattern 0001 uses for entity_id/batch_id. Existing rows get NULL —
 * purely additive and replay-safe.
 */

const DDL = `
ALTER TABLE events ADD COLUMN actor_id TEXT;
CREATE INDEX idx_events_actor_seq ON events(actor_id, seq);`;

function up(db: BetterSqliteDatabase): void {
  db.exec(DDL);
}

const CHECKSUM = 'sha256:' + crypto.createHash('sha256').update('0003_event_actor_identity:' + DDL).digest('hex');
export const migration0003: Migration = { version: 3, name: 'event_actor_identity', checksum: CHECKSUM, up };
