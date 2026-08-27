/**
 * Phase 16 Stage A — scheduler shutdown + startup reconciliation semantics.
 *
 * 1. shutdown() ABORTS active runs and appends RUN_INTERRUPTED ("process
 *    shutdown") — never RUN_CANCELLED (interruption is external termination,
 *    not user intent).
 * 2. Orphaned QUEUED runs from a previous process are marked RUN_FAILED
 *    (recovery_unsupported) by reconcileOnStartup() at construction.
 * 3. The RUN_INTERRUPTED write actually lands before shutdown() resolves
 *    (shutdown ordering contract: DB closes only after these writes).
 * 4. Fresh (non-stale) leases are never killed by a second scheduler's
 *    construction — only genuinely orphaned (stale) leases are terminated.
 *
 * Production ordering: startRun() persists RUN_QUEUED FIRST, then calls
 * scheduler.activate(). Tests match this: construct scheduler, persist
 * RUN_QUEUED, then activate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, appendEvents, queryEvents } from '../../src/store/index.js';
import type { NewEventInput } from '../../src/store/events.js';
import { rebuildProjection } from '../../src/store/projectionBuilder.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import { JobScheduler } from '../../src/research/scheduler.js';
import type { EnqueuedRun } from '../../src/research/scheduler.js';
import { foldRunLedger, RunHistoryCorruptionError } from '../../src/research/runLedger.js';
import type { TrellisConfig } from '../../src/config/index.js';

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

/** Build a live AppendContext from the current projection. */
function liveContext() {
  return { projection: rebuildProjection(handlers), handlers };
}

/**
 * Persist RUN_QUEUED (and FAMILY_CREATED) — matches production startRun()
 * which appends these events BEFORE calling scheduler.activate().
 */
