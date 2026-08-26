/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { randomUUID } from 'node:crypto';
import type { AppendContext, NewEventInput } from '../store/events.js';
import { hashPayload, queryEvents } from '../store/events.js';
import { logger, safeErrorLog } from '../logger.js';
import type { ProjectionState } from '../store/projectionState.js';
import type { ProviderCallContext, ResearchProvider } from '../providers/types.js';
import type { ResearchStrategy, ResearchRun, RunError, RunRetryPolicy, RunProgressUpdate, RunFollowUp } from './types.js';
import { foldRunLedger } from './runLedger.js';
import { classifyError } from './retry.js';
import type { StartRunInput, RunStatus } from './runService.js';

export interface SchedulerOptions {
  maxConcurrentRuns?: number;
  maxConcurrentCallsPerProvider?: number;
  heartbeatIntervalMs?: number;
  leaseDurationMs?: number;
  defaultDeadlineMs?: number;
  progressMinIntervalMs?: number;
}
export interface SchedulerDeps {
  getProvider(name: string): Promise<ResearchProvider>;
  appendWithRetry(events: readonly NewEventInput[], context: AppendContext): void;
  /** Rebuild an AppendContext for a run enqueued by a previous process (resume path). */
  rebuildAppendContext?(): AppendContext | undefined;
  executeResearch(runId: string, familyId: string, input: StartRunInput, signal: AbortSignal, provider: ResearchProvider, providerCtx: ProviderCallContext, reportProgress: (update: RunProgressUpdate) => Promise<void>): Promise<void>;
  rebuildProjection(): ProjectionState;
}
export interface EnqueuedRun {
  runId: string; rootRunId: string; attempt: number; familyId: string; threadId?: string | undefined; sessionId?: string | undefined;
  query: string; topic?: string | undefined; strategy: ResearchStrategy; depth: string; providerName: string;
  idempotencyKey?: string | undefined; requestHash: string; retryPolicy: RunRetryPolicy; deadlineAt: string; queuedAt: string;
  appendContext: AppendContext; input?: StartRunInput | undefined; retryOf?: string | undefined; followUp?: RunFollowUp | undefined;
}
export class IdempotencyConflictError extends Error { constructor() { super('Idempotency key conflicts with a different request'); this.name = 'IdempotencyConflictError'; } }

const defaults: Required<SchedulerOptions> = { maxConcurrentRuns: 2, maxConcurrentCallsPerProvider: 4, heartbeatIntervalMs: 15_000, leaseDurationMs: 60_000, defaultDeadlineMs: 600_000, progressMinIntervalMs: 1_000 };
const envelope = (eventType: NewEventInput['eventType'], runId: string, payload: unknown): NewEventInput => ({ timestamp: new Date().toISOString(), eventType, eventVersion: 1, runId, batchId: null, actor: 'system', entityId: runId, entityType: 'run', payload });

