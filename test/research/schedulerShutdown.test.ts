/**
 * Phase 16 Stage A — scheduler shutdown semantics.
 *
 * 1. shutdown() ABORTS active runs and appends RUN_INTERRUPTED ("process
 *    shutdown") — never RUN_CANCELLED (interruption is external termination,
 *    not user intent).
 * 2. QUEUED runs are left untouched and a NEW scheduler instance reading the
 *    same event log resumes them.
 * 3. The RUN_INTERRUPTED write actually lands before shutdown() resolves
 *    (shutdown ordering contract: DB closes only after these writes).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, appendEvents, queryEvents } from '../../src/store/index.js';
import type { NewEventInput } from '../../src/store/events.js';
import { rebuildProjection } from '../../src/store/projectionBuilder.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import { JobScheduler } from '../../src/research/scheduler.js';
import type { EnqueuedRun } from '../../src/research/scheduler.js';
import { foldRunLedger, RunHistoryCorruptionError } from '../../src/research/runLedger.js';

const handlers = { ...graphEventHandlers, ...workspaceEventHandlers };

function envelope(eventType: NewEventInput['eventType'], runId: string, payload: unknown): NewEventInput {
  return { timestamp: new Date().toISOString(), eventType, eventVersion: 1, runId, batchId: null, actor: 'system', entityId: runId, entityType: 'run', payload };
}

function queuedPayload(runId: string) {
  const now = new Date().toISOString();
  return {
    runId, rootRunId: runId, familyId: 'fam1', query: 'test query',
    strategy: 'pipeline' as const, depth: 'standard' as const, providerName: 'p1',
    requestHash: `hash_${runId}`,
    retryPolicy: { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1000, maxBackoffMs: 30000 },
    deadlineAt: new Date(Date.now() + 600_000).toISOString(), attempt: 1, queuedAt: now,
  };
}

/** Persist the RUN_QUEUED event so foldRunLedger sees the run. */
function liveContext() {
  return { projection: rebuildProjection(handlers), handlers };
}
function appendQueued(runId: string): void {
  appendEvents([
    envelope('FAMILY_CREATED', runId, { family_id: 'fam1', label: 'fam1' }),
    envelope('RUN_QUEUED', runId, queuedPayload(runId)),
  ], liveContext());
}

