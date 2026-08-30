/**
 * Unit tests for stepCheckpoints.ts — checkpoint persistence layer.
 *
 * Tests upsert/load/delete round-trips, malformed data handling,
 * format version gating, and idempotent upsert behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getDb } from '../../src/store/index.js';
import {
  upsertCheckpoint,
  loadCheckpoint,
  deleteCheckpoint,
  CURRENT_CHECKPOINT_FORMAT_VERSION,
  type StepCheckpoint,
  type ExecutionSpec,
} from '../../src/research/stepCheckpoints.js';
import type { ResearchState, BudgetState } from '../../src/research/internalTypes.js';

// ── Test fixtures ───────────────────────────────────────────────────

function minimalBudgetState(): BudgetState {
  return {
    toolCallsUsed: 2,
    tokensUsed: 500,
    extractionsUsed: 1,
    gapLoopsUsed: 0,
    startTime: Date.now(),
    maxToolCalls: 200,
    maxTokens: 400_000,
    maxExtractions: 60,
    maxGapLoops: 4,
    stateEntriesUsed: 0,
    maxStateEntries: 500,
    maxTimeMs: 480_000,
    stepCosts: {},
    findingsAddedPerLoop: [],
  };
}

function minimalResearchState(): ResearchState {
  return {
    query: 'test query',
    taxonomy: { originalQuery: 'test query', subQuestions: [], revised: false, revisionHistory: [] },
    subQuestions: [],
    sources: [],
    findings: [],
    contradictions: [],
    openQuestions: [],
    gaps: [],
    claimGraph: [],
    currentPhase: 'discovery',
    budget: minimalBudgetState(),
    flags: { taxonomyRevised: false, audited: false, loopCount: 1 },
    gapTargets: [],
    allQuestions: ['test query'],
    resolvedGaps: [],
    searchClusters: [],
    diary: [],
    searchAttempts: [],
    workerReports: {},
    contentQuality: {},
    subQuestionCoverage: [],
  };
}

function minimalExecSpec(): ExecutionSpec {
  return {
    query: 'test query',
    depth: 'standard',
    familyId: 'fam1',
    providerName: 'mock',
    deadlineAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

function makeCheckpoint(overrides: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId: 'run-test-1',
    stepIndex: 2,
    status: 'completed',
    executionSpec: minimalExecSpec(),
    strategyState: minimalResearchState(),
    history: [
      { role: 'assistant', action: 'search_web', args: { query: 'test' } },
      { role: 'tool', tool: 'search_web', content: 'result 1' },
    ],
    pendingWrite: null,
    formatVersion: CURRENT_CHECKPOINT_FORMAT_VERSION,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-checkpoint-test-'));
  const db = initDb(path.join(dir, 'test.db'));
  expect(db).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Direct table helper ────────────────────────────────────────────

function countCheckpointRows(runId: string): number {
  const db = getDb()!;
  const row = db.prepare('SELECT COUNT(*) as cnt FROM research_step_checkpoints WHERE run_id = ?').get(runId) as { cnt: number };
  return row.cnt;
}

function rawRow(runId: string): Record<string, unknown> | undefined {
  const db = getDb()!;
  return db.prepare('SELECT * FROM research_step_checkpoints WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
}

// ── Tests ──────────────────────────────────────────────────────────

describe('stepCheckpoints — unit', () => {
  it('upsert + load round-trips correctly', () => {
    const cp = makeCheckpoint();
    upsertCheckpoint(cp);

    const loaded = loadCheckpoint(cp.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe(cp.runId);
    expect(loaded!.stepIndex).toBe(cp.stepIndex);
    expect(loaded!.status).toBe(cp.status);
    expect(loaded!.executionSpec.query).toBe(cp.executionSpec.query);
    expect(loaded!.strategyState.query).toBe(cp.strategyState.query);
    expect(loaded!.history).toHaveLength(2);
    expect(loaded!.formatVersion).toBe(CURRENT_CHECKPOINT_FORMAT_VERSION);
  });

  it('loadCheckpoint returns null for missing run', () => {
    const loaded = loadCheckpoint('nonexistent-run');
    expect(loaded).toBeNull();
  });

  it('loadCheckpoint returns null for malformed execution_spec_json', () => {
    const db = getDb()!;
    db.prepare(`
      INSERT INTO research_step_checkpoints
        (run_id, step_index, status, execution_spec_json, strategy_state_json, history_json, pending_write_json, format_version, updated_at)
      VALUES (?, 0, 'completed', 'NOT-JSON', '{}', '[]', NULL, 1, ?)
    `).run('run-bad-exec', new Date().toISOString());

    const loaded = loadCheckpoint('run-bad-exec');
    expect(loaded).toBeNull();
  });

  it('loadCheckpoint returns null for malformed strategy_state_json', () => {
    const db = getDb()!;
    db.prepare(`
      INSERT INTO research_step_checkpoints
        (run_id, step_index, status, execution_spec_json, strategy_state_json, history_json, pending_write_json, format_version, updated_at)
      VALUES (?, 0, 'completed', '{}', '{broken', '[]', NULL, 1, ?)
    `).run('run-bad-state', new Date().toISOString());

    const loaded = loadCheckpoint('run-bad-state');
    expect(loaded).toBeNull();
  });

  it('loadCheckpoint returns null for malformed history_json', () => {
    const db = getDb()!;
    db.prepare(`
      INSERT INTO research_step_checkpoints
        (run_id, step_index, status, execution_spec_json, strategy_state_json, history_json, pending_write_json, format_version, updated_at)
      VALUES (?, 0, 'completed', '{}', '{}', 'not-an-array', NULL, 1, ?)
    `).run('run-bad-history', new Date().toISOString());

    const loaded = loadCheckpoint('run-bad-history');
    expect(loaded).toBeNull();
  });

  it('loadCheckpoint returns null for formatVersion > CURRENT_CHECKPOINT_FORMAT_VERSION', () => {
    const cp = makeCheckpoint({ formatVersion: CURRENT_CHECKPOINT_FORMAT_VERSION + 1 });
    upsertCheckpoint(cp);

    const loaded = loadCheckpoint(cp.runId);
    expect(loaded).toBeNull();
  });

  it('deleteCheckpoint removes the row', () => {
    const cp = makeCheckpoint();
    upsertCheckpoint(cp);
    expect(loadCheckpoint(cp.runId)).not.toBeNull();

    deleteCheckpoint(cp.runId);
    expect(loadCheckpoint(cp.runId)).toBeNull();
    expect(countCheckpointRows(cp.runId)).toBe(0);
  });

  it('upsertCheckpoint is idempotent — calling twice updates in place', () => {
    const cp1 = makeCheckpoint({ stepIndex: 1, status: 'started' });
    upsertCheckpoint(cp1);
    expect(countCheckpointRows(cp1.runId)).toBe(1);

    const cp2 = makeCheckpoint({ runId: cp1.runId, stepIndex: 2, status: 'completed' });
    upsertCheckpoint(cp2);

    expect(countCheckpointRows(cp1.runId)).toBe(1);

    const loaded = loadCheckpoint(cp1.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.stepIndex).toBe(2);
    expect(loaded!.status).toBe('completed');
  });

  it('handles null pendingWrite (stores null in DB)', () => {
    const cp = makeCheckpoint({ pendingWrite: null });
    upsertCheckpoint(cp);

    const row = rawRow(cp.runId);
    expect(row).toBeDefined();
    expect(row!.pending_write_json).toBeNull();
  });

  it('handles a PendingAction as pendingWrite', () => {
    const pending = { tool: 'search_web', args: { query: 'hello' }, thought: 'thinking' };
    const cp = makeCheckpoint({ status: 'started', pendingWrite: pending });
    upsertCheckpoint(cp);

    const loaded = loadCheckpoint(cp.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.pendingWrite).toEqual(pending);
  });

  it('handles a CompletedResult as pendingWrite', () => {
    const result = { tool: 'web_read', args: { url: 'https://x.com' }, content: 'page content', error: undefined };
    const cp = makeCheckpoint({ status: 'completed', pendingWrite: result });
    upsertCheckpoint(cp);

    const loaded = loadCheckpoint(cp.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.pendingWrite).toEqual(result);
  });

  it('does not crash when getDb() returns null', () => {
    expect(() => upsertCheckpoint(makeCheckpoint())).not.toThrow();
    expect(() => deleteCheckpoint('any-run')).not.toThrow();
  });
});
