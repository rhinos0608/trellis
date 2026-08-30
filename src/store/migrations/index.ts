/**
 * Migration runner for Trellis event store.
 *
 * Maintains a schema_migrations table that records which migrations have been
 * applied, their checksums, and application timestamps. On startup, validates
 * registry integrity, verifies checksums of already-applied migrations, and
 * applies any new migrations in order.
 */

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { migration0001 } from './0001_event_store_foundation.js';
import { migration0002 } from './0002_durable_knowledge_read_model.js';
import { migration0003 } from './0003_event_actor_identity.js';
import { migration0004 } from './0004_curation_lifecycle.js';
import { migration0005 } from './0005_claim_validity.js';
import { migration0006 } from './0006_research_step_checkpoints.js';
import type { Migration } from './types.js';

export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006];

/** Latest applied migration version — the authoritative schema version. */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]!.version; // eslint-disable-line @typescript-eslint/no-non-null-assertion

function validateRegistry(): void {
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const expected = i + 1;
    if (MIGRATIONS[i]!.version !== expected) { // eslint-disable-line @typescript-eslint/no-non-null-assertion
      throw new Error(
        'Migration registry gap: expected version ' + String(expected) + ', got ' + String(MIGRATIONS[i]!.version), // eslint-disable-line @typescript-eslint/no-non-null-assertion
      );
    }
  }
}

export function initializeSchema(db: BetterSqliteDatabase): void {
  // 0. Busy timeout — prevent SQLITE_BUSY when another process holds the lock
  db.pragma('busy_timeout = 5000');

  // 1. Bootstrap schema_migrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY CHECK(version > 0),
      name       TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL,
      checksum   TEXT NOT NULL
    )
  `);

  // 2. Validate registry contiguity
  validateRegistry();

  // 3. Read applied migrations, verify checksums
  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number; name: string; checksum: string }[];

  for (const row of applied) {
    const registered = MIGRATIONS.find((m) => m.version === row.version);
    if (registered === undefined) {
      throw new Error(
        'Applied migration version ' + String(row.version) + ' (' + row.name + ') is not registered in code',
      );
    }
    if (registered.checksum !== row.checksum) {
      throw new Error(
        'Checksum mismatch for migration ' + String(row.version) + ' (' + row.name + '): ' +
        'applied=' + row.checksum + ', registered=' + registered.checksum + '. ' +
        'Migration file was edited after being applied — this is not allowed.',
      );
    }
  }

  // 4. Apply pending migrations
  const appliedVersions = new Set(applied.map((r) => r.version));
  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version));

  for (const migration of pending) {
    const runMigration = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString(), migration.checksum);
    });
    runMigration();
  }
}
