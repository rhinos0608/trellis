/**
 * Trellis SQLite DDL — events table + checkpoints table.
 * Minimal: only what the event store needs. Projection tables are
 * in-memory only (ProjectionState maps); domain queries go through
 * the projection, not SQL tables.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { logger } from '../logger.js';

export const SCHEMA_VERSION = 1;

export const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    id            TEXT PRIMARY KEY,
    timestamp     TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    run_id        TEXT NOT NULL,
    batch_id      TEXT,
    actor         TEXT NOT NULL DEFAULT 'system',
    entity_id     TEXT,
    entity_type   TEXT,
    payload       TEXT NOT NULL,
    payload_hash  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_run_id     ON events(run_id);
  CREATE INDEX IF NOT EXISTS idx_events_type        ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_entity_id   ON events(entity_id);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp   ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_batch_id    ON events(batch_id);

  CREATE TABLE IF NOT EXISTS projection_checkpoints (
    id                 TEXT PRIMARY KEY,
    created_at         TEXT NOT NULL,
    event_cursor       TEXT NOT NULL,
    projection_version INTEGER NOT NULL,
    schema_version     INTEGER NOT NULL,
    event_count        INTEGER NOT NULL,
    checksum           TEXT NOT NULL,
    compatible         INTEGER NOT NULL DEFAULT 1
  );
`;

export function initializeSchema(db: BetterSqliteDatabase): void {
  db.exec(SCHEMA_DDL);

  const current = db
    .prepare('SELECT schema_version FROM projection_checkpoints WHERE id = ?')
    .get('__schema_version') as { schema_version: number } | undefined;

  if (current === undefined) {
    db.prepare(
      'INSERT INTO projection_checkpoints (id, created_at, event_cursor, projection_version, schema_version, event_count, checksum, compatible) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('__schema_version', new Date().toISOString(), '', 0, SCHEMA_VERSION, 0, '', 0);
  } else if (current.schema_version !== SCHEMA_VERSION) {
    logger.warn(
      { found: current.schema_version, expected: SCHEMA_VERSION },
      'store: schema version changed, invalidating checkpoints',
    );
    db.prepare('UPDATE projection_checkpoints SET compatible = 0 WHERE id != ?').run('__schema_version');
    db.prepare('UPDATE projection_checkpoints SET schema_version = ? WHERE id = ?').run(
      SCHEMA_VERSION,
      '__schema_version',
    );
  }
}
