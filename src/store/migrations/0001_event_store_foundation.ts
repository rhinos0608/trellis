/**
 * Migration 0001: Event store foundation.
 *
 * Creates the final events table with authoritative `seq` INTEGER PRIMARY KEY
 * AUTOINCREMENT, and a fresh projection_checkpoints table.
 *
 * Handles both fresh databases and legacy pre-Phase-0 databases (old schema
 * with TEXT PRIMARY KEY id, TEXT payload_hash allowing nulls, old indexes).
 *
 * Checksum is a hash of the final DDL text — any edit to the migration's
 * actual behavior changes this hash and is detected on re-open.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import type { Migration } from './types.js';

const FINAL_EVENTS_DDL = `
CREATE TABLE events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  timestamp     TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version >= 1),
  run_id        TEXT NOT NULL,
  batch_id      TEXT,
  actor         TEXT NOT NULL DEFAULT 'system'
                CHECK (actor IN ('system', 'user', 'classifier', 'rollback')),
  entity_id     TEXT,
  entity_type   TEXT,
  payload       TEXT NOT NULL,
  payload_hash  TEXT NOT NULL CHECK (length(payload_hash) = 64)
)`;

const FINAL_INDEXES = [
  'CREATE INDEX idx_events_run_seq      ON events(run_id, seq)',
  'CREATE INDEX idx_events_type_seq     ON events(event_type, seq)',
  'CREATE INDEX idx_events_entity_seq   ON events(entity_id, seq)',
  'CREATE INDEX idx_events_timestamp_seq ON events(timestamp, seq)',
  'CREATE INDEX idx_events_batch_seq    ON events(batch_id, seq)',
];

const CHECKPOINTS_DDL = `
CREATE TABLE projection_checkpoints (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  event_cursor       INTEGER NOT NULL CHECK(event_cursor > 0),
  projection_version INTEGER NOT NULL,
  schema_version     INTEGER NOT NULL,
  event_count        INTEGER NOT NULL,
  checksum           TEXT NOT NULL,
  compatible         INTEGER NOT NULL DEFAULT 1,
  snapshot_json      TEXT,
  rolled_back_run_ids TEXT
)`;

function hashPayload(payload: string): string {
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

interface OldEventRow {
  id: string;
  timestamp: string;
  event_type: string;
  event_version: number;
  run_id: string;
  batch_id: string | null;
  actor: string;
  entity_id: string | null;
  entity_type: string | null;
  payload: string;
  payload_hash: string | null;
}

function up(db: BetterSqliteDatabase): void {
  // Detect which case we're in
  const hasEventsTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'")
    .get();

  if (hasEventsTable === undefined) {
    // ── Fresh DB path ──
    db.exec(FINAL_EVENTS_DDL);
    for (const idx of FINAL_INDEXES) {
      db.exec(idx);
    }
    db.exec(CHECKPOINTS_DDL);
    return;
  }

  // Check if already migrated (seq column exists)
  const columns = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
  const hasSeq = columns.some((c) => c.name === 'seq');
  if (hasSeq) {
    // Already on new schema — nothing to do
    db.exec(CHECKPOINTS_DDL);
    return;
  }

  // ── Legacy DB path ──
  const oldCount = (db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt;

  db.exec(FINAL_EVENTS_DDL.replace('CREATE TABLE events (', 'CREATE TABLE events_new ('));

  // Copy rows in the old observable replay order
  const oldRows = db
    .prepare('SELECT * FROM events ORDER BY timestamp ASC, id ASC')
    .all() as OldEventRow[];

  const insertNew = db.prepare(`
    INSERT INTO events_new (id, timestamp, event_type, event_version, run_id, batch_id,
      actor, entity_id, entity_type, payload, payload_hash)
    VALUES (@id, @timestamp, @event_type, @event_version, @run_id, @batch_id,
      @actor, @entity_id, @entity_type, @payload, @payload_hash)
  `);

  for (const row of oldRows) {
    insertNew.run({
      id: row.id,
      timestamp: row.timestamp,
      event_type: row.event_type,
      event_version: row.event_version,
      run_id: row.run_id,
      batch_id: row.batch_id,
      actor: row.actor,
      entity_id: row.entity_id,
      entity_type: row.entity_type,
      payload: row.payload,
      // Recompute all payload_hashes — old schema had no CHECK(length=64),
      // so any value (including null or short strings) must be replaced.
      payload_hash: hashPayload(row.payload),
    });
  }

  // Verify count
  const newCount = (db.prepare('SELECT COUNT(*) as cnt FROM events_new').get() as { cnt: number }).cnt;
  if (oldCount !== newCount) {
    throw new Error(
      'Migration 0001 row count mismatch: old=' + String(oldCount) + ', new=' + String(newCount) + '. Aborting.',
    );
  }

  db.exec('DROP TABLE events');
  db.exec('ALTER TABLE events_new RENAME TO events');

  // Recreate indexes (indexes don't survive rename in all SQLite configs)
  for (const idx of FINAL_INDEXES) {
    db.exec(idx);
  }

  // Drop and recreate projection_checkpoints
  db.exec('DROP TABLE IF EXISTS projection_checkpoints');
  db.exec(CHECKPOINTS_DDL);

  // Sanity check
  const fkResult = db.pragma('foreign_key_check') as { rowid: number }[];
  if (fkResult.length > 0) {
    throw new Error('Migration 0001: foreign_key_check returned rows after migration');
  }
}

const CHECKSUM_SOURCE = '0001_event_store_foundation:' + FINAL_EVENTS_DDL + ':' + CHECKPOINTS_DDL;
const CHECKSUM = 'sha256:' + crypto.createHash('sha256').update(CHECKSUM_SOURCE).digest('hex');

export const migration0001: Migration = {
  version: 1,
  name: 'event_store_foundation',
  checksum: CHECKSUM,
  up,
};
