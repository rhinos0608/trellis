/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import { randomUUID } from 'node:crypto';
import type { AppendContext, NewEventInput } from '../store/events.js';
import { hashPayload, queryEvents } from '../store/events.js';
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
  constructor(options: SchedulerOptions = {}, private readonly deps: SchedulerDeps) {
    this.opts = { ...defaults, ...options };
    this.reconcileOnStartup();
  }
  start(): void { if (this.running) return; this.running = true; this.stopping = false; void this.loop(); }
  async shutdown(): Promise<void> { this.stopping = true; this.running = false; this.wake?.(); await Promise.all([...this.executions]); }
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
    const context = this.context(runId); if (!context) return false;
    if (run.status === 'queued') {
      this.append([envelope('RUN_CANCELLATION_REQUESTED', runId, { runId, requestedAt: new Date().toISOString() }), envelope('RUN_CANCELLED', runId, { runId })], context);
      this.runs.set(runId, { ...run, status: 'cancelled' }); return true;
    }
    this.append([envelope('RUN_CANCELLATION_REQUESTED', runId, { runId, requestedAt: new Date().toISOString() }), envelope('RUN_CANCELLED', runId, { runId })], context);
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
      const context = this.context(run.runId); if (!context) continue;
      if (run.status === 'queued') { if (Date.parse(run.deadlineAt) <= Date.now()) this.fail(run, context, 'deadline exceeded', 'deadline_exceeded'); else this.queue.push(run.runId); }
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
    const run = this.current(runId); const context = this.context(runId); if (!run || !context || run.status !== 'queued') return;
    const now = new Date(); const deadline = Date.parse(run.deadlineAt); if (deadline <= now.getTime()) { this.fail(run, context, 'deadline exceeded', 'deadline_exceeded'); return; }
    this.append([envelope('RUN_STARTING', runId, { runId, ownerId: this.ownerId, startingAt: now.toISOString() }), envelope('RUN_RUNNING', runId, { runId, ownerId: this.ownerId, startedAt: now.toISOString(), heartbeatAt: now.toISOString(), leaseUntil: new Date(now.getTime() + this.opts.leaseDurationMs).toISOString() })], context);
    const controller = new AbortController(); this.controllers.set(runId, controller);
    const heartbeat = setInterval(() => { const c = this.context(runId); if (c) this.append([envelope('RUN_HEARTBEAT', runId, { runId, ownerId: this.ownerId, heartbeatAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + this.opts.leaseDurationMs).toISOString() })], c); }, this.opts.heartbeatIntervalMs);
    let deadlineExceeded = false; let lastProgressAt = 0; let lastPhase: string | undefined; let pendingProgress: RunProgressUpdate | undefined;
    const reportProgress = async (update: RunProgressUpdate): Promise<void> => { pendingProgress = update; const nowAt = Date.now(); const bypass = (lastPhase !== undefined && update.phase !== lastPhase) || update.providerActivity !== undefined || deadlineExceeded; if (lastProgressAt !== 0 && nowAt - lastProgressAt < this.opts.progressMinIntervalMs && !bypass) return; this.append([envelope('RUN_PROGRESS', runId, { runId, ...update })], context); lastProgressAt = nowAt; lastPhase = update.phase; pendingProgress = undefined; };
    const flushProgress = (): void => { if (pendingProgress) { this.append([envelope('RUN_PROGRESS', runId, { runId, ...pendingProgress })], context); pendingProgress = undefined; } };
    const timer = setTimeout(() => { deadlineExceeded = true; controller.abort(); }, Math.max(0, deadline - Date.now()));
    try { const provider = await this.deps.getProvider(run.providerName); const input = this.inputs.get(runId) ?? ({ query: run.query, strategy: run.strategy, depth: run.depth, topic: run.topic, sessionId: run.sessionId, threadId: run.threadId, providerName: run.providerName } as unknown as StartRunInput); await this.deps.executeResearch(runId, run.familyId, input, controller.signal, provider, { signal: controller.signal, runId, deadlineAt: deadline, trace: { traceId: runId, spanId: randomUUID().slice(0, 12) } }, reportProgress); flushProgress(); if (controller.signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true }); }
    catch (error) { flushProgress(); const c = this.context(runId); if (!c) return; if (deadlineExceeded) this.append([envelope('RUN_INTERRUPTED', runId, { runId, interruptedAt: new Date().toISOString(), reason: 'deadline exceeded' })], c); else if (controller.signal.aborted) { if (!queryEvents({ runId, eventType: 'RUN_CANCELLED' }).length) this.append([envelope('RUN_CANCELLED', runId, { runId })], c); } else this.fail(run, c, error instanceof Error ? error.message : String(error), classifyError(error) === 'TRANSIENT' ? 'transient' : 'permanent'); }
    finally { clearInterval(heartbeat); clearTimeout(timer); this.controllers.delete(runId); this.runs.set(runId, run); }
  }
  private fail(run: ResearchRun, context: AppendContext, message: string, classification: RunError['classification']): void { if (this.controllers.get(run.runId)?.signal.aborted) { this.append([envelope('RUN_CANCELLED', run.runId, { runId: run.runId })], context); return; } const error: RunError = { code: classification, classification, message, retryable: classification === 'transient', occurredAt: new Date().toISOString() }; this.append([ { ...envelope('RUN_FAILED', run.runId, { runId: run.runId, error }), eventVersion: 2 } ], context); this.runs.set(run.runId, { ...run, status: 'failed', error }); }
  private current(id: string): ResearchRun | undefined { try { const folded = foldRunLedger(queryEvents({ runId: id })); return folded.get(id) ?? this.runs.get(id); } catch { return this.runs.get(id); } }
  private context(id: string): AppendContext | undefined { return this.contexts.get(id); }
  private append(events: NewEventInput[], context: AppendContext): void { try { this.deps.appendWithRetry(events, context); } catch { /* Store may close while service worker drains. */ } }
}
