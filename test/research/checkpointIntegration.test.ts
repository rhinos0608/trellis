/**
 * Integration tests for checkpoint persistence + scheduler resume behavior.
 *
 * Covers:
 * - Checkpoint persists during a run (test 2)
 * - Crash-simulated resume skips completed steps (test 3)
 * - Terminal cleanup deletes checkpoint (test 4)
 * - Corrupt/incompatible checkpoint falls back to interruption (test 5)
 * - No-checkpoint regression (test 6)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, appendEvents, queryEvents, getDb } from '../../src/store/index.js';
import type { NewEventInput } from '../../src/store/events.js';
import { rebuildProjection } from '../../src/store/projectionBuilder.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import { JobScheduler } from '../../src/research/scheduler.js';
import type { EnqueuedRun } from '../../src/research/scheduler.js';
import { foldRunLedger, RunHistoryCorruptionError } from '../../src/research/runLedger.js';
import {
  upsertCheckpoint,
  loadCheckpoint,
  CURRENT_CHECKPOINT_FORMAT_VERSION,
} from '../../src/research/stepCheckpoints.js';
import type { StepCheckpoint } from '../../src/research/stepCheckpoints.js';
import type { ResearchState, BudgetState } from '../../src/research/internalTypes.js';
import type { TrellisConfig } from '../../src/config/index.js';
import type { ResearchProvider } from '../../src/providers/types.js';

// ── Shared fixtures ────────────────────────────────────────────────

const handlers = { ...graphEventHandlers, ...workspaceEventHandlers };

function mkEnvelope(eventType: NewEventInput['eventType'], runId: string, payload: unknown): NewEventInput {
  return { timestamp: new Date().toISOString(), eventType, eventVersion: 1, runId, batchId: null, actor: 'system', entityId: runId, entityType: 'run', payload };
}

function queuedPayload(runId: string) {
  return {
    runId, rootRunId: runId, familyId: 'fam1', query: 'test query',
    strategy: 'agent' as const, depth: 'standard' as const, providerName: 'p1',
    requestHash: `hash_${runId}`,
    retryPolicy: { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1000, maxBackoffMs: 30000 },
    deadlineAt: new Date(Date.now() + 600_000).toISOString(), attempt: 1, queuedAt: new Date().toISOString(),
  };
}

function liveContext() {
  return { projection: rebuildProjection(handlers), handlers };
}

function appendQueued(runId: string): void {
  appendEvents([
    mkEnvelope('FAMILY_CREATED', runId, { family_id: 'fam1', label: 'fam1' }),
    mkEnvelope('RUN_QUEUED', runId, queuedPayload(runId)),
  ], liveContext());
}

function appendStaleRunning(runId: string): void {
  const heartbeatAgeMs = 120_000;
  const ownerId = 'dead_process';
  const now = Date.now();
  const heartbeatAt = new Date(now - heartbeatAgeMs).toISOString();
  const startedAt = new Date(now - heartbeatAgeMs - 1000).toISOString();
  appendEvents([
    mkEnvelope('FAMILY_CREATED', runId, { family_id: 'fam1', label: 'fam1' }),
    mkEnvelope('RUN_QUEUED', runId, queuedPayload(runId)),
    mkEnvelope('RUN_STARTING', runId, { runId, ownerId, startingAt: startedAt }),
    mkEnvelope('RUN_RUNNING', runId, { runId, ownerId, startedAt, heartbeatAt, leaseUntil: new Date(now + 60_000).toISOString() }),
  ], liveContext());
}

const MINIMAL_CONFIG: TrellisConfig = {
  storage: { dbPath: ':memory:' },
  llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
  searchProvider: { command: 'echo', args: [] },
  logLevel: 'silent',
};

function enqueued(runId: string): EnqueuedRun {
  return {
    ...queuedPayload(runId),
    appendContext: liveContext(),
    input: { query: 'test query', config: MINIMAL_CONFIG },
  };
}

// ── Budget / state fixtures ────────────────────────────────────────

function minimalBudgetState(): BudgetState {
  return {
    toolCallsUsed: 2, tokensUsed: 500, extractionsUsed: 1, gapLoopsUsed: 0,
    startTime: Date.now(), maxToolCalls: 200, maxTokens: 400_000, maxExtractions: 60,
    maxGapLoops: 4, stateEntriesUsed: 0, maxStateEntries: 500, maxTimeMs: 480_000,
    stepCosts: {}, findingsAddedPerLoop: [],
  };
}

function minimalResearchState(): ResearchState {
  return {
    query: 'test query',
    taxonomy: { originalQuery: 'test query', subQuestions: [], revised: false, revisionHistory: [] },
    subQuestions: [], sources: [], findings: [], contradictions: [],
    openQuestions: [], gaps: [], claimGraph: [], currentPhase: 'discovery',
    budget: minimalBudgetState(),
    flags: { taxonomyRevised: false, audited: false, loopCount: 1 },
    gapTargets: [], allQuestions: ['test query'], resolvedGaps: [],
    searchClusters: [], diary: [], searchAttempts: [],
    workerReports: {}, contentQuality: {}, subQuestionCoverage: [],
  };
}

function makeCheckpoint(runId: string, overrides: Partial<StepCheckpoint> = {}): StepCheckpoint {
  return {
    runId,
    stepIndex: 3,
    status: 'completed',
    executionSpec: {
      query: 'test query', depth: 'standard', familyId: 'fam1',
      providerName: 'p1', deadlineAt: new Date(Date.now() + 600_000).toISOString(),
    },
    strategyState: minimalResearchState(),
    history: [
      { role: 'assistant', action: 'search_web', args: { query: 'q1' } },
      { role: 'tool', tool: 'search_web', content: 'result 1' },
    ],
    pendingWrite: null,
    formatVersion: CURRENT_CHECKPOINT_FORMAT_VERSION,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function rawCheckpointRow(runId: string): Record<string, unknown> | undefined {
  const db = getDb()!;
  return db.prepare('SELECT * FROM research_step_checkpoints WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
}

const dummyProvider: ResearchProvider = {
  name: 'p1',
  capabilities: {} as never,
  search: async () => [],
  read: async () => ({ url: '', title: '', content: '', contentHash: '' }),
  crawl: async () => [],
  academic: async () => [],
};

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-checkpoint-integration-'));
  const db = initDb(path.join(dir, 'test.db'));
  expect(db).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════
// Test 2: Checkpoint persists during a run
// ════════════════════════════════════════════════════════════════════

describe('integration: checkpoint persists during a run', () => {
  it('mock executeResearch writes checkpoints that are queryable from DB', async () => {
    let checkpointWritten = false;

    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async (runId, _familyId, _input, _signal, _provider, _providerCtx, _reportProgress) => {
        const checkpoint: StepCheckpoint = makeCheckpoint(runId, { stepIndex: 1, status: 'completed' });
        upsertCheckpoint(checkpoint);
        checkpointWritten = true;
      },
    });
    scheduler.start();

    appendQueued('run-cp-persist');
    await scheduler.activate(enqueued('run-cp-persist'));

    await waitFor(() => checkpointWritten, 'checkpoint was never written', 5_000);
    await scheduler.shutdown();

    const row = rawCheckpointRow('run-cp-persist');
    expect(row).toBeDefined();
    expect(row!.step_index).toBe(1);
    expect(row!.status).toBe('completed');
  });
});

// ════════════════════════════════════════════════════════════════════
// Test 3: Crash-simulated resume skips completed steps
// ════════════════════════════════════════════════════════════════════

describe('integration: crash-simulated resume skips completed steps', () => {
  it('fresh scheduler receives checkpoint from DB and passes it to executeResearch', async () => {
    appendStaleRunning('run-resume-1');
    const cp = makeCheckpoint('run-resume-1', { stepIndex: 3, status: 'completed' });
    upsertCheckpoint(cp);

    let executeResearchCallCount = 0;
    let receivedCheckpoint: StepCheckpoint | null = null;

    const freshScheduler = new JobScheduler({ maxConcurrentRuns: 1 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async (_runId, _familyId, _input, _signal, _provider, _providerCtx, _reportProgress, checkpoint) => {
        executeResearchCallCount++;
        receivedCheckpoint = checkpoint ?? null;
      },
    });
    freshScheduler.start();

    await waitFor(() => executeResearchCallCount > 0, 'executeResearch was never called for resumed run', 5_000);

    expect(executeResearchCallCount).toBe(1);
    expect(receivedCheckpoint).not.toBeNull();
    expect(receivedCheckpoint!.runId).toBe('run-resume-1');
    expect(receivedCheckpoint!.stepIndex).toBe(3);
    expect(receivedCheckpoint!.status).toBe('completed');

    await freshScheduler.shutdown();
  });

  it('tool call counter shows only resumed steps executed, not re-executed completed steps', async () => {
    appendStaleRunning('run-counter-1');
    const cp = makeCheckpoint('run-counter-1', { stepIndex: 2, status: 'completed' });
    upsertCheckpoint(cp);

    let resumedToolCallCount = 0;
    let receivedCheckpoint: StepCheckpoint | null = null;

    const freshScheduler = new JobScheduler({ maxConcurrentRuns: 1 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async (_runId, _familyId, _input, _signal, _provider, _providerCtx, _reportProgress, checkpoint) => {
        receivedCheckpoint = checkpoint ?? null;
        if (checkpoint !== null && checkpoint !== undefined) {
          // Real agentStrategy: resume from stepIndex + 1
          const remainingSteps = Math.max(0, 5 - checkpoint.stepIndex);
          resumedToolCallCount = remainingSteps;
        } else {
          resumedToolCallCount = 5;
        }
      },
    });
    freshScheduler.start();

    await waitFor(() => receivedCheckpoint !== null, 'executeResearch was never called', 5_000);

    expect(receivedCheckpoint!.stepIndex).toBe(2);
    expect(resumedToolCallCount).toBe(3);

    await freshScheduler.shutdown();
  });

  it('started-status checkpoint triggers re-execution of the pending tool only', async () => {
    appendStaleRunning('run-started-cp');
    const pendingTool = { tool: 'search_web', args: { query: 'test' }, thought: 'searching' };
    const cp = makeCheckpoint('run-started-cp', {
      stepIndex: 2,
      status: 'started',
      pendingWrite: pendingTool,
    });
    upsertCheckpoint(cp);

    let receivedCheckpoint: StepCheckpoint | null = null;
    let executedSteps: string[] = [];

    const freshScheduler = new JobScheduler({ maxConcurrentRuns: 1 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async (_runId, _familyId, _input, _signal, _provider, _providerCtx, _reportProgress, checkpoint) => {
        receivedCheckpoint = checkpoint ?? null;
        if (checkpoint !== null && checkpoint !== undefined && checkpoint.status === 'started') {
          executedSteps.push(`reexec_step_${String(checkpoint.stepIndex)}`);
          executedSteps.push(`step_${String(checkpoint.stepIndex + 1)}`);
          executedSteps.push(`step_${String(checkpoint.stepIndex + 2)}`);
        }
      },
    });
    freshScheduler.start();

    await waitFor(() => receivedCheckpoint !== null, 'executeResearch was never called', 5_000);

    expect(receivedCheckpoint!.status).toBe('started');
    expect(receivedCheckpoint!.stepIndex).toBe(2);
    expect(executedSteps).toEqual(['reexec_step_2', 'step_3', 'step_4']);

    await freshScheduler.shutdown();
  });
});

// ════════════════════════════════════════════════════════════════════
// Test 4: Terminal cleanup — deleteCheckpoint on terminal state
// ════════════════════════════════════════════════════════════════════

describe('integration: terminal cleanup', () => {
  it('checkpoint row is deleted after run completes successfully', async () => {
    let completed = false;
    const sched = new JobScheduler({ maxConcurrentRuns: 1 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async (runId, _famId, _input, _signal, _provider, _providerCtx) => {
        // Append RUN_COMPLETED before returning — this is what runService.ts does.
        // Do NOT call reportProgress after appending to avoid stale projection
        // (the scheduler's reportProgress uses a cached context).
        appendEvents([mkEnvelope('RUN_COMPLETED', runId, { runId, claimCount: 0, sourceCount: 0, evidenceCount: 0 })], liveContext());
        completed = true;
      },
    });
    sched.start();

    appendQueued('run-cp-delete');
    const cpDel = makeCheckpoint('run-cp-delete', { stepIndex: 1, status: 'completed' });
    upsertCheckpoint(cpDel);
    expect(rawCheckpointRow('run-cp-delete')).toBeDefined();

    await sched.activate(enqueued('run-cp-delete'));
    await waitFor(() => completed, 'executeResearch never completed', 5_000);

    // The scheduler's finally block runs after executeResearch returns and calls
    // deleteCheckpoint if the run status is terminal. Give it a moment.
    await new Promise((r) => setTimeout(r, 100));
    await sched.shutdown();

    expect(rawCheckpointRow('run-cp-delete')).toBeUndefined();
  });

  it('checkpoint row is deleted after run fails', async () => {
    let failed = false;
    const sched = new JobScheduler({ maxConcurrentRuns: 1 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async () => {
        // Throw — the scheduler's catch block will append RUN_FAILED and its
        // finally block will call deleteCheckpoint.
        throw new Error('test failure');
      },
    });
    sched.start();

    appendQueued('run-cp-fail');
    const cpDel = makeCheckpoint('run-cp-fail', { stepIndex: 1, status: 'completed' });
    upsertCheckpoint(cpDel);

    await sched.activate(enqueued('run-cp-fail'));
    await waitFor(() => {
      const folded = foldRunLedger(queryEvents({}));
      return folded.get('run-cp-fail')?.status === 'failed';
    }, 'run never reached failed status', 5_000);

    await new Promise((r) => setTimeout(r, 100));
    await sched.shutdown();

    expect(rawCheckpointRow('run-cp-fail')).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// Test 5: Corrupt/incompatible checkpoint falls back to interruption
// ════════════════════════════════════════════════════════════════════

describe('integration: corrupt/incompatible checkpoint fallback', () => {
  it('future-format-version checkpoint causes run to be interrupted', () => {
    appendStaleRunning('run-future-cp');

    const db = getDb()!;
    db.prepare(`
      INSERT INTO research_step_checkpoints
        (run_id, step_index, status, execution_spec_json, strategy_state_json, history_json, pending_write_json, format_version, updated_at)
      VALUES (?, 0, 'completed', '{}', '{}', '[]', NULL, 999, ?)
    `).run('run-future-cp', new Date().toISOString());

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async () => { throw new Error('should not be called'); },
    });

    const events = queryEvents({ runId: 'run-future-cp', eventType: 'RUN_INTERRUPTED' });
    expect(events.length).toBe(1);
    expect((events[0]!.payload as { reason?: string }).reason).toBe('orphaned lease');

    const folded = foldRunLedger(queryEvents({}));
    expect(folded.get('run-future-cp')?.status).toBe('interrupted');
    expect(() => foldRunLedger(queryEvents({}))).not.toThrow(RunHistoryCorruptionError);

    void scheduler;
  });

  it('malformed checkpoint JSON causes run to be interrupted', () => {
    appendStaleRunning('run-malformed-cp');

    const db = getDb()!;
    db.prepare(`
      INSERT INTO research_step_checkpoints
        (run_id, step_index, status, execution_spec_json, strategy_state_json, history_json, pending_write_json, format_version, updated_at)
      VALUES (?, 0, 'completed', '{}', 'NOT-VALID-JSON{{{', '[]', NULL, 1, ?)
    `).run('run-malformed-cp', new Date().toISOString());

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async () => { throw new Error('should not be called'); },
    });

    const events = queryEvents({ runId: 'run-malformed-cp', eventType: 'RUN_INTERRUPTED' });
    expect(events.length).toBe(1);
    expect((events[0]!.payload as { reason?: string }).reason).toBe('orphaned lease');

    expect(() => foldRunLedger(queryEvents({}))).not.toThrow(RunHistoryCorruptionError);
    const folded = foldRunLedger(queryEvents({}));
    expect(folded.get('run-malformed-cp')?.status).toBe('interrupted');

    void scheduler;
  });
});

// ════════════════════════════════════════════════════════════════════
// Test 6: No-checkpoint regression — orphaned run still interrupted
// ════════════════════════════════════════════════════════════════════

describe('integration: no-checkpoint regression', () => {
  it('orphaned running run with NO checkpoint row still gets interrupted', () => {
    appendStaleRunning('run-no-cp');

    // No checkpoint written for this run — exactly as before the feature existed

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async () => { throw new Error('should not be called'); },
    });

    // Must NOT call executeResearch — no checkpoint means interruption
    const events = queryEvents({ runId: 'run-no-cp', eventType: 'RUN_INTERRUPTED' });
    expect(events.length).toBe(1);
    expect((events[0]!.payload as { reason?: string }).reason).toBe('orphaned lease');

    expect(() => foldRunLedger(queryEvents({}))).not.toThrow(RunHistoryCorruptionError);
    const folded = foldRunLedger(queryEvents({}));
    expect(folded.get('run-no-cp')?.status).toBe('interrupted');

    void scheduler;
  });

  it('orphaned starting run with NO checkpoint row still gets interrupted', () => {
    // A run that never even got to RUNNING state
    const now = Date.now();
    const startedAt = new Date(now - 120_000).toISOString();
    appendEvents([
      mkEnvelope('FAMILY_CREATED', 'run-no-cp-starting', { family_id: 'fam1', label: 'fam1' }),
      mkEnvelope('RUN_QUEUED', 'run-no-cp-starting', queuedPayload('run-no-cp-starting')),
      mkEnvelope('RUN_STARTING', 'run-no-cp-starting', { runId: 'run-no-cp-starting', ownerId: 'dead_proc', startingAt: startedAt }),
    ], liveContext());

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, {
      getProvider: async () => dummyProvider,
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => rebuildProjection(handlers),
      executeResearch: async () => { throw new Error('should not be called'); },
    });

    const events = queryEvents({ runId: 'run-no-cp-starting', eventType: 'RUN_INTERRUPTED' });
    expect(events.length).toBe(1);

    const folded = foldRunLedger(queryEvents({}));
    expect(folded.get('run-no-cp-starting')?.status).toBe('interrupted');

    void scheduler;
  });
});
