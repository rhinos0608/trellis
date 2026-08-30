/**
 * Step-level checkpoint management for research agent runs.
 * Out-of-band persistence — not events, not projection checkpoints.
 * One row per run (upsert), deleted on terminal state.
 */

import { logger } from '../logger.js';
import { getDb } from '../store/db.js';
import type { ResearchState } from './internalTypes.js';

export const CURRENT_CHECKPOINT_FORMAT_VERSION = 1;

/** Safe subset of StartRunInput + ProviderCallContext for persistence (no secrets, no provider object). */
export interface ExecutionSpec {
  query: string;
  depth: string;
  topic?: string | undefined;
  familyId: string;
  threadId?: string | undefined;
  sessionId?: string | undefined;
  providerName: string;
  deadlineAt: string;
  /** Trellis config snapshot — needed to reconstruct StartRunInput for cross-process resume. */
  config?: import('../config/index.js').TrellisConfig | undefined;
}

/** Pending tool call info for a 'started' step. */
export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  thought?: string;
}

/** Tool result for a 'completed' step. */
export interface CompletedResult {
  tool: string;
  args: Record<string, unknown>;
  content: string;
  error?: string;
}

export interface StepCheckpoint {
  runId: string;
  stepIndex: number;
  status: 'started' | 'completed';
  executionSpec: ExecutionSpec;
  strategyState: ResearchState;
  history: unknown[];
  pendingWrite: PendingAction | CompletedResult | null;
  formatVersion: number;
  updatedAt: string;
}

const UPSERT_SQL = `
  INSERT INTO research_step_checkpoints
    (run_id, step_index, status, execution_spec_json, strategy_state_json, history_json, pending_write_json, format_version, updated_at)
  VALUES
    (@runId, @stepIndex, @status, @executionSpecJson, @strategyStateJson, @historyJson, @pendingWriteJson, @formatVersion, @updatedAt)
  ON CONFLICT(run_id) DO UPDATE SET
    step_index = excluded.step_index,
    status = excluded.status,
    execution_spec_json = excluded.execution_spec_json,
    strategy_state_json = excluded.strategy_state_json,
    history_json = excluded.history_json,
    pending_write_json = excluded.pending_write_json,
    format_version = excluded.format_version,
    updated_at = excluded.updated_at`;

const LOAD_SQL = `SELECT * FROM research_step_checkpoints WHERE run_id = ?`;
const DELETE_SQL = `DELETE FROM research_step_checkpoints WHERE run_id = ?`;

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Load a checkpoint for the given run. Returns null if absent or malformed.
 */
export function loadCheckpoint(runId: string): StepCheckpoint | null {
  const db = getDb();
  if (db === null) return null;

  try {
    const row = db.prepare(LOAD_SQL).get(runId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;

    const formatVersion = Number(row.format_version);
    if (formatVersion > CURRENT_CHECKPOINT_FORMAT_VERSION) {
      logger.warn({ runId, formatVersion }, 'stepCheckpoints: unknown format version, ignoring checkpoint');
      return null;
    }

    const executionSpec = safeJsonParse(row.execution_spec_json as string) as ExecutionSpec | null;
    const strategyState = safeJsonParse(row.strategy_state_json as string) as ResearchState | null;
    const history = safeJsonParse(row.history_json as string) as unknown[] | null;

    if (executionSpec === null || strategyState === null || history === null) {
      logger.warn({ runId }, 'stepCheckpoints: malformed checkpoint JSON, ignoring');
      return null;
    }

    let pendingWrite: PendingAction | CompletedResult | null = null;
    if (row.pending_write_json != null && row.pending_write_json !== '') {
      pendingWrite = safeJsonParse(row.pending_write_json as string) as PendingAction | CompletedResult | null;
    }

    return {
      runId: row.run_id as string,
      stepIndex: Number(row.step_index),
      status: row.status as 'started' | 'completed',
      executionSpec,
      strategyState,
      history,
      pendingWrite,
      formatVersion,
      updatedAt: row.updated_at as string,
    };
  } catch (err) {
    logger.warn({ err, runId }, 'stepCheckpoints: load failed');
    return null;
  }
}

/**
 * Upsert a checkpoint row. Called at tool-call boundaries.
 */
export function upsertCheckpoint(checkpoint: StepCheckpoint): void {
  const db = getDb();
  if (db === null) return;

  try {
    db.prepare(UPSERT_SQL).run({
      runId: checkpoint.runId,
      stepIndex: checkpoint.stepIndex,
      status: checkpoint.status,
      executionSpecJson: JSON.stringify(checkpoint.executionSpec),
      strategyStateJson: JSON.stringify(checkpoint.strategyState),
      historyJson: JSON.stringify(checkpoint.history),
      pendingWriteJson: checkpoint.pendingWrite !== null ? JSON.stringify(checkpoint.pendingWrite) : null,
      formatVersion: checkpoint.formatVersion,
      updatedAt: checkpoint.updatedAt,
    });
  } catch (err) {
    // Checkpoint failure must not crash the run — log and continue.
    logger.warn({ err, runId: checkpoint.runId }, 'stepCheckpoints: upsert failed');
  }
}

/**
 * Delete a checkpoint row. Called when a run reaches terminal state.
 */
export function deleteCheckpoint(runId: string): void {
  const db = getDb();
  if (db === null) return;

  try {
    db.prepare(DELETE_SQL).run(runId);
  } catch (err) {
    logger.warn({ err, runId }, 'stepCheckpoints: delete failed');
  }
}
