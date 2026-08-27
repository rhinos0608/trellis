import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, queryEvents } from '../../src/store/index.js';
import {
  createRunService,
  MissingLlmConfigError,
} from '../../src/research/runService.js';
import { LlmClient } from '../../src/research/llm/client.js';
import { logger } from '../../src/logger.js';
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';

// ── Fixtures ─────────────────────────────────────────────────────────

const mockProvider: ResearchProvider = {
  name: 'mock',
  capabilities: {
    search: true, read: true, academic: false, code: false,
    community: { reddit: false, hackernews: false, stackoverflow: false },
    media: false, reference: false, browser: false,
  },
  search: async () => [{ url: 'https://example.com', title: 'Test', snippet: 'test snippet' }],
  read: async (_ctx, url) => ({ url, title: 'Test', content: 'test content', contentHash: 'hash1' }),
  crawl: async () => [],
  academic: async () => [],
};

function makeConfig(llm?: Partial<TrellisConfig['llm']>): TrellisConfig {
  return {
    storage: { dbPath: ':memory:' },
    llm: {
      apiKey: undefined,
      baseUrl: undefined,
      model: undefined,
      ...(llm ?? {}),
    },
    searchProvider: { command: 'echo', args: [] },
    logLevel: 'silent',
  };
}

/** OpenAI-compatible chat-completions JSON body. */
function chatResponse(content: string, usage?: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      ...(usage ? { usage } : {}),
    }),
    { status: 200 },
  );
}

