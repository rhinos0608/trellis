/**
 * Transport-independent research application service.
 *
 * Wraps the existing RunService for run-lifecycle operations and owns the
 * list/history/event-paging logic that was previously embedded inline in
 * the MCP tool handler. Transport adapters (MCP today, SSE later) call
 * these typed methods and shape the response for their wire format.
 *
 * Errors are typed application errors (errors.ts) — never generic
 * `{ error: message }` records. The caller decides how to render them.
 */

import type { RunService, RetryRunInput, ContinueResearchInput, ContinueResearchResult, RunStatus } from '../research/runService.js';
import { rollbackRunById } from '../research/runService.js';
import { foldRunLedger, LIFECYCLE_EVENT_TYPES } from '../research/runLedger.js';
import { queryEvents } from '../store/events.js';
import type { EventEnvelope } from '../store/eventTypes.js';
import type { ResearchProvider } from '../providers/types.js';
import type { TrellisConfig } from '../config/index.js';
import { ApplicationError, toApplicationError, RunNotFoundError, InvalidTransitionError } from './errors.js';
import type { RunSummaryDto, RunEventDto, RunHistoryDto, ListRunsInput, ListRunEventsInput } from './types.js';

export interface StartRunInput {
  query: string;
  strategy?: 'agent' | undefined;
  depth?: string | undefined;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  /** Explicit family ID — skips family resolution. */
  familyId?: string | undefined;
  idempotencyKey?: string | undefined;
  deadlineMs?: number | undefined;
}

export interface RunHistoryOptions {
  limit?: number | undefined;
}

export interface ResearchApplicationServiceDeps {
  runService: RunService;
  config: TrellisConfig;
  /** Resolved lazily — only needed for `start`. */
  getProvider(): Promise<ResearchProvider>;
}

export interface RollbackResult {
  skipped: number;
  executed: number;
  blocked: { eventId: string; reason: string }[];
  readModelRebuilt: boolean;
  readModelError?: string;
}

export interface ResearchApplicationService {
  startRun(input: StartRunInput): Promise<{ runId: string; familyId: string }>;
  getRun(runId: string): RunSummaryDto | null;
  listRuns(input?: ListRunsInput): RunSummaryDto[];
  getRunHistory(runId: string, opts?: RunHistoryOptions): RunHistoryDto;
  cancelRun(runId: string): Promise<{ cancelled: boolean }>;
  retryRun(input: RetryRunInput): Promise<{ runId: string; familyId: string; deduplicated: boolean }>;
  continueResearch(input: ContinueResearchInput): Promise<ContinueResearchResult>;
  rollbackRun(runId: string): RollbackResult;
  listRunEvents(input: ListRunEventsInput): RunEventDto[];
}

// ── Bounded lifecycle event paging (listRunEvents) ───────────────────

const LIST_RUN_EVENTS_DEFAULT_LIMIT = 100;
const LIST_RUN_EVENTS_MAX_LIMIT = 500;

function resolveLimit(limit: number | undefined, fallback: number, maximum: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApplicationError('INVALID_LIMIT', `Limit must be a positive integer, got: ${String(limit)}`);
  }
  return Math.min(limit, maximum);
}

/**
 * Whitelisted payload fields per lifecycle event type. Everything else in
 * the stored payload (request hashes, retry policies, lease internals,
 * provider activity detail) stays internal.
 */
const SAFE_PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  RUN_QUEUED: ['runId', 'rootRunId', 'attempt', 'familyId', 'query', 'strategy', 'depth', 'queuedAt', 'retryOf'],
  RUN_STARTED: ['runId', 'familyId', 'query', 'strategy'],
  RUN_STARTING: ['runId', 'ownerId', 'startingAt'],
  RUN_RUNNING: ['runId', 'ownerId', 'startedAt'],
  RUN_PROGRESS: ['runId', 'phase', 'percent', 'message', 'counts'],
  RUN_COMPLETED: ['runId', 'entityCount', 'claimCount', 'sourceCount', 'evidenceCount'],
  RUN_FAILED: ['runId', 'error'],
  RUN_CANCELLED: ['runId', 'reason'],
  RUN_CANCELLATION_REQUESTED: ['runId', 'requestedAt', 'reason'],
  RUN_INTERRUPTED: ['runId', 'interruptedAt', 'reason'],
  RUN_ROLLED_BACK: ['run_id'],
};

function toSafePayload(event: EventEnvelope): Record<string, unknown> {
  const allow = SAFE_PAYLOAD_FIELDS[event.eventType];
  if (!allow) return {};
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of allow) {
    if (payload[field] !== undefined && payload[field] !== null) out[field] = payload[field];
  }
  return out;
}

// ── Service factory ──────────────────────────────────────────────────