export class JobScheduler {
  private readonly opts: Required<SchedulerOptions>;
  private readonly ownerId = `process_${randomUUID().slice(0, 12)}`;
  private readonly runs = new Map<string, ResearchRun>();
  private readonly inputs = new Map<string, StartRunInput>();
  private readonly contexts = new Map<string, AppendContext>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Set<Promise<void>>();
  private running = false;
  private stopping = false;
  private active = 0;
  private wake?: () => void;
  private shutdownPromise?: Promise<void>;
  /** Runs whose terminal event (INTERRUPTED/CANCELLED/FAILED) is already claimed. */
  private readonly terminalClaimed = new Set<string>();
  constructor(options: SchedulerOptions = {}, private readonly deps: SchedulerDeps) {
    this.opts = { ...defaults, ...options };
    this.reconcileOnStartup();
  }
  start(): void { if (this.running) return; this.running = true; this.stopping = false; void this.loop(); }
  /**
   * Abort every ACTIVE run and record RUN_INTERRUPTED for each (external
   * termination — NOT user cancellation), then wait for executions to unwind
   * promptly instead of waiting out their deadlines. QUEUED runs are left
   * untouched: reconcileOnStartup() re-queues them on next process start.
   * Callers MUST keep the DB open until this resolves (shutdownCliRuntime
   * ordering: scheduler → provider → transport → DB last).
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    this.stopping = true; this.running = false; this.wake?.();
    this.shutdownPromise = (async () => {
      for (const [runId, controller] of this.controllers) {
        controller.abort();
        // Atomically claim terminal ownership FIRST so a concurrently firing
        // deadline/cancel path cannot append a second terminal event.
        this.claimTerminal(runId, [envelope('RUN_INTERRUPTED', runId, { runId, interruptedAt: new Date().toISOString(), reason: 'process shutdown' })]);
      }
      await Promise.all([...this.executions]);
    })();
    return this.shutdownPromise;
  }
  async enqueue(input: EnqueuedRun): Promise<{ runId: string; familyId: string; deduplicated: boolean }> {
    const spec = JSON.stringify({ query: input.query, strategy: input.strategy, depth: input.depth, topic: input.topic, familyId: input.familyId, threadId: input.threadId, sessionId: input.sessionId, providerName: input.providerName, deadlineAt: input.deadlineAt, retryPolicy: input.retryPolicy, followUp: input.followUp });
    const requestHash = input.requestHash || hashPayload(spec);
    for (const run of this.runs.values()) if (input.idempotencyKey && run.idempotencyKey === input.idempotencyKey) {
      if (run.requestHash !== requestHash) throw new IdempotencyConflictError();
      return { runId: run.runId, familyId: run.familyId, deduplicated: true };
    }
    if (this.stopping) throw new Error('Scheduler is shut down');
        const run = { ...input, requestHash, queuedAt: input.queuedAt || new Date().toISOString() } as unknown as ResearchRun;
    this.runs.set(run.runId, run); this.contexts.set(run.runId, input.appendContext); if (input.input) this.inputs.set(run.runId, input.input); this.queue.push(run.runId); this.wake?.();
    return { runId: run.runId, familyId: run.familyId, deduplicated: false };
  }
  cancel(runId: string): boolean {
    const run = this.current(runId); if (!run || ['completed','failed','cancelled','interrupted'].includes(run.status)) return false;
    const events = [envelope('RUN_CANCELLATION_REQUESTED', runId, { runId, requestedAt: new Date().toISOString() }), envelope('RUN_CANCELLED', runId, { runId })];
    const claimed = this.claimTerminal(runId, events);
    if (!claimed) return false;
    if (run.status === 'queued') {
      this.runs.set(runId, { ...run, status: 'cancelled' }); return true;
    }
    this.controllers.get(runId)?.abort(); return true;
  }
  getStatus(runId: string): RunStatus | null {
    const run = this.current(runId); if (!run) return null;
    return { runId, familyId: run.familyId, status: run.status, query: run.query, progress: run.progress, startedAt: run.startedAt ?? run.createdAt, ...(run.completedAt ? { completedAt: run.completedAt } : {}), ...(run.failedAt ? { failedAt: run.failedAt } : {}), ...(run.cancelledAt ? { cancelledAt: run.cancelledAt } : {}), ...(run.error ? { lastError: run.error.message } : {}) };
  }
  reconcileOnStartup(): void {
    let folded: Map<string, ResearchRun>;
    try { folded = foldRunLedger(queryEvents({})); } catch { return; }
    for (const run of folded.values()) {
      this.runs.set(run.runId, run);
      if (run.status === 'queued') {
        // Re-queue BEFORE the context guard: a run queued by a previous
        // process has no live AppendContext yet, but must still be resumed.
        if (Date.parse(run.deadlineAt) <= Date.now()) {
          if (this.context(run.runId) === undefined) continue;
          this.fail(run, 'deadline exceeded', 'deadline_exceeded');
        } else {
          this.queue.push(run.runId);
        }
        continue;
      }
      const context = this.context(run.runId); if (!context) continue;
      else if (run.status === 'starting' || run.status === 'running') {
        const stale = !run.heartbeatAt || Date.now() - Date.parse(run.heartbeatAt) > this.opts.heartbeatIntervalMs * 4;
        if (stale) this.append([envelope('RUN_INTERRUPTED', run.runId, { runId: run.runId, interruptedAt: new Date().toISOString(), reason: 'orphaned lease', previousOwnerId: run.ownerId })], context);
      } else if (run.status === 'cancelling' && (!run.heartbeatAt || Date.now() - Date.parse(run.heartbeatAt) > this.opts.heartbeatIntervalMs * 4)) {
        this.append([envelope('RUN_CANCELLED', run.runId, { runId: run.runId })], context);
      }
    }
  }
  private async loop(): Promise<void> { while (this.running || this.active > 0) { while (this.running && this.active < this.opts.maxConcurrentRuns) { const id = this.queue.find((x) => this.current(x)?.status === 'queued'); if (!id) break; this.active++; const p = this.execute(id).finally(() => { this.active--; this.executions.delete(p); }); this.executions.add(p); } if (this.active === 0 && !this.running) break; await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 100); this.wake = () => { clearTimeout(timer); resolve(); }; }); } }
  private async execute(runId: string): Promise<void> {
    const run = this.current(runId); let context = this.context(runId);
    if (!run) return;
    if (context === undefined) {
      // Resumed from a previous process — rebuild a live AppendContext.
      const rebuilt = this.deps.rebuildAppendContext?.();
      if (rebuilt === undefined) return;
      this.contexts.set(runId, rebuilt); context = rebuilt;
    }
    if (run.status !== 'queued') return;
    const now = new Date(); const deadline = Date.parse(run.deadlineAt); if (deadline <= now.getTime()) { this.fail(run, 'deadline exceeded', 'deadline_exceeded'); return; }
    this.append([envelope('RUN_STARTING', runId, { runId, ownerId: this.ownerId, startingAt: now.toISOString() }), envelope('RUN_RUNNING', runId, { runId, ownerId: this.ownerId, startedAt: now.toISOString(), heartbeatAt: now.toISOString(), leaseUntil: new Date(now.getTime() + this.opts.leaseDurationMs).toISOString() })], context);
    const controller = new AbortController(); this.controllers.set(runId, controller);
    const heartbeat = setInterval(() => { const c = this.context(runId); if (c) this.append([envelope('RUN_HEARTBEAT', runId, { runId, ownerId: this.ownerId, heartbeatAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + this.opts.leaseDurationMs).toISOString() })], c); }, this.opts.heartbeatIntervalMs);
    let deadlineExceeded = false; let lastProgressAt = 0; let lastPhase: string | undefined; let pendingProgress: RunProgressUpdate | undefined;
    const reportProgress = async (update: RunProgressUpdate): Promise<void> => { pendingProgress = update; const nowAt = Date.now(); const bypass = (lastPhase !== undefined && update.phase !== lastPhase) || update.providerActivity !== undefined || deadlineExceeded; if (lastProgressAt !== 0 && nowAt - lastProgressAt < this.opts.progressMinIntervalMs && !bypass) return; this.append([envelope('RUN_PROGRESS', runId, { runId, ...update })], context); lastProgressAt = nowAt; lastPhase = update.phase; pendingProgress = undefined; };
    const flushProgress = (): void => { if (pendingProgress) { this.append([envelope('RUN_PROGRESS', runId, { runId, ...pendingProgress })], context); pendingProgress = undefined; } };
    const timer = setTimeout(() => { deadlineExceeded = true; controller.abort(); }, Math.max(0, deadline - Date.now()));
    try { const provider = await this.deps.getProvider(run.providerName); const input = this.inputs.get(runId) ?? ({ query: run.query, strategy: run.strategy, depth: run.depth, topic: run.topic, sessionId: run.sessionId, threadId: run.threadId, providerName: run.providerName } as unknown as StartRunInput); await this.deps.executeResearch(runId, run.familyId, input, controller.signal, provider, { signal: controller.signal, runId, deadlineAt: deadline, trace: { traceId: runId, spanId: randomUUID().slice(0, 12) } }, reportProgress); flushProgress(); if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true }); }
    catch (error) { flushProgress(); if (deadlineExceeded) this.claimTerminal(runId, [envelope('RUN_INTERRUPTED', runId, { runId, interruptedAt: new Date().toISOString(), reason: 'deadline exceeded' })]); else if (controller.signal.aborted) { if (this.stopping) return; /* shutdown owns the terminal event */ this.claimTerminal(runId, [envelope('RUN_CANCELLED', runId, { runId })]); } else { const c = this.context(runId); if (!c) return; this.fail(run, error instanceof Error ? error.message : String(error), classifyError(error) === 'TRANSIENT' ? 'transient' : 'permanent'); } }
    finally { clearInterval(heartbeat); clearTimeout(timer); this.controllers.delete(runId); this.runs.set(runId, this.current(runId) ?? run); }
  }
  private fail(run: ResearchRun, message: string, classification: RunError['classification']): void { if (this.stopping) return; /* shutdown owns the terminal event */ const error: RunError = { code: classification, classification, message, retryable: classification === 'transient', occurredAt: new Date().toISOString() }; const claimed = this.claimTerminal(run.runId, [ { ...envelope('RUN_FAILED', run.runId, { runId: run.runId, error }), eventVersion: 2 } ]); if (claimed) this.runs.set(run.runId, { ...run, status: 'failed', error }); }
  private current(id: string): ResearchRun | undefined { try { const folded = foldRunLedger(queryEvents({ runId: id })); return folded.get(id) ?? this.runs.get(id); } catch { return this.runs.get(id); } }
  private context(id: string): AppendContext | undefined { return this.contexts.get(id); }
  /**
   * Atomically claim exclusive ownership of THIS run's single terminal event
   * and append it. Check-and-set is synchronous with no await between, so
   * under Node's single-threaded event loop it is genuinely mutually
   * exclusive across the shutdown / deadline / cancel paths — exactly one
   * caller wins, preventing the double-terminal-event history that
   * foldRunLedger()'s transition table rejects as corruption.
   */
  private claimTerminal(runId: string, events: readonly NewEventInput[]): boolean {
    const ctx = this.context(runId);
    if (ctx === undefined || this.terminalClaimed.has(runId)) return false;
    this.terminalClaimed.add(runId);
    this.append(events, ctx);
    return true;
  }
  private append(events: readonly NewEventInput[], context: AppendContext): void { try { this.deps.appendWithRetry(events, context); } catch (err) { /* Store may close while a worker drains. Never silent during shutdown diagnostics. */ logger.warn({ ...safeErrorLog(err), eventTypes: events.map((e) => e.eventType) }, 'scheduler: event append failed'); } }
}