function enqueued(runId: string): EnqueuedRun {
  return {
    ...queuedPayload(runId),
    appendContext: liveContext(),
  } as unknown as EnqueuedRun;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-sched-shutdown-'));
  const db = initDb(path.join(dir, 'test.db'));
  expect(db).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scheduler graceful shutdown', () => {
  it('aborts an ACTIVE run, appends RUN_INTERRUPTED "process shutdown", and returns promptly', async () => {
    appendQueued('run-active');
    let abortObserved = false;
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, {
      getProvider: async () => ({ name: 'p1', capabilities: {}, search: async () => [], read: async () => ({ url: '', title: '', content: '', contentHash: '' }), crawl: async () => [], academic: async () => [] }),
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => createEmptyProjectionState(),
      executeResearch: async (_runId, _familyId, _input, signal) => {
        // Simulate in-flight research that only unwinds when aborted.
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('aborted')); return; }
          signal.addEventListener('abort', () => { abortObserved = true; reject(new Error('aborted')); }, { once: true });
        });
      },
    });
    scheduler.start();
    await scheduler.enqueue(enqueued('run-active'));

    // Wait until the run is RUNNING before shutting down.
    const deadline = Date.now() + 5_000;
    while (queryEvents({ runId: 'run-active', eventType: 'RUN_RUNNING' }).length === 0) {
      if (Date.now() > deadline) throw new Error('run never reached RUNNING');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const startedAt = Date.now();
    await scheduler.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(5_000); // prompt, not deadline-bound
    expect(abortObserved).toBe(true);

    const interrupted = queryEvents({ runId: 'run-active', eventType: 'RUN_INTERRUPTED' });
    expect(interrupted.length).toBe(1);
    expect((interrupted[0]?.payload as { reason?: string }).reason).toBe('process shutdown');
    expect(queryEvents({ runId: 'run-active', eventType: 'RUN_CANCELLED' }).length).toBe(0);
  });

  it('leaves QUEUED runs untouched; a fresh scheduler resumes them from the same event log', async () => {
    appendQueued('run-a');
    appendQueued('run-b');
    const executedByNewScheduler: string[] = [];
    const makeDeps = (onExecute: (runId: string, signal?: AbortSignal) => Promise<void>) => ({
      getProvider: async () => ({ name: 'p1', capabilities: {}, search: async () => [], read: async () => ({ url: '', title: '', content: '', contentHash: '' }), crawl: async () => [], academic: async () => [] }),
      appendWithRetry: (events: readonly unknown[], context: Parameters<typeof appendEvents>[1]) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => createEmptyProjectionState(),
      executeResearch: onExecute,
    });
    const first = new JobScheduler({ maxConcurrentRuns: 1 }, makeDeps(async (_runId, signal) => {
      // run-a hangs until aborted
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted === true) { reject(new Error('aborted')); return; }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }));
    first.start();
    await first.enqueue(enqueued('run-a'));
    await first.enqueue(enqueued('run-b')); // exceeds maxConcurrentRuns → stays queued

    const waitUntilRunning = async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (queryEvents({ runId: 'run-a', eventType: 'RUN_RUNNING' }).length === 0) {
        if (Date.now() > deadline) throw new Error('run-a never reached RUNNING');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await waitUntilRunning();
    await first.shutdown();

    // run-b untouched: still exactly QUEUED, no terminal events.
    expect(queryEvents({ runId: 'run-b', eventType: 'RUN_INTERRUPTED' }).length).toBe(0);
    expect(queryEvents({ runId: 'run-b', eventType: 'RUN_STARTING' }).length).toBe(0);

    // Fresh scheduler over the SAME event log resumes run-b.
    const second = new JobScheduler({ maxConcurrentRuns: 2 }, makeDeps(async (runId) => {
      executedByNewScheduler.push(runId);
    }));
    second.start();
    const resumeDeadline = Date.now() + 5_000;
    while (executedByNewScheduler.length === 0) {
      if (Date.now() > resumeDeadline) throw new Error('resumed scheduler never executed run-b');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executedByNewScheduler).toContain('run-b');
    await second.shutdown();
  });

  it('lands the RUN_INTERRUPTED write durably BEFORE shutdown resolves (no silent swallow)', async () => {
    appendQueued('run-order');
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, {
      getProvider: async () => ({ name: 'p1', capabilities: {}, search: async () => [], read: async () => ({ url: '', title: '', content: '', contentHash: '' }), crawl: async () => [], academic: async () => [] }),
      appendWithRetry: (events, context) => { appendEvents(events as NewEventInput[], context); },
      rebuildAppendContext: () => liveContext(),
      rebuildProjection: () => createEmptyProjectionState(),
      executeResearch: async (_runId, _familyId, _input, signal) => {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error('aborted')); return; }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    scheduler.start();
    await scheduler.enqueue(enqueued('run-order'));
    const deadline = Date.now() + 5_000;
    while (queryEvents({ runId: 'run-order', eventType: 'RUN_RUNNING' }).length === 0) {
      if (Date.now() > deadline) throw new Error('run never reached RUNNING');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await scheduler.shutdown();

    // The write must be present in the store right now — i.e., it landed
    // during shutdown, not after (DB close happens strictly later).
    expect(queryEvents({ runId: 'run-order', eventType: 'RUN_INTERRUPTED' }).length).toBeGreaterThanOrEqual(1);

    // Idempotency: a second shutdown neither throws nor duplicates events.
    const countBefore = queryEvents({ runId: 'run-order', eventType: 'RUN_INTERRUPTED' }).length;
    await scheduler.shutdown();
    expect(queryEvents({ runId: 'run-order', eventType: 'RUN_INTERRUPTED' }).length).toBe(countBefore);
  });
});

/** All lifecycle-terminal event types per foldRunLedger()'s transition table. */
const TERMINAL_TYPES = ['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED', 'RUN_INTERRUPTED'];
function terminalEvents(runId: string) {
  return queryEvents({ runId }).filter((e) => TERMINAL_TYPES.includes(e.eventType));
}

