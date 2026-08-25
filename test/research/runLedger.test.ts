import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldRunLedger, RunHistoryCorruptionError } from '../../src/research/runLedger.js';
import type { EventEnvelope } from '../../src/store/eventTypes.js';
import type { RunFollowUp } from '../../src/research/types.js';
import { appendEvents, closeDb, createEmptyProjectionState, initDb, queryEvents } from '../../src/store/index.js';

function e(
  eventType: EventEnvelope['eventType'],
  runId = 'r',
  payload: unknown = {},
  eventVersion = 1,
): EventEnvelope {
  return {
    seq: 1,
    id: crypto.randomUUID(),
    timestamp: '2025-01-01T00:00:00.000Z',
    eventType,
    eventVersion,
    runId,
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload,
    payloadHash: '',
  };
}

function queued(runId = 'r', followUp?: RunFollowUp): EventEnvelope {
  return e('RUN_QUEUED', runId, {
    runId,
    rootRunId: runId,
    familyId: 'f',
    query: 'q',
    strategy: 'pipeline',
    depth: 'standard',
    providerName: 'p',
    requestHash: 'h',
    retryPolicy: {
      maxAttempts: 3,
      autoRetry: false,
      initialBackoffMs: 1000,
      maxBackoffMs: 30000,
    },
    deadlineAt: '2025-02-01',
    attempt: 1,
    queuedAt: '2025-01-01',
    ...(followUp ? { followUp } : {}),
  });
}