export function createResearchApplicationService(
  deps: ResearchApplicationServiceDeps,
): ResearchApplicationService {
  const { runService } = deps;

  return {
    async startRun(input: StartRunInput): Promise<{ runId: string; familyId: string }> {
      try {
        const provider = await deps.getProvider();
        return await runService.startRun({
          query: input.query,
          provider,
          config: deps.config,
          ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
          ...(input.familyId !== undefined ? { explicitFamilyId: input.familyId } : {}),
        });
      } catch (err) {
        throw toApplicationError(err);
      }
    },

    getRun(runId: string): RunSummaryDto | null {
      try {
        const status: RunStatus | null = runService.getStatus(runId);
        return status === null ? null : { ...status };
      } catch (err) {
        throw toApplicationError(err);
      }
    },

    listRuns(input: ListRunsInput = {}): RunSummaryDto[] {
      try {
        const events = queryEvents({});
        const runs = foldRunLedger(events);
        let filtered = [...runs.values()];
        if (input.status) filtered = filtered.filter((run) => run.status === input.status);
        if (input.familyId) filtered = filtered.filter((run) => run.familyId === input.familyId);
        if (input.beforeSeq !== undefined) {
          const beforeSeq = input.beforeSeq;
          const runIds = new Set(events.filter((event) => event.seq < beforeSeq && event.eventType === 'RUN_QUEUED').map((event) => event.runId));
          filtered = filtered.filter((run) => runIds.has(run.runId));
        }
        filtered.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0));
        const limit = resolveLimit(input.limit, 50, 100);
        return filtered.slice(0, limit).map((run) => ({
          runId: run.runId,
          status: run.status,
          query: run.query,
          familyId: run.familyId,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          strategy: run.strategy,
        }));
      } catch (err) {
        throw toApplicationError(err);
      }
    },

    getRunHistory(runId: string, opts: RunHistoryOptions = {}): RunHistoryDto {
      try {
        const runEvents = queryEvents({ runId });
        const lifecycleEvents = runEvents.filter((event) => LIFECYCLE_EVENT_TYPES.has(event.eventType));
        const limit = resolveLimit(opts.limit, 100, 500);
        return {
          runId,
          events: lifecycleEvents.slice(0, limit).map((event) => ({
            seq: event.seq,
            eventType: event.eventType,
            timestamp: event.timestamp,
            payload: toSafePayload(event),
          })),
        };
      } catch (err) {
        throw toApplicationError(err);
      }
    },

    async cancelRun(runId: string): Promise<{ cancelled: boolean }> {
      try {
        return { cancelled: runService.cancelRun(runId) };
      } catch (err) {
        throw toApplicationError(err);
      }
    },

    async retryRun(input: RetryRunInput): Promise<{ runId: string; familyId: string; deduplicated: boolean }> {
      try {
        return await runService.retryRun(input);
      } catch (err) {
        if (err instanceof InvalidTransitionError || err instanceof RunNotFoundError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        // RunService signals these cases via plain Error messages; translate
        // them here so callers only ever see typed application errors.
        if (message.startsWith('Run not found:')) throw new RunNotFoundError(input.runId);
        if (message.startsWith('Cannot retry run in status:') || message.startsWith('Run error is not retryable:')) {
          throw new InvalidTransitionError(message, { runId: input.runId });
        }
        throw toApplicationError(err);
      }
    },

    async continueResearch(input: ContinueResearchInput): Promise<ContinueResearchResult> {
      try {
        return await runService.continueResearch(input);
      } catch (err) {
        throw toApplicationError(err);
      }
    },

    rollbackRun(runId: string): RollbackResult {
      try {
        const outcome = rollbackRunById(runId);
        return {
          skipped: outcome.skipped,
          executed: outcome.executed,
          blocked: outcome.blocked,
          readModelRebuilt: outcome.readModelRebuilt,
          ...(outcome.readModelError === undefined ? {} : { readModelError: outcome.readModelError }),
        };
      } catch (err) {
        throw toApplicationError(err);
      }
    },

    listRunEvents(input: ListRunEventsInput): RunEventDto[] {
      try {
        const limit = resolveLimit(input.limit, LIST_RUN_EVENTS_DEFAULT_LIMIT, LIST_RUN_EVENTS_MAX_LIMIT);
        const events = queryEvents({
          runId: input.runId,
          ...(input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : {}),
        });
        // Heartbeats are internal lease plumbing — noise for an external
        // history/events API (Stage 8B's SSE stream excludes them too).
        return events
          .filter((event) => LIFECYCLE_EVENT_TYPES.has(event.eventType) && event.eventType !== 'RUN_HEARTBEAT')
          .slice(0, limit)
          .map((event) => ({
            seq: event.seq,
            eventType: event.eventType,
            timestamp: event.timestamp,
            payload: toSafePayload(event),
          }));
      } catch (err) {
        throw toApplicationError(err);
      }
    },
  };
}
