import type { z } from 'zod';
import type { EventEnvelope } from '../store/eventTypes.js';
import {
  runCancellationRequestedPayload,
  runCancelledPayloadV2,
  runCompletedPayload,
  runFailedPayloadV2,
  runHeartbeatPayload,
  runInterruptedPayload,
  runProgressPayload,
  runQueuedPayload,
  runRolledBackPayload,
  runRunningPayload,
  runStartedPayload,
  runStartingPayload,
} from '../store/eventSchemas/research.js';
import { decodeEventPayload } from '../store/eventValidation.js';
import type { ResearchRun, ResearchRunStatus, RunError, RunRetryPolicy } from './types.js';

const defaults: RunRetryPolicy = { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1000, maxBackoffMs: 30000 };
export const LIFECYCLE_EVENT_TYPES = new Set([
  'RUN_QUEUED', 'RUN_STARTING', 'RUN_RUNNING', 'RUN_PROGRESS', 'RUN_HEARTBEAT',
  'RUN_CANCELLATION_REQUESTED', 'RUN_INTERRUPTED', 'RUN_STARTED', 'RUN_COMPLETED',
  'RUN_FAILED', 'RUN_CANCELLED', 'RUN_ROLLED_BACK',
]);
const lifecycle = LIFECYCLE_EVENT_TYPES;
const transitions: Record<string, Partial<Record<ResearchRunStatus | 'none', ResearchRunStatus>>> = {
  RUN_QUEUED:{none:'queued'}, RUN_STARTING:{queued:'starting'}, RUN_RUNNING:{starting:'running'},
  RUN_CANCELLATION_REQUESTED:{queued:'cancelling',starting:'cancelling',running:'cancelling'},
  RUN_CANCELLED:{cancelling:'cancelled'}, RUN_FAILED:{queued:'failed',starting:'failed',running:'failed'},
  RUN_COMPLETED:{running:'completed'}, RUN_INTERRUPTED:{starting:'interrupted',running:'interrupted'},
  RUN_ROLLED_BACK:{completed:'rolled_back',failed:'rolled_back',cancelled:'rolled_back',interrupted:'rolled_back'},
  RUN_STARTED:{none:'running'}, RUN_PROGRESS:{running:'running'}, RUN_HEARTBEAT:{starting:'starting',running:'running',cancelling:'cancelling'},
};

export class RunHistoryCorruptionError extends Error {
  constructor(runId: string, fromStatus: string, eventType: string, reason: string) {
    super(`Corrupt run history ${runId}: ${fromStatus} + ${eventType}: ${reason}`);
    this.name = 'RunHistoryCorruptionError';
  }
}

function decodeLifecyclePayload(event: EventEnvelope, from: string): unknown {
  const payload = decodeEventPayload(event.eventType, event.eventVersion, event.payload).payload;
  if (typeof payload === 'object' && payload !== null && 'runId' in payload && payload.runId !== event.runId) {
    throw new RunHistoryCorruptionError(event.runId, from, event.eventType, 'payload runId does not match envelope runId');
  }
  return payload;
}

function legacyRun(e: EventEnvelope, p: z.infer<typeof runStartedPayload>): ResearchRun {
  // Legacy events lack queue metadata; reconstruct lossy values with explicit sentinels.
  return {
    runId: p.runId,
    rootRunId: p.runId,
    attempt: 1,
    familyId: p.familyId,
    threadId: p.threadId,
    sessionId: p.sessionId,
    query: p.query,
    topic: p.topic,
    strategy: p.strategy,
    depth: 'standard',
    providerName: 'legacy',
    status: 'running',
    requestHash: '',
    retryPolicy: { ...defaults },
    createdAt: e.timestamp,
    queuedAt: e.timestamp,
    startedAt: e.timestamp,
    deadlineAt: '9999-12-31T23:59:59.999Z',
    progress: { phase: 'running' },
  } as ResearchRun;
}