function appendQueued(runId: string): void {
  appendEvents([
    mkEnvelope('FAMILY_CREATED', runId, { family_id: 'fam1', label: 'fam1' }),
    mkEnvelope('RUN_QUEUED', runId, queuedPayload(runId)),
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

/**
 * Persist a RUNNING run with a specific heartbeat age
 * (for startup reconciliation tests). Simulates a run that was started
 * by a previous process and left in 'running' state.
 */
function appendRunning(runId: string, opts?: { heartbeatAgeMs?: number; ownerId?: string }): void {
  const heartbeatAgeMs = opts?.heartbeatAgeMs ?? 0;
  const ownerId = opts?.ownerId ?? 'old_process';
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

/**
 * Persist a CANCELLING run with a specific heartbeat age.
 * Simulates a run that was started by a previous process, entered
 * cancellation, then the process died before RUN_CANCELLED was appended.
 */
function appendCancelling(runId: string, opts?: { heartbeatAgeMs?: number; ownerId?: string }): void {
  const heartbeatAgeMs = opts?.heartbeatAgeMs ?? 0;
  const ownerId = opts?.ownerId ?? 'old_process';
  const now = Date.now();
  const heartbeatAt = new Date(now - heartbeatAgeMs).toISOString();
  const startedAt = new Date(now - heartbeatAgeMs - 1000).toISOString();
  appendEvents([
    mkEnvelope('FAMILY_CREATED', runId, { family_id: 'fam1', label: 'fam1' }),
    mkEnvelope('RUN_QUEUED', runId, queuedPayload(runId)),
    mkEnvelope('RUN_STARTING', runId, { runId, ownerId, startingAt: startedAt }),
    mkEnvelope('RUN_RUNNING', runId, { runId, ownerId, startedAt, heartbeatAt, leaseUntil: new Date(now + 60_000).toISOString() }),
    mkEnvelope('RUN_CANCELLATION_REQUESTED', runId, { runId, requestedAt: new Date(now - heartbeatAgeMs + 500).toISOString() }),
  ], liveContext());
}

/** Hanging deps: executeResearch blocks on abort, getProvider returns a dummy. */
function hangingDeps() {
  return {
    getProvider: async () => ({ name: 'p1', capabilities: {} as never, search: async () => [], read: async () => ({ url: '', title: '', content: '', contentHash: '' }), crawl: async () => [], academic: async () => [] }),
    appendWithRetry: (events: readonly unknown[], context: Parameters<typeof appendEvents>[1]) => { appendEvents(events as NewEventInput[], context); },
    rebuildAppendContext: () => liveContext(),
    rebuildProjection: () => rebuildProjection(handlers),
    executeResearch: async (_runId: string, _familyId: string, _input: unknown, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
}

const MINIMAL_TIMEOUT = 10_000;

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** All lifecycle-terminal event types per foldRunLedger()'s transition table. */
const TERMINAL_TYPES = ['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED', 'RUN_INTERRUPTED'];
function terminalEvents(runId: string) {
  return queryEvents({ runId }).filter((e) => TERMINAL_TYPES.includes(e.eventType));
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

// ── Graceful shutdown tests ──────────────────────────────────────────

describe('scheduler graceful shutdown', () => {
  it('aborts an ACTIVE run, appends RUN_INTERRUPTED "process shutdown", and returns promptly', async () => {
    let abortObserved = false;
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, {
      ...hangingDeps(),
      executeResearch: async (_runId, _familyId, _input, signal) => {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) { abortObserved = true; reject(new Error('aborted')); return; }
          signal.addEventListener('abort', () => { abortObserved = true; reject(new Error('aborted')); }, { once: true });
        });
      },
    });
    scheduler.start();

    // Production ordering: persist RUN_QUEUED first, then activate.
    appendQueued('run-active');
    await scheduler.activate(enqueued('run-active'));

    // Wait until the run is RUNNING before shutting down.
    await waitFor(() => queryEvents({ runId: 'run-active', eventType: 'RUN_RUNNING' }).length > 0, 'run never reached RUNNING');

    const startedAt = Date.now();
    await scheduler.shutdown();
    expect(Date.now() - startedAt).toBeLessThan(MINIMAL_TIMEOUT);
    expect(abortObserved).toBe(true);

    const interrupted = queryEvents({ runId: 'run-active', eventType: 'RUN_INTERRUPTED' });
    expect(interrupted.length).toBe(1);
    expect((interrupted[0]?.payload as { reason?: string }).reason).toBe('process shutdown');
    expect(queryEvents({ runId: 'run-active', eventType: 'RUN_CANCELLED' }).length).toBe(0);
  });

  it('marks orphaned queued runs as RUN_FAILED with recovery_unsupported (not resumed)', () => {
    // Pre-seed a queued run to simulate a truly orphaned run from a dead prior process.
    // This event is persisted BEFORE any scheduler for this runId exists.
    appendQueued('run-orphan');
    let providerCalled = false;
    let executeCalled = false;

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, {
      ...hangingDeps(),
      getProvider: async () => { providerCalled = true; return hangingDeps().getProvider(); },
      executeResearch: async () => { executeCalled = true; },
    });

    // At construction time, reconcileOnStartup should mark the run as FAILED.
    const failedEvents = queryEvents({ runId: 'run-orphan', eventType: 'RUN_FAILED' });
    expect(failedEvents.length).toBe(1);
    const error = (failedEvents[0]?.payload as { error?: Record<string, unknown> }).error;
    expect(error?.code).toBe('recovery_unsupported');
    expect(error?.classification).toBe('permanent');
    expect(error?.retryable).toBe(false);
    expect(typeof error?.message === 'string' ? error.message : '').toContain('cannot resume after process restart');

    // Provider and executeResearch must never be called for this run.
    expect(providerCalled).toBe(false);
    expect(executeCalled).toBe(false);

    // Ledger transition queued→failed must be legal.
    expect(() => foldRunLedger(queryEvents({}))).not.toThrow(RunHistoryCorruptionError);

    void scheduler;
  });

  it('lands the RUN_INTERRUPTED write durably BEFORE shutdown resolves (no silent swallow)', async () => {
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, hangingDeps());
    scheduler.start();
    appendQueued('run-order');
    await scheduler.activate(enqueued('run-order'));
    await waitFor(() => queryEvents({ runId: 'run-order', eventType: 'RUN_RUNNING' }).length > 0, 'run never reached RUNNING');

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

// ── Terminal-event exclusivity tests ─────────────────────────────────

describe('scheduler terminal-event exclusivity (shutdown/deadline/cancel race)', () => {
  it('shutdown racing a deadline-exceeded ACTIVE run lands EXACTLY ONE terminal event', async () => {
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, hangingDeps());
    scheduler.start();
    const deadlineAt = new Date(Date.now() + 200).toISOString();
    appendQueued('run-race-deadline');
    await scheduler.activate({ ...enqueued('run-race-deadline'), deadlineAt });
    await waitFor(() => queryEvents({ runId: 'run-race-deadline', eventType: 'RUN_RUNNING' }).length > 0, 'run never reached RUNNING');
    // Wait for the internal deadline timer to fire.
    await waitFor(() => Date.now() >= Date.parse(deadlineAt) + 50, 'deadline never became due', 1000);
    await scheduler.shutdown();

    expect(terminalEvents('run-race-deadline').length).toBe(1);
    // foldRunLedger must not throw — even if the events span multiple transitions.
    expect(() => foldRunLedger(queryEvents({}))).not.toThrow();
  });

  it('cancel invoked in the SAME TICK as shutdown yields EXACTLY ONE terminal event (CANCELLED, not INTERRUPTED)', async () => {
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, hangingDeps());
    scheduler.start();
    appendQueued('run-race-cancel');
    await scheduler.activate(enqueued('run-race-cancel'));
    await waitFor(() => queryEvents({ runId: 'run-race-cancel', eventType: 'RUN_RUNNING' }).length > 0, 'run never reached RUNNING');

    // Same synchronous tick: cancel claims first; shutdown's claim must lose.
    expect(scheduler.cancel('run-race-cancel')).toBe(true);
    await scheduler.shutdown();

    expect(queryEvents({ runId: 'run-race-cancel', eventType: 'RUN_CANCELLED' }).length).toBe(1);
    expect(queryEvents({ runId: 'run-race-cancel', eventType: 'RUN_INTERRUPTED' }).length).toBe(0);
    expect(terminalEvents('run-race-cancel').length).toBe(1);
    expect(() => foldRunLedger(queryEvents({}))).not.toThrow();
  });

  it('cancel after an independently-fired deadline yields EXACTLY ONE terminal event', async () => {
    const scheduler = new JobScheduler({ maxConcurrentRuns: 1 }, hangingDeps());
    scheduler.start();
    const deadlineAt = new Date(Date.now() + 200).toISOString();
    appendQueued('run-race-late-cancel');
    await scheduler.activate({ ...enqueued('run-race-late-cancel'), deadlineAt });
    await waitFor(() => queryEvents({ runId: 'run-race-late-cancel', eventType: 'RUN_RUNNING' }).length > 0, 'run never reached RUNNING');
    await waitFor(() => Date.now() >= Date.parse(deadlineAt) + 50, 'deadline never became due', 1000);
    // The deadline terminal has fired (or is firing); cancel must not add a second terminal event.
    scheduler.cancel('run-race-late-cancel');
    await scheduler.shutdown();

    expect(terminalEvents('run-race-late-cancel').length).toBe(1);
    expect(() => foldRunLedger(queryEvents({}))).not.toThrow();
  });
});

// ── Startup reconciliation: lease staleness ──────────────────────────

describe('scheduler startup reconciliation — lease staleness', () => {
  it('does NOT terminate a run with a fresh (non-stale) heartbeat', () => {
    // Persist a 'running' run with a recent heartbeat — another process might own it.
    appendRunning('run-fresh', { heartbeatAgeMs: 5_000 }); // well within 60s stale threshold

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, hangingDeps());

    // No RUN_INTERRUPTED should be appended — the lease is fresh.
    expect(queryEvents({ runId: 'run-fresh', eventType: 'RUN_INTERRUPTED' }).length).toBe(0);
    // Status should still be 'running' in the folded ledger.
    const folded = foldRunLedger(queryEvents({}));
    expect(folded.get('run-fresh')?.status).toBe('running');
    void scheduler;
  });

  it('terminates a stale running run → RUN_INTERRUPTED (core regression for orphaned-lease bug)', () => {
    // Persist a 'running' run with a stale heartbeat (> 60s ago) — the owner is dead.
    appendRunning('run-stale', { heartbeatAgeMs: 120_000 });

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, hangingDeps());

    // RUN_INTERRUPTED must be appended — the lease is stale.
    const events = queryEvents({ runId: 'run-stale', eventType: 'RUN_INTERRUPTED' });
    expect(events.length).toBe(1);
    expect((events[0]?.payload as { reason?: string }).reason).toBe('orphaned lease');

    // Ledger must fold cleanly.
    expect(() => foldRunLedger(queryEvents({}))).not.toThrow(RunHistoryCorruptionError);
    const folded = foldRunLedger(queryEvents({}));
    expect(folded.get('run-stale')?.status).toBe('interrupted');
    void scheduler;
  });

  it('terminates a stale cancelling run → RUN_CANCELLED', () => {
    // Persist a 'cancelling' run with a stale heartbeat.
    appendCancelling('run-stale-cancel', { heartbeatAgeMs: 120_000 });

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, hangingDeps());

    const events = queryEvents({ runId: 'run-stale-cancel', eventType: 'RUN_CANCELLED' });
    expect(events.length).toBe(1);

    expect(() => foldRunLedger(queryEvents({}))).not.toThrow(RunHistoryCorruptionError);
    const folded = foldRunLedger(queryEvents({}));
    expect(folded.get('run-stale-cancel')?.status).toBe('cancelled');
    void scheduler;
  });

  it('does NOT terminate a cancelling run with a fresh heartbeat', () => {
    appendCancelling('run-fresh-cancel', { heartbeatAgeMs: 5_000 });

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, hangingDeps());

    expect(queryEvents({ runId: 'run-fresh-cancel', eventType: 'RUN_CANCELLED' }).length).toBe(0);
    const folded = foldRunLedger(queryEvents({}));
    expect(folded.get('run-fresh-cancel')?.status).toBe('cancelling');
    void scheduler;
  });

  it('terminates a stale starting run → RUN_INTERRUPTED', () => {
    // Persist a 'starting' run with no heartbeatAt at all (never got to RUNNING).
    const now = Date.now();
    const startedAt = new Date(now - 120_000).toISOString();
    appendEvents([
      mkEnvelope('FAMILY_CREATED', 'run-stale-starting', { family_id: 'fam1', label: 'fam1' }),
      mkEnvelope('RUN_QUEUED', 'run-stale-starting', queuedPayload('run-stale-starting')),
      mkEnvelope('RUN_STARTING', 'run-stale-starting', { runId: 'run-stale-starting', ownerId: 'dead_proc', startingAt: startedAt }),
    ], liveContext());

    const scheduler = new JobScheduler({ maxConcurrentRuns: 2 }, hangingDeps());

    const events = queryEvents({ runId: 'run-stale-starting', eventType: 'RUN_INTERRUPTED' });
    expect(events.length).toBe(1);
    expect((events[0]?.payload as { reason?: string }).reason).toBe('orphaned lease');
    void scheduler;
  });
});
