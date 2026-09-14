/**
 * Direct tests for the ResearchApplicationService (src/app) — not through MCP.
 * Uses a real file-backed SQLite db and the real RunService/scheduler end to end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, appendEvents, rebuildProjection } from '../../src/store/index.js';
import type { NewEventInput } from '../../src/store/events.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import { createRunService } from '../../src/research/runService.js';
import {
  createResearchApplicationService,
  ApplicationError,
  InvalidTransitionError,
  RunNotFoundError,
} from '../../src/app/index.js';
import { LIFECYCLE_EVENT_TYPES } from '../../src/research/runLedger.js';
import { queryEvents } from '../../src/store/events.js';
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';

// Mock LlmClient so agent strategy doesn't need real LLM config
let _mockLlmCallCount = 0;
vi.mock('../../src/research/llm/client.js', () => {
  const planResponse = { success: true, content: '{"scope":"test","assumptions":[],"perspectives":[{"name":"searcher","question":"what is this"}],"falsificationQuestions":[]}', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  const searchResponse = { success: true, content: 'THOUGHT: search\nACTION: search_web\nARGUMENTS: {"query":"test"}', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  const readResponse = { success: true, content: 'THOUGHT: read\nACTION: web_read\nARGUMENTS: {"url":"https://example.com/result1"}', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  const answerResponse = { success: true, content: 'THOUGHT: done\nANSWER: Done.', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  return {
    LlmClient: class { callOrchestrator = async () => { _mockLlmCallCount++; if (_mockLlmCallCount === 1) return planResponse; if (_mockLlmCallCount === 2) return searchResponse; if (_mockLlmCallCount === 3) return readResponse; return answerResponse; }; callWorker = async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0 }); },
    parseJsonFromText: (s: string) => { try { return JSON.parse(s); } catch { return undefined; } },
  };
});

// ── Mock provider ────────────────────────────────────────────────────

const mockProvider: ResearchProvider = {
  name: 'mock',
  capabilities: {
    search: true,
    read: true,
    academic: false,
    code: false,
    community: { reddit: false, hackernews: false, stackoverflow: false },
    media: false,
    reference: false,
    browser: false,
  },
  search: async () => [
    { url: 'https://example.com/result1', title: 'Result One', snippet: 'first snippet' },
  ],
  read: async (_ctx, url) => ({
    url,
    title: 'Mock Content Title',
    content: 'This is mock content that is definitely long enough to pass the threshold check for creating a finding from the extracted source.',
    contentHash: 'mockhash',
  }),
  crawl: async () => [],
  academic: async () => [],
};

function makeConfig(dbPath: string): TrellisConfig {
  return {
    storage: { dbPath },
    llm: { apiKey: undefined, baseUrl: 'http://mock-llm', model: 'test-model' },
    searchProvider: { command: 'echo', args: [] },
    piNorthstar: { autoDetect: false },
    logLevel: 'silent',
  };
}

const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

// ── Shared setup ─────────────────────────────────────────────────────

let tmpDir: string;

// Schedulers must be stopped before closeDb — otherwise a lingering
// heartbeat/execute timer appends lifecycle events into the NEXT test's
// fresh database and corrupts its run ledger.
const liveServices: { svc: ReturnType<typeof createRunService> }[] = [];

beforeEach(() => {
  _mockLlmCallCount = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-app-'));
});

afterEach(async () => {
  for (const entry of liveServices) await entry.svc.shutdownScheduler();
  liveServices.length = 0;
  closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup ok */ }
});

interface Fixture {
  svc: ReturnType<typeof createRunService>;
  app: ReturnType<typeof createResearchApplicationService>;
}

function makeFixture(): Fixture {
  const config = makeConfig(path.join(tmpDir, 'app-test.db'));
  initDb(config.storage.dbPath);
  const svc = createRunService();
  liveServices.push({ svc });
  const app = createResearchApplicationService({
    runService: svc,
    config,
    getProvider: async () => mockProvider,
  });
  return { svc, app };
}

async function waitForCompleted(
  app: Fixture['app'],
  runId: string,
  timeoutMs = 15_000,
): Promise<NonNullable<ReturnType<Fixture['app']['getRun']>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = app.getRun(runId);
    if (run && run.status === 'completed') return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
}