export function foldRunLedger(events: EventEnvelope[]): Map<string, ResearchRun> {
  const runs = new Map<string, ResearchRun>();
  for (const event of events) {
    if (!lifecycle.has(event.eventType)) continue;
    const id = event.runId;
    const current = runs.get(id);
    const from = current?.status ?? 'none';
    const next = transitions[event.eventType]?.[from];
    if (next === undefined) throw new RunHistoryCorruptionError(id, from, event.eventType, 'illegal transition');

    if (event.eventType === 'RUN_STARTED') {
      const started = decodeLifecyclePayload(event, from) as z.infer<typeof runStartedPayload>;
      runs.set(id, legacyRun(event, started));
      continue;
    }
    if (!current && event.eventType !== 'RUN_QUEUED') throw new RunHistoryCorruptionError(id, from, event.eventType, 'run not initialized');
    if (!current) {
      const queued = decodeLifecyclePayload(event, from) as z.infer<typeof runQueuedPayload>;
      const run = { ...queued, status: next, createdAt: queued.queuedAt, progress: { phase: 'queued' } } as ResearchRun;
      if (queued.followUp) run.followUp = queued.followUp;
      runs.set(id, run);
      continue;
    }
    const decodedPayload = decodeLifecyclePayload(event, from);
    current.status = next;
    switch (event.eventType) {
      case 'RUN_STARTING': {
        const starting = decodedPayload as z.infer<typeof runStartingPayload>;
        current.ownerId = starting.ownerId;
        current.startingAt = starting.startingAt;
        break;
      }
      case 'RUN_RUNNING': {
        const running = decodedPayload as z.infer<typeof runRunningPayload>;
        current.ownerId = running.ownerId;
        current.startedAt = running.startedAt;
        current.heartbeatAt = running.heartbeatAt;
        current.leaseUntil = running.leaseUntil;
        break;
      }
      case 'RUN_PROGRESS': {
        const progress = decodedPayload as z.infer<typeof runProgressPayload>;
        current.progress = progress as ResearchRun['progress'];
        break;
      }
      case 'RUN_HEARTBEAT': {
        const heartbeat = decodedPayload as z.infer<typeof runHeartbeatPayload>;
        current.ownerId = heartbeat.ownerId;
        current.heartbeatAt = heartbeat.heartbeatAt;
        current.leaseUntil = heartbeat.leaseUntil;
        break;
      }
      case 'RUN_COMPLETED': {
        const completed = decodedPayload as z.infer<typeof runCompletedPayload>;
        current.completedAt = event.timestamp;
        Object.assign(current, completed);
        break;
      }
      case 'RUN_FAILED': {
        const failed = decodedPayload as z.infer<typeof runFailedPayloadV2>;
        current.failedAt = event.timestamp;
        current.error = failed.error as RunError;
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- compatibility field is part of ResearchRun.
        current.lastError = current.error.message;
        break;
      }
      case 'RUN_CANCELLED': {
        const cancelled = decodedPayload as z.infer<typeof runCancelledPayloadV2>;
        current.cancelledAt = event.timestamp;
        if (cancelled.reason) current.error = { code: 'cancelled', classification: 'cancelled', message: cancelled.reason, retryable: false, occurredAt: event.timestamp };
        break;
      }
      case 'RUN_INTERRUPTED': {
        const interrupted = decodedPayload as z.infer<typeof runInterruptedPayload>;
        current.interruptedAt = interrupted.interruptedAt;
        if (interrupted.reason) current.error = { code: 'interrupted', classification: 'interrupted', message: interrupted.reason, retryable: false, occurredAt: event.timestamp };
        break;
      }
      case 'RUN_CANCELLATION_REQUESTED': {
        const requested = decodedPayload as z.infer<typeof runCancellationRequestedPayload>;
        void requested;
        break;
      }
      case 'RUN_ROLLED_BACK': {
        const rolledBack = decodedPayload as z.infer<typeof runRolledBackPayload>;
        void rolledBack;
        break;
      }
    }
  }
  return runs;
}