describe('RunLedger', () => {
  it('carries optional follow-up metadata from queued events', () => {
    const followUp: RunFollowUp = {
      kind: 'information_gain_v1', targetType: 'gap', targetId: 'gap-1', sourceRunId: 'source-run',
    };
    expect(foldRunLedger([queued('with-follow-up', followUp)]).get('with-follow-up')?.followUp).toEqual(followUp);
    expect(foldRunLedger([queued('without-follow-up')]).get('without-follow-up')?.followUp).toBeUndefined();
  });

  it('folds queued, starting, running, progress, heartbeat, and completed events', () => {
    const events = [
      queued(),
      e('RUN_STARTING', 'r', { runId: 'r', ownerId: 'o', startingAt: 's' }),
      e('RUN_RUNNING', 'r', {
        runId: 'r',
        ownerId: 'o',
        startedAt: 't',
        heartbeatAt: 'h',
        leaseUntil: 'l',
      }),
      e('RUN_PROGRESS', 'r', { runId: 'r', phase: 'read', percent: 50 }),
      e('RUN_HEARTBEAT', 'r', {
        runId: 'r',
        ownerId: 'o',
        heartbeatAt: 'h2',
        leaseUntil: 'l2',
      }),
      e('RUN_COMPLETED', 'r', { runId: 'r', claimCount: 2 }),
    ];

    const run = foldRunLedger(events).get('r');

    expect(run?.status).toBe('completed');
    expect(run?.progress.phase).toBe('read');
    expect(run?.heartbeatAt).toBe('h2');
    expect(run?.claimCount).toBe(2);
  });

  it('folds queued, starting, running, cancelling, and cancelled events', () => {
    const events = [
      queued(),
      e('RUN_STARTING', 'r', { runId: 'r', ownerId: 'o', startingAt: 's' }),
      e('RUN_RUNNING', 'r', {
        runId: 'r',
        ownerId: 'o',
        startedAt: 't',
        heartbeatAt: 'h',
        leaseUntil: 'l',
      }),
      e('RUN_CANCELLATION_REQUESTED', 'r', { runId: 'r', requestedAt: 'x' }),
      e('RUN_CANCELLED', 'r', { runId: 'r' }),
    ];

    expect(foldRunLedger(events).get('r')?.status).toBe('cancelled');
  });

  it('folds starting to interrupted', () => {
    const events = [
      queued(),
      e('RUN_STARTING', 'r', { runId: 'r', ownerId: 'o', startingAt: 's' }),
      e('RUN_INTERRUPTED', 'r', {
        runId: 'r',
        interruptedAt: 'i',
        reason: 'stop',
      }),
    ];

    expect(foldRunLedger(events).get('r')?.status).toBe('interrupted');
  });

  it('folds rollback after completed', () => {
    const events = [
      queued(),
      e('RUN_STARTING', 'r', { runId: 'r', ownerId: 'o', startingAt: 's' }),
      e('RUN_RUNNING', 'r', {
        runId: 'r',
        ownerId: 'o',
        startedAt: 't',
        heartbeatAt: 'h',
        leaseUntil: 'l',
      }),
      e('RUN_COMPLETED', 'r', { runId: 'r' }),
      e('RUN_ROLLED_BACK', 'r', { run_id: 'r' }),
    ];

    expect(foldRunLedger(events).get('r')?.status).toBe('rolled_back');
  });

  it('rejects completed directly from queued', () => {
    expect(() => foldRunLedger([queued(), e('RUN_COMPLETED', 'r', { runId: 'r' })])).toThrow(RunHistoryCorruptionError);
  });

  it('rejects running without queue initialization', () => {
    expect(() => foldRunLedger([
      e('RUN_RUNNING', 'r', {
        runId: 'r',
        ownerId: 'o',
        startedAt: 't',
        heartbeatAt: 'h',
        leaseUntil: 'l',
      }),
    ])).toThrow(RunHistoryCorruptionError);
  });

  it('rejects queueing after a run is already running', () => {
    const events = [
      queued(),
      e('RUN_STARTING', 'r', { runId: 'r', ownerId: 'o', startingAt: 's' }),
      e('RUN_RUNNING', 'r', {
        runId: 'r',
        ownerId: 'o',
        startedAt: 't',
        heartbeatAt: 'h',
        leaseUntil: 'l',
      }),
      queued(),
    ];

    expect(() => foldRunLedger(events)).toThrow(RunHistoryCorruptionError);
  });

  it('rejects cancellation directly from queued', () => {
    expect(() => foldRunLedger([queued(), e('RUN_CANCELLED', 'r', { runId: 'r' })])).toThrow(RunHistoryCorruptionError);
  });

  it('folds legacy RUN_STARTED-only compatibility events', () => {
    const run = foldRunLedger([
      e('RUN_STARTED', 'old', {
        runId: 'old',
        familyId: 'f',
        query: 'q',
        strategy: 'pipeline',
      }),
    ]).get('old');

    expect(run?.status).toBe('running');
    expect(run?.rootRunId).toBe('old');
  });

  it('upcasts legacy RUN_FAILED payloads', () => {
    const run = foldRunLedger([
      e('RUN_STARTED', 'r', {
        runId: 'r',
        familyId: 'f',
        query: 'q',
        strategy: 'pipeline',
      }),
      e('RUN_FAILED', 'r', { runId: 'r', error: 'bad' }, 1),
    ]).get('r');

    expect(run?.error?.message).toBe('bad');
  });

  it('round-trips appended v1 RUN_FAILED payloads as normalized v2 events', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-run-ledger-'));
    try {
      initDb(path.join(dir, 'events.db'));
      appendEvents([{
        timestamp: '2025-01-01T00:00:00.000Z', eventType: 'RUN_FAILED', eventVersion: 1,
        runId: 'r', batchId: null, actor: 'system', entityId: null, entityType: null,
        payload: { runId: 'r', error: 'bad' },
      }], { projection: createEmptyProjectionState(), handlers: {} });

      const replayed = queryEvents();
      expect(replayed[0]?.eventVersion).toBe(2);
      expect(replayed[0]?.payload).toEqual({
        runId: 'r',
        error: { code: 'legacy', classification: 'internal', message: 'bad', retryable: false, occurredAt: '1970-01-01T00:00:00.000Z' },
      });
      const run = foldRunLedger([
        e('RUN_STARTED', 'r', { runId: 'r', familyId: 'f', query: 'q', strategy: 'pipeline' }),
        ...replayed,
      ]).get('r');
      expect(run?.error?.message).toBe('bad');
    } finally {
      closeDb();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects payload runId that differs from envelope runId', () => {
    expect(() => foldRunLedger([e('RUN_QUEUED', 'envelope-run', {
      ...queued('payload-run').payload as Record<string, unknown>,
    })])).toThrow(RunHistoryCorruptionError);
  });
});