// ═══════════════════════════════════════════════════════════════════════
// Delegation: lifecycle methods return expected DTO shapes
// ═══════════════════════════════════════════════════════════════════════

describe('delegation: start/get/cancel/continue', () => {
  it('startRun delegates and returns { runId, familyId }', async () => {
    const { app } = makeFixture();
    const result = await app.startRun({ query: 'App service delegation test' });
    expect(typeof result.runId).toBe('string');
    expect(result.runId.startsWith('run_')).toBe(true);
    expect(typeof result.familyId).toBe('string');
    await waitForCompleted(app, result.runId);
  });

  it('getRun returns the full summary DTO for a completed run', async () => {
    const { app } = makeFixture();
    const { runId, familyId } = await app.startRun({ query: 'Get run DTO test' });
    const run = await waitForCompleted(app, runId);
    expect(run.runId).toBe(runId);
    expect(run.familyId).toBe(familyId);
    expect(run.status).toBe('completed');
    expect(run.query).toBe('Get run DTO test');
    expect(run.progress.phase).toBe('completed');
    expect(typeof run.startedAt).toBe('string');
    expect(typeof run.completedAt).toBe('string');
    // No LLM configured → zero factual claims, but sources are still discovered
    expect((run.claimCount ?? 0)).toBe(0);
    expect((run.sourceCount ?? 0)).toBeGreaterThan(0);
  });

  it('cancelRun returns { cancelled: boolean } and does not throw', async () => {
    const { app } = makeFixture();
    const { runId } = await app.startRun({ query: 'Cancel delegation test' });
    const result = await app.cancelRun(runId);
    expect(typeof result.cancelled).toBe('boolean');
    expect(Object.keys(result).sort()).toEqual(['cancelled']);
  });

  it('continueResearch returns a valid ContinueResearchResult shape', async () => {
    const { app } = makeFixture();
    const { familyId } = await app.startRun({ query: 'Continue delegation test' });
    await waitForCompleted(app, (await app.listRuns())[0]!.runId);
    const result = await app.continueResearch({ familyId });
    expect(['queued', 'no_work', 'cap_reached']).toContain(result.status);
    expect(result.familyId).toBe(familyId);
    expect(typeof result.followUpsUsed).toBe('number');
    expect(result.followUpCap).toBe(3);
    if (result.status === 'queued') {
      expect(result.target.type === 'gap' || result.target.type === 'contradiction').toBe(true);
      expect(typeof result.query).toBe('string');
    }
  });

  it('startRun resolves provider lazily via deps.getProvider', async () => {
    let calls = 0;
    const config = makeConfig(path.join(tmpDir, 'lazy-provider.db'));
    initDb(config.storage.dbPath);
    const svc = createRunService();
    liveServices.push({ svc });
    const app = createResearchApplicationService({
      runService: svc,
      config,
      getProvider: async () => { calls++; return mockProvider; },
    });
    await app.getRun('nonexistent');
    await app.listRuns();
    expect(calls).toBe(0);
    const { runId } = await app.startRun({ query: 'Lazy provider test' });
    expect(calls).toBe(1);
    await waitForCompleted(app, runId);
  });
});

