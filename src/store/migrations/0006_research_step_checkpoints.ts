import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import type { Migration } from './types.js';

const DDL = `
CREATE TABLE IF NOT EXISTS research_step_checkpoints (
  run_id TEXT PRIMARY KEY,
  step_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started', 'completed')),
  execution_spec_json TEXT NOT NULL,
  strategy_state_json TEXT NOT NULL,
  history_json TEXT NOT NULL,
  pending_write_json TEXT,
  format_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);`;

function up(db: BetterSqliteDatabase): void {
  db.exec(DDL);
}

const CHECKSUM = 'sha256:' + crypto.createHash('sha256').update('0006_research_step_checkpoints:' + DDL).digest('hex');
export const migration0006: Migration = { version: 6, name: 'research_step_checkpoints', checksum: CHECKSUM, up };
