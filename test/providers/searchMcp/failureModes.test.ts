/**
 * Failure-mode integration tests for the search-mcp provider.
 *
 * Exercises real failure paths using mock-client harnesses:
 * 1. Process/client death mid-call — error propagation + retry behavior
 * 2. Malformed responses — graceful degradation in mapping functions
 * 3. Cancellation mid-read — abort signal handling during in-flight call
 * 4. Concurrent runs against one db — WAL-mode SQLite under concurrent writes
 * 5. Restart mid-run — event persistence survives simulated crash
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const providerCtx = { signal: new AbortController().signal, runId: 'test', deadlineAt: Date.now() + 300_000, trace: { traceId: 'test', spanId: 'test' } };
const callOptions = { signal: new AbortController().signal, deadlineAt: Date.now() + 300_000 };
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSearchMcpProviderFromClient } from '../../../src/providers/searchMcp/index.js';
import {
  wrapClientWithRetry,
  type SearchMcpClient,
  type ToolCallResult,
} from '../../../src/providers/searchMcp/client.js';
import {
  classifyError,
  type RetryOptions,
} from '../../../src/research/retry.js';
import { createRunService } from '../../../src/research/runService.js';
import { initDb, closeDb, queryEvents } from '../../../src/store/index.js';
import { rebuildProjection } from '../../../src/store/projectionBuilder.js';
import { graphEventHandlers } from '../../../src/graph/index.js';
import { workspaceEventHandlers } from '../../../src/workspace/index.js';
import type { ResearchProvider } from '../../../src/providers/types.js';
import type { TrellisConfig } from '../../../src/config/index.js';

// ── Shared constants ────────────────────────────────────────────────

const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

const FULL_TOOL_NAMES = [
  'web_search', 'web_crawl', 'research', 'github',
  'reddit', 'youtube', 'browser', 'semantic_crawl',
];

// ── Mock client factory ─────────────────────────────────────────────

function createMockClient(
  toolHandler: (name: string, args: Record<string, unknown>) => ToolCallResult | Promise<ToolCallResult>,
): SearchMcpClient {
  return {
    async callTool(name: string, args: Record<string, unknown>, _options: { signal: AbortSignal; deadlineAt: number }): Promise<ToolCallResult> {
      return toolHandler(name, args);
    },
    async close() {},
  };
}

function createFailingClient(errorFn: () => never): SearchMcpClient {
  return createMockClient(async () => errorFn());
}

// ── Config helper ───────────────────────────────────────────────────

function makeConfig(dbPath: string): TrellisConfig {
  return {
    storage: { dbPath },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'echo', args: [] },
    logLevel: 'silent',
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Process/client death mid-call
// ═══════════════════════════════════════════════════════════════════════

describe('Failure mode: process/client death mid-call', () => {
  it('provider propagates Error from failing callTool (not swallowed)', async () => {
    const client = createFailingClient(() => {
      throw new Error('MCP tool error: Connection closed');
    });
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    await expect(provider.search('test query')).rejects.toThrow('Connection closed');
  });

  it('provider propagates raw rejection (transport-level death)', async () => {
    const client = createMockClient(async () => {
      throw 'transport died'; // raw string rejection, as real transports can produce
    });
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    await expect(provider.read(providerCtx, 'https://example.com')).rejects.toBe('transport died');
  });

  it('classifyError: connection-closed message → TRANSIENT', () => {
    const err = new Error('MCP tool error: Connection closed');
    expect(classifyError(err)).toBe('TRANSIENT');
  });

  it('classifyError: abort error → PERMANENT (no retry)', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('classifyError: non-Error value → PERMANENT', () => {
    expect(classifyError('string error')).toBe('PERMANENT');
  });

  it('wrapClientWithRetry retries transient failure maxRetries+1 times', async () => {
    let callCount = 0;
    const client = createMockClient(async () => {
      callCount++;
      throw new Error('ECONNRESET');
    });

    const maxRetries = 2;
    const wrapped = wrapClientWithRetry(client, {
      maxRetries,
      baseDelayMs: 1, // minimal delay for test speed
      maxDelayMs: 1,
    });

    await expect(wrapped.callTool('web_search', { query: 'test' }, callOptions)).rejects.toThrow('ECONNRESET');
    // 1 initial + 2 retries = 3 total calls
    expect(callCount).toBe(maxRetries + 1);
  });

  it('wrapClientWithRetry does NOT retry permanent failures', async () => {
    let callCount = 0;
    const client = createMockClient(async () => {
      callCount++;
      const err = new Error('Not found');
      err.name = 'AbortError'; // classifyError → PERMANENT
      throw err;
    });

    const wrapped = wrapClientWithRetry(client, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });

    await expect(wrapped.callTool('web_search', { query: 'test' }, callOptions)).rejects.toThrow('Not found');
    expect(callCount).toBe(1); // no retry
  });

  it('wrapClientWithRetry succeeds after transient failure then success', async () => {
    let callCount = 0;
    const client = createMockClient(async () => {
      callCount++;
      if (callCount < 3) throw new Error('ETIMEDOUT');
      return { data: { results: [] }, content: [] };
    });

    const wrapped = wrapClientWithRetry(client, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });

    const result = await wrapped.callTool('web_search', { query: 'test' }, callOptions);
    expect(result.data).toEqual({ results: [] });
    expect(callCount).toBe(3);
  });

  it('wrapClientWithRetry delegates close to underlying client', async () => {
    let closeCalled = false;
    const client: SearchMcpClient = {
      async callTool() { return { data: null, content: [] }; },
      async close() { closeCalled = true; },
    };

    const wrapped = wrapClientWithRetry(client);
    await wrapped.close();
    expect(closeCalled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Malformed responses
// ═══════════════════════════════════════════════════════════════════════

describe('Failure mode: malformed responses', () => {
  const emptyHandler = (): ToolCallResult => ({ data: undefined, content: [] });
  const nullHandler = (): ToolCallResult => ({ data: null, content: [] });
  const stringHandler = (): ToolCallResult => ({ data: 'raw string instead of object', content: [] });

  it('provider.search() returns [] when data is undefined', async () => {
    const client = createMockClient(emptyHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.search(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.search() returns [] when data is null', async () => {
    const client = createMockClient(nullHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.search(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.search() returns [] when data is a raw string', async () => {
    const client = createMockClient(stringHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.search(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.read() returns empty ReadResult when data is undefined', async () => {
    const client = createMockClient(emptyHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const result = await provider.read(providerCtx, 'https://example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.content).toBe('');
    expect(result.contentHash).toMatch(/^djb2:/);
  });

  it('provider.read() returns empty ReadResult when data is null', async () => {
    const client = createMockClient(nullHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const result = await provider.read(providerCtx, 'https://example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.content).toBe('');
  });

  it('provider.read() returns empty ReadResult when data is a raw string', async () => {
    const client = createMockClient(stringHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const result = await provider.read(providerCtx, 'https://example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.content).toBe('');
  });

  it('provider.crawl() returns [] when data is undefined', async () => {
    const client = createMockClient(emptyHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const results = await provider.crawl(providerCtx, 'https://example.com');
    expect(results).toEqual([]);
  });

  it('provider.crawl() returns [] when data is a raw string', async () => {
    const client = createMockClient(stringHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const results = await provider.crawl(providerCtx, 'https://example.com');
    expect(results).toEqual([]);
  });

  it('provider.github() returns [] when data is undefined', async () => {
    const client = createMockClient(emptyHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.github!(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.reddit() returns [] when data is null', async () => {
    const client = createMockClient(nullHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.reddit!(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.youtube() returns [] when data is undefined', async () => {
    const client = createMockClient(emptyHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.youtube!(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.youtubeTranscript() returns [] when data is a raw string', async () => {
    const client = createMockClient(stringHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const segments = await provider.youtubeTranscript!(providerCtx, 'abc123');
    expect(segments).toEqual([]);
  });

  it('provider.wikipedia() returns [] when data is null', async () => {
    const client = createMockClient(nullHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.wikipedia!(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.redditThread() returns empty thread when data is a raw string', async () => {
    const client = createMockClient(stringHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const thread = await provider.redditThread!(providerCtx, 'https://reddit.com/r/test/abc');
    expect(thread.title).toBe('');
    expect(thread.comments).toEqual([]);
  });

  it('provider.academic() returns [] when data is undefined', async () => {
    const client = createMockClient(emptyHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.academic(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.hackernews() returns [] when data is null', async () => {
    const client = createMockClient(nullHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.hackernews!(providerCtx, 'query');
    expect(hits).toEqual([]);
  });

  it('provider.stackoverflow() returns [] when data is undefined', async () => {
    const client = createMockClient(emptyHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);
    const hits = await provider.stackoverflow!(providerCtx, 'query');
    expect(hits).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Cancellation mid-read
// ═══════════════════════════════════════════════════════════════════════

describe('Failure mode: cancellation mid-read', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-fail-cancel-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cancelRun does not abort in-flight provider call; run transitions to cancelled after', async () => {
    const dbPath = path.join(tmpDir, 'cancel-mid.db');
    initDb(dbPath);
    const config = makeConfig(dbPath);

    let searchCallCount = 0;
    const slowProvider: ResearchProvider = {
      name: 'slow-mock',
      capabilities: {
        search: true, read: true, academic: false, code: false,
        community: { reddit: false, hackernews: false, stackoverflow: false },
        media: false, reference: false, browser: false,
      },
      search: async () => {
        searchCallCount++;
        // Simulate a slow provider call that takes real time
        await new Promise((r) => setTimeout(r, 1_000));
        return [{ url: 'https://example.com', title: 'Slow Result', snippet: 'slow' }];
      },
      read: async (_ctx, url) => ({
        url,
        title: 'Mock',
        content: 'mock content that is long enough for the threshold',
        contentHash: 'mockhash',
      }),
      crawl: async () => [],
      academic: async () => [],
    };

    const svc = createRunService();
    const { runId } = await svc.startRun({
      query: 'Cancellation mid-read test',
      provider: slowProvider,
      config,
      strategy: 'pipeline',
    });

    // Let pipeline reach the first provider.search() call before cancelling.
    // Margin widened from 50ms: real append-time decode/validation work
    // (Phase 0 event-store hardening) adds synchronous CPU time per event,
    // which can delay startRun's background task under load.
    await new Promise((r) => setTimeout(r, 150));

    // Cancel while the provider call is in-flight
    const cancelled = svc.cancelRun(runId);
    expect(cancelled).toBe(true);

    // Wait for the in-flight call to complete + strategy to settle
    await new Promise((r) => setTimeout(r, 800));

    // The in-flight search() call completed (not aborted mid-flight)
    expect(searchCallCount).toBeGreaterThanOrEqual(1);

    // Run should have transitioned to cancelled status
    const status = svc.getStatus(runId);
    expect(status).not.toBeNull();
    expect(status!.status).toBe('cancelled');
    expect(status!.cancelledAt).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Concurrent runs against one db
// ═══════════════════════════════════════════════════════════════════════

describe('Failure mode: concurrent runs against one db', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-fail-concurrent-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('two concurrent runs produce non-corrupted, correctly-attributed events', async () => {
    const dbPath = path.join(tmpDir, 'concurrent.db');
    initDb(dbPath);
    const config = makeConfig(dbPath);

    const fastProvider: ResearchProvider = {
      name: 'fast-mock',
      capabilities: {
        search: true, read: true, academic: false, code: false,
        community: { reddit: false, hackernews: false, stackoverflow: false },
        media: false, reference: false, browser: false,
      },
      search: async () => [
        { url: 'https://example.com/r1', title: 'Result One', snippet: 'first' },
      ],
      read: async (_ctx, url) => ({
        url,
        title: 'Content',
        content: 'Content long enough for the pipeline extraction threshold check to pass. This needs to exceed one hundred characters for the pipeline to create a finding from the extracted source content.',
        contentHash: 'hash1',
      }),
      crawl: async () => [],
      academic: async () => [],
    };

    const svc = createRunService();

    // Start two runs concurrently
    const [runA, runB] = await Promise.all([
      svc.startRun({
        query: 'Concurrent run A query',
        provider: fastProvider,
        config,
        strategy: 'pipeline',
        explicitFamilyId: 'fam_concurrent_A',
      }),
      svc.startRun({
        query: 'Concurrent run B query',
        provider: fastProvider,
        config,
        strategy: 'pipeline',
        explicitFamilyId: 'fam_concurrent_B',
      }),
    ]);

    expect(runA.runId).toBeTruthy();
    expect(runB.runId).toBeTruthy();
    expect(runA.runId).not.toBe(runB.runId);

    // Wait for both to complete
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const stA = svc.getStatus(runA.runId);
      const stB = svc.getStatus(runB.runId);
      if (stA?.status === 'completed' && stB?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Verify both completed
    const statusA = svc.getStatus(runA.runId);
    const statusB = svc.getStatus(runB.runId);
    expect(statusA!.status).toBe('completed');
    expect(statusB!.status).toBe('completed');

    // Verify events are correctly attributed — no cross-contamination
    const eventsA = queryEvents({ runId: runA.runId });
    const eventsB = queryEvents({ runId: runB.runId });

    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);

    // Every event from run A has runId === runA.runId
    for (const evt of eventsA) {
      expect(evt.runId).toBe(runA.runId);
    }
    // Every event from run B has runId === runB.runId
    for (const evt of eventsB) {
      expect(evt.runId).toBe(runB.runId);
    }

    // Projection has claims from both runs, correctly attributed
    const projection = rebuildProjection(ALL_HANDLERS);
    const claimsA = [...projection.claims.values()].filter((c) => c.firstSeenRunId === runA.runId);
    const claimsB = [...projection.claims.values()].filter((c) => c.firstSeenRunId === runB.runId);
    expect(claimsA.length).toBeGreaterThan(0);
    expect(claimsB.length).toBeGreaterThan(0);

    // Families are separate
    expect(projection.families.has('fam_concurrent_A')).toBe(true);
    expect(projection.families.has('fam_concurrent_B')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Restart mid-run
// ═══════════════════════════════════════════════════════════════════════

describe('Failure mode: restart mid-run', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-fail-restart-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rebuilding projection after mid-run crash shows coherent, incomplete state', async () => {
    const dbPath = path.join(tmpDir, 'restart-mid.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    // Slow provider that takes long enough for us to close the db mid-run
    const slowProvider: ResearchProvider = {
      name: 'slow-mock',
      capabilities: {
        search: true, read: true, academic: false, code: false,
        community: { reddit: false, hackernews: false, stackoverflow: false },
        media: false, reference: false, browser: false,
      },
      search: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return [{ url: 'https://example.com/r1', title: 'Result', snippet: 'snippet' }];
      },
      read: async (_ctx, url) => ({
        url,
        title: 'Content',
        content: 'Content long enough for the pipeline extraction threshold',
        contentHash: 'hash',
      }),
      crawl: async () => [],
      academic: async () => [],
    };

    const svc = createRunService();
    const { runId, familyId } = await svc.startRun({
      query: 'Restart mid-run test',
      provider: slowProvider,
      config,
      strategy: 'pipeline',
      explicitFamilyId: 'fam_restart_mid',
    });

    // Wait briefly for RUN_QUEUED to be appended, but NOT for completion
    await new Promise((r) => setTimeout(r, 50));

    // Verify RUN_QUEUED was persisted before we "crash"
    const eventsBeforeCrash = queryEvents({ runId });
    expect(eventsBeforeCrash.some((e) => e.eventType === 'RUN_QUEUED')).toBe(true);

    // ── Simulate crash: close db while run is in-flight ──
    await svc.shutdownScheduler();
    closeDb();
    expect(fs.existsSync(dbPath)).toBe(true);

    // The background execution may have failed silently (catch block in runService)
    // or may have succeeded — either way, the persisted events survive.

    // ── Restart: reopen db ──
    initDb(dbPath);

    // Rebuild projection from persisted events
    const projection = rebuildProjection(ALL_HANDLERS);

    // Coherent state: family exists (FAMILY_CREATED + FAMILY_RESOLVED were persisted)
    expect(projection.families.has(familyId)).toBe(true);

    // Status queryable — either "completed" (if it finished before crash)
    // or "running" (if it didn't finish). Must NOT crash or report success
    // if it didn't actually complete.
    const svc2 = createRunService();
    const status = svc2.getStatus(runId);
    expect(status).not.toBeNull();
    expect(status!.familyId).toBe(familyId);
    expect(status!.query).toBe('Restart mid-run test');

    // The run status is either completed (if it was fast enough) or running
    // (if the background task hadn't finished appending RUN_COMPLETED).
    // Both are valid — the key assertion is no crash and no corruption.
    expect(['completed', 'running']).toContain(status!.status);
  });

  it('manual RUN_STARTED + partial events survive restart without RUN_COMPLETED', async () => {
    const dbPath = path.join(tmpDir, 'restart-partial.db');
    initDb(dbPath);

    // Manually append events to simulate a partial run
    const { appendEvents } = await import('../../../src/store/events.js');
    const { EventEnvelope } = await import('../../../src/store/eventTypes.js');

    const runId = 'run_partial_crash';

    appendEvents([
      {
        eventType: 'FAMILY_CREATED',
        runId,
        eventVersion: 1,
        timestamp: new Date().toISOString(),
        batchId: null,
        actor: 'system',
        entityId: 'fam_partial',
        entityType: 'family',
        payload: { family_id: 'fam_partial', label: 'Partial', description: 'partial run' },
      },
      {
        eventType: 'FAMILY_RESOLVED',
        runId,
        eventVersion: 1,
        timestamp: new Date().toISOString(),
        batchId: null,
        actor: 'system',
        entityId: 'fam_partial',
        entityType: 'family',
        payload: { familyId: 'fam_partial', query: 'partial query', isNew: true, score: 0, method: 'lexical_manifest_overlap' },
      },
      {
        eventType: 'RUN_STARTED',
        runId,
        eventVersion: 1,
        timestamp: new Date().toISOString(),
        batchId: null,
        actor: 'system',
        entityId: runId,
        entityType: 'run',
        payload: { runId, familyId: 'fam_partial', query: 'partial query', strategy: 'pipeline' },
      },
      // No RUN_COMPLETED — simulating crash before completion
    ], { projection: rebuildProjection(ALL_HANDLERS), handlers: ALL_HANDLERS });

    // Simulate crash + restart
    closeDb();
    initDb(dbPath);

    // Rebuild projection — should not crash
    const projection = rebuildProjection(ALL_HANDLERS);
    expect(projection.families.has('fam_partial')).toBe(true);

    // Status: running (RUN_STARTED present, no RUN_COMPLETED/RUN_FAILED/RUN_CANCELLED)
    const svc = createRunService();
    const status = svc.getStatus(runId);
    expect(status).not.toBeNull();
    expect(status!.status).toBe('running');
    expect(status!.familyId).toBe('fam_partial');
  });
});