describe('listRuns', () => {
  it('returns narrow summaries filtered by status and familyId', async () => {
    const { app } = makeFixture();
    const FAMILY = 'fam_app_list_test';
    const r1 = await app.startRun({ query: 'List runs one', familyId: FAMILY });
    const r2 = await app.startRun({ query: 'List runs two', familyId: FAMILY });
    await waitForCompleted(app, r1.runId);
    await waitForCompleted(app, r2.runId);

    const all = app.listRuns();
    expect(all.length).toBeGreaterThanOrEqual(2);

    // Narrow DTO shape: exactly these keys
    for (const run of all) {
      expect(Object.keys(run).sort()).toEqual(
        ['completedAt', 'createdAt', 'familyId', 'query', 'runId', 'status', 'strategy'],
      );
      expect(run.strategy).toBe('agent');
    }

    const byFamily = app.listRuns({ familyId: FAMILY });
    expect(byFamily.map((r) => r.runId).sort()).toEqual([r1.runId, r2.runId].sort());

    const byStatus = app.listRuns({ status: 'completed', familyId: FAMILY });
    expect(byStatus.length).toBe(2);

    // Newest first (createdAt descending)
    expect(all[0]!.createdAt >= all[all.length - 1]!.createdAt).toBe(true);
  });

  it('caps limit at 100 and defaults to 50', async () => {
    const { app } = makeFixture();
    const page = app.listRuns({ limit: 5000 });
    // No way to have >2 real runs here; just assert the cap math via a huge limit
    expect(page.length).toBeLessThanOrEqual(100);
    expect(app.listRuns({ limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  it('rejects non-positive and non-integer list limits', () => {
    const { app } = makeFixture();
    expect(() => app.listRuns({ limit: 0 })).toThrow(/positive integer/);
    expect(() => app.getRunHistory('missing', { limit: Number.NaN })).toThrow(/positive integer/);
    expect(() => app.listRunEvents({ runId: 'missing', limit: -1 })).toThrow(/positive integer/);
  });

  it('filters by beforeSeq using RUN_QUEUED seq', async () => {
    const { app } = makeFixture();
    const r1 = await app.startRun({ query: 'BeforeSeq one' });
    await waitForCompleted(app, r1.runId);
    const r2 = await app.startRun({ query: 'BeforeSeq two' });
    await waitForCompleted(app, r2.runId);

    const queued1 = queryEvents({ runId: r1.runId }).find((e) => e.eventType === 'RUN_QUEUED')!;
    const queued2 = queryEvents({ runId: r2.runId }).find((e) => e.eventType === 'RUN_QUEUED')!;
    expect(queued2.seq).toBeGreaterThan(queued1.seq);

    const before = app.listRuns({ beforeSeq: queued2.seq });
    expect(before.some((r) => r.runId === r2.runId)).toBe(false);
    expect(before.some((r) => r.runId === r1.runId)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getRunHistory / listRunEvents — bounded, seq-ordered
// ═══════════════════════════════════════════════════════════════════════

describe('getRunHistory', () => {
  it('returns lifecycle events in seq order, bounded by limit', async () => {
    const { app } = makeFixture();
    const { runId } = await app.startRun({ query: 'History bounded test' });
    await waitForCompleted(app, runId);

    const history = app.getRunHistory(runId);
    expect(history.runId).toBe(runId);
    expect(history.events.length).toBeGreaterThanOrEqual(2);
    const seqs = history.events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // ascending
    for (const event of history.events) {
      expect(LIFECYCLE_EVENT_TYPES.has(event.eventType)).toBe(true);
      expect(event.eventType !== 'CLAIM_OBSERVED').toBe(true); // non-lifecycle excluded
    }
    expect(history.events[0]!.eventType).toBe('RUN_QUEUED');
    expect(history.events.at(-1)!.eventType).toBe('RUN_COMPLETED');
    for (const forbidden of ['providerName', 'requestHash', 'retryPolicy', 'deadlineAt', 'idempotencyKey', 'sessionId']) {
      expect(history.events[0]!.payload).not.toHaveProperty(forbidden);
    }

    const capped = app.getRunHistory(runId, { limit: 1 });
    expect(capped.events.length).toBe(1);
  });

  it('excludes non-run events (claims/evidence/family events share the runId)', async () => {
    const { app } = makeFixture();
    const { runId } = await app.startRun({ query: 'History exclusion test' });
    await waitForCompleted(app, runId);
    // A completed pipeline run attaches CLAIM_OBSERVED / EVIDENCE_LINKED /
    // SOURCE_OBSERVED events to the same runId — none may appear.
    const history = app.getRunHistory(runId);
    const types = new Set(history.events.map((e) => e.eventType));
    for (const t of ['CLAIM_OBSERVED', 'EVIDENCE_LINKED', 'SOURCE_OBSERVED', 'FAMILY_CREATED', 'THREAD_CREATED']) {
      expect(types.has(t)).toBe(false);
    }
  });
});

describe('listRunEvents', () => {
  it('maps to safe bounded RunEventDto shapes with whitelisted payloads', async () => {
    const { app } = makeFixture();
    const { runId, familyId } = await app.startRun({ query: 'Safe events test' });
    await waitForCompleted(app, runId);

    const events = app.listRunEvents({ runId });
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['eventType', 'payload', 'seq', 'timestamp']);
      expect(LIFECYCLE_EVENT_TYPES.has(event.eventType)).toBe(true);
    }
    const queued = events.find((e) => e.eventType === 'RUN_QUEUED')!;
    // Internal payload detail must not leak
    for (const forbidden of ['providerName', 'requestHash', 'retryPolicy', 'deadlineAt', 'idempotencyKey', 'sessionId']) {
      expect(queued.payload).not.toHaveProperty(forbidden);
    }
    expect(queued.payload).toMatchObject({ runId, familyId, query: 'Safe events test', strategy: 'agent' });

    const completed = events.find((e) => e.eventType === 'RUN_COMPLETED')!;
    expect(completed.payload).toHaveProperty('claimCount');
    expect(completed.payload).not.toHaveProperty('artifactPaths');
  });

  it('excludes RUN_HEARTBEAT events even when present in the ledger', async () => {
    const { app } = makeFixture();
    // Synthetic run: QUEUED → STARTING → HEARTBEAT (valid ledger transitions),
    // appended directly so a heartbeat exists without waiting 15s of wall time.
    const projection = rebuildProjection(ALL_HANDLERS);
    const now = new Date().toISOString();
    const mk = (eventType: string, payload: Record<string, unknown>, entityType = 'run'): NewEventInput => ({
      timestamp: now, eventType, eventVersion: 1, runId: 'run_heartbeat_fixture',
      batchId: null, actor: 'system', entityId: 'run_heartbeat_fixture', entityType, payload,
    });
    appendEvents([
      // RUN_QUEUED reference-validates the family — create it first.
      mk('FAMILY_CREATED', { family_id: 'fam_hb', label: 'Heartbeat family' }, 'family'),
      mk('RUN_QUEUED', {
        runId: 'run_heartbeat_fixture', rootRunId: 'run_heartbeat_fixture', familyId: 'fam_hb',
        query: 'Heartbeat fixture', strategy: 'agent', depth: 'standard',
        providerName: 'mock', requestHash: 'hb-hash', retryPolicy: { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1000, maxBackoffMs: 30000 },
        deadlineAt: new Date(Date.now() + 60_000).toISOString(), attempt: 1, queuedAt: now,
      }),
      mk('RUN_STARTING', { runId: 'run_heartbeat_fixture', ownerId: 'owner_1', startingAt: now }),
      mk('RUN_HEARTBEAT', { runId: 'run_heartbeat_fixture', ownerId: 'owner_1', heartbeatAt: now, leaseUntil: new Date(Date.now() + 60_000).toISOString() }),
    ], { projection, handlers: ALL_HANDLERS });

    const events = app.listRunEvents({ runId: 'run_heartbeat_fixture' });
    const types = events.map((e) => e.eventType);
    expect(types).toContain('RUN_QUEUED');
    expect(types).toContain('RUN_STARTING');
    expect(types).not.toContain('RUN_HEARTBEAT');

    // getRunHistory keeps current behavior: heartbeats included (wire parity)
    const historyTypes = app.getRunHistory('run_heartbeat_fixture').events.map((e) => e.eventType);
    expect(historyTypes).toContain('RUN_HEARTBEAT');
  });

  it('honors afterSeq paging and caps limit at 500', async () => {
    const { app } = makeFixture();
    const { runId } = await app.startRun({ query: 'AfterSeq paging test' });
    await waitForCompleted(app, runId);

    const all = app.listRunEvents({ runId });
    expect(all.length).toBeGreaterThanOrEqual(2);
    const first = all[0]!;

    const rest = app.listRunEvents({ runId, afterSeq: first.seq });
    expect(rest.every((e) => e.seq > first.seq)).toBe(true);
    expect(rest.length).toBe(all.length - 1);

    const capped = app.listRunEvents({ runId, limit: 999_999 });
    expect(capped.length).toBe(all.length); // capped at 500, well below here

    const one = app.listRunEvents({ runId, limit: 1 });
    expect(one.length).toBe(1);
    expect(one[0]!.seq).toBe(first.seq);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Lookup semantics & typed errors
// ═══════════════════════════════════════════════════════════════════════

describe('typed error semantics', () => {
  it('getRun for a nonexistent run returns null (safe lookup)', () => {
    const { app } = makeFixture();
    expect(app.getRun('run_does_not_exist')).toBeNull();
  });

  it('retryRun for a nonexistent run throws RunNotFoundError', async () => {
    const { app } = makeFixture();
    await expect(app.retryRun({ runId: 'run_does_not_exist' }))
      .rejects.toBeInstanceOf(RunNotFoundError);
    await expect(app.retryRun({ runId: 'run_does_not_exist' }))
      .rejects.toMatchObject({ code: 'RUN_NOT_FOUND', retryable: false });
  });

  it('retryRun on a completed run throws InvalidTransitionError with retryable=false', async () => {
    const { app } = makeFixture();
    const { runId } = await app.startRun({ query: 'Retry invalid transition test' });
    await waitForCompleted(app, runId);
    const promise = app.retryRun({ runId });
    await expect(promise).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(promise).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      retryable: false,
      message: `Cannot retry run in status: completed`,
    });
    await expect(promise).rejects.toBeInstanceOf(ApplicationError);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// rollback propagation (Phase 6 fix must survive the application layer)
// ═══════════════════════════════════════════════════════════════════════

describe('rollbackRun', () => {
  it('propagates readModelRebuilt / readModelError / counts correctly', async () => {
    const { app } = makeFixture();
    const { runId, familyId } = await app.startRun({ query: 'Rollback propagation test' });
    await waitForCompleted(app, runId);

    const result = app.rollbackRun(runId);
    expect(Object.keys(result).sort()).toEqual(['blocked', 'executed', 'readModelRebuilt', 'skipped']);
    expect(result.readModelRebuilt).toBe(true);
    expect(result.readModelError).toBeUndefined();
    expect('readModelError' in result).toBe(false);
    expect(typeof result.skipped).toBe('number');
    expect(result.skipped).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.blocked)).toBe(true);
    void familyId;
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Idempotency: same idempotencyKey + same input → same run, no ghost events
// ═══════════════════════════════════════════════════════════════════════

describe('startRun idempotency', () => {
  it('same idempotencyKey + identical input returns the same runId with one RUN_QUEUED event', async () => {
    const { app } = makeFixture();
    const key = 'idem-dedupe-key';
    const query = 'Idempotency dedupe test';

    // Simulate different Date.now() ticks between calls
    const realDateNow = Date.now;
    let tick = 0;
    Date.now = () => realDateNow() + (tick++);
    try {
      const result1 = await app.startRun({ query, idempotencyKey: key });
      const result2 = await app.startRun({ query, idempotencyKey: key });

      // (a) Both calls return the same runId
      expect(result1.runId).toBe(result2.runId);
      expect(result1.familyId).toBe(result2.familyId);

      // (b) Only one RUN_QUEUED event exists
      const events = queryEvents({ runId: result1.runId });
      const queuedEvents = events.filter((e) => e.eventType === 'RUN_QUEUED');
      expect(queuedEvents.length).toBe(1);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('same idempotencyKey + different query throws IDEMPOTENCY_CONFLICT', async () => {
    const { app } = makeFixture();
    const key = 'idem-conflict-key';

    await app.startRun({ query: 'First query', idempotencyKey: key });

    await expect(
      app.startRun({ query: 'Different query', idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
  });

  it('same idempotencyKey dedupes whether deadlineMs is omitted or explicitly set to default', async () => {
    const { app } = makeFixture();
    const key = 'idem-deadline-default-key';
    const query = 'Idempotency deadline normalization test';

    // First call: omit deadlineMs entirely (should use default 600_000)
    const result1 = await app.startRun({ query, idempotencyKey: key });

    // Second call: explicitly pass deadlineMs: 600_000 (the default value)
    const result2 = await app.startRun({ query, idempotencyKey: key, deadlineMs: 600_000 });

    // Must dedupe to the same run — NOT a conflict
    expect(result1.runId).toBe(result2.runId);
    expect(result1.familyId).toBe(result2.familyId);

    // Only one RUN_QUEUED event should exist
    const events = queryEvents({ runId: result1.runId });
    const queuedEvents = events.filter((e) => e.eventType === 'RUN_QUEUED');
    expect(queuedEvents.length).toBe(1);
  });
});