async function waitForSettledStatus(
  svc: ReturnType<typeof createRunService>,
  runId: string,
): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const status = svc.getStatus(runId);
    if (status && ['completed', 'failed', 'cancelled'].includes(status.status)) {
      return status.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('run did not settle within timeout');
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-agent-llm-test-'));
  initDb(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── A: construction + registration / missing-config rejection ────────

describe('LlmClient activation in runService (Phase 11C)', () => {
  it('constructs a client from baseUrl+model WITHOUT apiToken and registers the agent strategy', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      // Verify no Authorization header is required/attached when apiToken absent
      return chatResponse('THOUGHT: search done\nANSWER: Final agent answer.');
    });
    vi.stubGlobal('fetch', fetchMock);

    const svc = createRunService();
    const { runId } = await svc.startRun({
      query: 'What is TypeScript?',
      provider: mockProvider,
      config: makeConfig({ baseUrl: 'http://127.0.0.1:9', model: 'test-model' }),
      strategy: 'agent',
    });

    const status = await waitForSettledStatus(svc, runId);
    // If the agent strategy were not registered, registry.create would throw
    // Unknown strategy and the run would land in 'failed'.
    expect(status).toBe('completed');
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { model?: string };
    expect(body.model).toBe('test-model');
  }, 15_000);

  it('rejects startRun() with a PERMANENT precondition error when LLM config is missing', async () => {
    const svc = createRunService();
    let caught: unknown;
    try {
      await svc.startRun({
        query: 'What is TypeScript?',
        provider: mockProvider,
        config: makeConfig(), // no baseUrl/model
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingLlmConfigError);
    expect((caught as MissingLlmConfigError).classification).toBe('permanent');
    expect((caught as Error).message).toMatch(/Agent strategy requires LLM configuration/);
    // Rejected up front — no RUN_QUEUED event appended
    const queued = queryEvents({ eventType: 'RUN_QUEUED' }).filter(
      (e) => (e.payload as { strategy?: string }).strategy === 'agent',
    );
    expect(queued).toHaveLength(0);
  });

  // ── B: real-or-estimated token usage ───────────────────────────────

  it('uses provider usage data when the response includes it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      chatResponse('hello', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }),
    ));
    const client = new LlmClient({ baseUrl: 'http://127.0.0.1:9', model: 'm' });
    const resp = await client.callOrchestrator({
      messages: [{ role: 'user', content: 'question that is long enough to differ' }],
    });
    expect(resp.success).toBe(true);
    expect(resp.tokensUsed).toBe(18);
    expect(resp.tokensSource).toBe('provider_usage');
    expect(resp.promptTokens).toBe(11);
    expect(resp.completionTokens).toBe(7);
  });

  it('falls back to the estimate heuristic (marked estimated) when usage is omitted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => chatResponse('wxyzabcd')));
    const client = new LlmClient({ baseUrl: 'http://127.0.0.1:9', model: 'm' });
    const resp = await client.callOrchestrator({
      messages: [{ role: 'user', content: 'abcd' }], // estimateTokens → ceil(4/4) = 1
    });
    expect(resp.success).toBe(true);
    // content 'wxyzabcd' → ceil(8/4) = 2; prompt estimate 1 → total 3
    expect(resp.tokensUsed).toBe(3);
    expect(resp.tokensSource).toBe('estimated');
    expect(resp.promptTokens).toBe(1);
    expect(resp.completionTokens).toBe(2);
  });

  // ── D4: RUN_PROGRESS.counts.tokensUsed reflects sum of LLM calls ──

  it("populates RUN_PROGRESS.counts.tokensUsed/providerCalls from the run's LLM calls", async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      chatResponse('THOUGHT: done\nANSWER: Final answer.', {
        prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      })),
    );

    const svc = createRunService();
    const { runId } = await svc.startRun({
      query: 'Summarize TypeScript benefits',
      provider: mockProvider,
      config: makeConfig({ baseUrl: 'http://127.0.0.1:9', model: 'test-model' }),
      strategy: 'agent',
    });

    const status = await waitForSettledStatus(svc, runId);
    expect(status).toBe('completed');

    const progressEvents = queryEvents({ eventType: 'RUN_PROGRESS' }).filter(
      (e) => e.runId === runId,
    );
    expect(progressEvents.length).toBeGreaterThan(0);
    const countsList = progressEvents
      .map((e) => (e.payload as { counts?: { tokensUsed?: number; providerCalls?: number } }).counts)
      .filter((c) => c !== undefined);
    expect(countsList.some((c) => (c.tokensUsed ?? 0) >= 15)).toBe(true);
    expect(countsList.some((c) => (c.providerCalls ?? 0) >= 1)).toBe(true);
  }, 15_000);

  // ── D5: structured telemetry log record ────────────────────────────

  it('emits one structured telemetry record per logical LLM call with safe metadata only', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () =>
      chatResponse('ok', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
    ));
    const client = new LlmClient({ baseUrl: 'http://127.0.0.1:9', model: 'meta-model' });
    await client.callOrchestrator({
      messages: [
        { role: 'system', content: 'SECRET PROMPT CONTENT should never be logged' },
        { role: 'user', content: 'SECRET USER CONTENT' },
      ],
      runId: 'run_telemetry',
      traceId: 'trace_telemetry',
    });

    const telemetryCalls = infoSpy.mock.calls.filter(
      ([obj]) => typeof obj === 'object' && obj !== null && (obj as { provider?: string }).provider === 'llm',
    );
    expect(telemetryCalls).toHaveLength(1);
    const record = telemetryCalls[0]?.[0] as Record<string, unknown>;
    expect(record.model).toBe('meta-model');
    expect(record.operation).toBe('chat');
    expect(record.outcome).toBe('success');
    expect(record.runId).toBe('run_telemetry');
    expect(record.traceId).toBe('trace_telemetry');
    expect(record.promptTokens).toBe(3);
    expect(record.completionTokens).toBe(2);
    expect(record.totalTokens).toBe(5);
    expect(typeof record.durationMs).toBe('number');
    expect(typeof record.attempts).toBe('number');
    // No prompt/response content or credentials may leak into telemetry
    for (const forbidden of ['content', 'prompt', 'messages', 'apiToken', 'authorization']) {
      expect(record).not.toHaveProperty(forbidden);
      expect(JSON.stringify(record)).not.toContain('SECRET');
    }
  });
});