function hangingDeps() {
  return {
    getProvider: async () => ({ name: 'p1', capabilities: {}, search: async () => [], read: async () => ({ url: '', title: '', content: '', contentHash: '' }), crawl: async () => [], academic: async () => [] }),
    appendWithRetry: (events: readonly unknown[], context: Parameters<typeof appendEvents>[1]) => { appendEvents(events as NewEventInput[], context); },
    rebuildAppendContext: () => liveContext(),
    rebuildProjection: () => createEmptyProjectionState(),
    executeResearch: async (_runId: string, _familyId: string, _input: unknown, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
}

async function waitFor(predicate: () => boolean, message: string, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('scheduler terminal-event exclusivity (shutdown/deadline/cancel race)', () => {
  it('shutdown racing a deadline-exceeded ACTIVE run lands EXACTLY ONE terminal event; ledger folds cleanly', async () => {
    appendQueued('run-race-deadline');
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, hangingDeps());
    scheduler.start();
    const deadlineAt = new Date(Date.now() + 150).toISOString();
    await scheduler.enqueue({ ...enqueued('run-race-deadline'), deadlineAt });
    await waitFor(() => queryEvents({ runId: 'run-race-deadline', eventType: 'RUN_RUNNING' }).length > 0, 'run never reached RUNNING');
    // Busy-spin until the internal deadline timer is due, then invoke shutdown
    // immediately — whichever path wins the claim, exactly one terminal event
    // may land for this run.
    await waitFor(() => Date.now() >= Date.parse(deadlineAt), 'deadline never became due', 1);
    await scheduler.shutdown();

    expect(terminalEvents('run-race-deadline').length).toBe(1);
    let folded: Map<string, unknown> | undefined;
    expect(() => { folded = foldRunLedger(queryEvents({})); }).not.toThrow(RunHistoryCorruptionError);
    expect(folded!.get('run-race-deadline')).toBeDefined();
  });

  it('cancel invoked in the SAME TICK as shutdown yields EXACTLY ONE terminal event (CANCELLED, not INTERRUPTED)', async () => {
    appendQueued('run-race-cancel');
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, hangingDeps());
    scheduler.start();
    await scheduler.enqueue(enqueued('run-race-cancel'));
    await waitFor(() => queryEvents({ runId: 'run-race-cancel', eventType: 'RUN_RUNNING' }).length > 0, 'run never reached RUNNING');

    // Same synchronous tick: cancel claims first; shutdown's claim must lose.
    expect(scheduler.cancel('run-race-cancel')).toBe(true);
    await scheduler.shutdown();

    expect(queryEvents({ runId: 'run-race-cancel', eventType: 'RUN_CANCELLED' }).length).toBe(1);
    expect(queryEvents({ runId: 'run-race-cancel', eventType: 'RUN_INTERRUPTED' }).length).toBe(0);
    expect(terminalEvents('run-race-cancel').length).toBe(1);
    expect(() => foldRunLedger(queryEvents({}))).not.toThrow();
  });

  it('cancel after an independently-fired deadline yields EXACTLY ONE terminal event; ledger folds cleanly', async () => {
    appendQueued('run-race-late-cancel');
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, hangingDeps());
    scheduler.start();
    const deadlineAt = new Date(Date.now() + 150).toISOString();
    await scheduler.enqueue({ ...enqueued('run-race-late-cancel'), deadlineAt });
    await waitFor(() => queryEvents({ runId: 'run-race-late-cancel', eventType: 'RUN_RUNNING' }).length > 0, 'run never reached RUNNING');
    await waitFor(() => Date.now() >= Date.parse(deadlineAt) + 50, 'deadline never became due', 1);
    // The deadline terminal has fired (or is firing); cancel must not add a
    // second terminal event — whichever wins the claim.
    scheduler.cancel('run-race-late-cancel');
    await scheduler.shutdown();

    expect(terminalEvents('run-race-late-cancel').length).toBe(1);
    expect(() => foldRunLedger(queryEvents({}))).not.toThrow();
  });
});
