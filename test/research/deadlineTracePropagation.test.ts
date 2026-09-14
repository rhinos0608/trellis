import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { AgentStrategy } from '../../src/research/strategies/agentStrategy.js';
import { providerCallContext, type StrategyContext } from '../../src/research/strategies/types.js';
import type { ProviderCallContext, ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';
import type { RunContext } from '../../src/research/types.js';
import type { LlmClient, LlmResponse } from '../../src/research/llm/client.js';

function makeConfig(): TrellisConfig {
  return {
    storage: { dbPath: ':memory:' },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'echo', args: [] },
    piNorthstar: { autoDetect: false },
    logLevel: 'silent',
  };
}

function makeRunContext(): RunContext {
  return { familyId: 'fam-test', researchRunId: 'run-test' };
}

/** Scheduler-shaped ProviderCallContext (as built by scheduler.ts execute()). */
function schedulerCtx(overrides?: Partial<ProviderCallContext>): ProviderCallContext {
  return {
    signal: new AbortController().signal,
    runId: 'run_sched123',
    deadlineAt: 1700000000000,
    trace: { traceId: 'run_sched123', spanId: 'rootspan01' },
    ...overrides,
  };
}

function llmResponse(content: string): LlmResponse {
  return {
    success: true,
    content,
    model: 'test',
    tokensUsed: 15,
    tokensSource: 'provider_usage' as const,
    promptTokens: 10,
    completionTokens: 5,
    attempts: 1,
    durationMs: 100,
  };
}

function makeMockLlm(answer = 'THOUGHT: done\nANSWER: Answer.'): LlmClient {
  return {
    callOrchestrator: async () => llmResponse(answer),
    callWorker: async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated' as const, attempts: 1, durationMs: 0 }),
  } as unknown as LlmClient;
}

function makeStrategyCtx(
  provider: ResearchProvider,
  opts?: { root?: ProviderCallContext; signal?: AbortSignal; llm?: LlmClient },
): StrategyContext {
  const budget = new BudgetTracker({
    depth: 'standard',
    maxSources: 70,
    maxExtractions: 60,
    maxGapLoops: 4,
    minGapLoops: 2,
    maxToolCalls: 200,
    maxTokens: 400_000,
    maxTimeMs: 480_000,
    maxStateEntries: 500,
  });
  const state = new ResearchStateEngine(budget);
  return {
    state,
    budget,
    provider,
    llm: opts?.llm ?? makeMockLlm(),
    config: makeConfig(),
    runContext: makeRunContext(),
    abortSignal: opts?.signal,
    providerCtx: opts?.root ?? schedulerCtx(),
    reportProgress: async () => {},
    depth: 'standard',
  };
}

describe('deadline/trace propagation', () => {
  it('providerCallContext derives child spans from the scheduler context (same traceId/deadlineAt/runId, fresh spanId)', () => {
    const root = schedulerCtx();
    const ctx = makeStrategyCtx(createMockProvider(), { root });
    const a = providerCallContext(ctx, { phase: 'discovery' });
    const b = providerCallContext(ctx, { phase: 'extraction' });

    for (const child of [a, b]) {
      expect(child.deadlineAt).toBe(root.deadlineAt); // NOT a fabricated 5-min deadline
      expect(child.trace.traceId).toBe(root.trace.traceId);
      expect(child.runId).toBe(root.runId);
      expect(child.trace.parentSpanId).toBe(root.trace.spanId);
    }
    expect(a.trace.spanId).not.toBe(b.trace.spanId); // new span per strategy phase
  });

  it('AgentStrategy passes the REAL scheduler deadline/trace to every provider call', async () => {
    const root = schedulerCtx();
    const seen: ProviderCallContext[] = [];
    const provider = createMockProvider({
      onSearch: (callCtx) => seen.push(callCtx),
      onRead: (callCtx) => seen.push(callCtx),
    });
    const strategy = new AgentStrategy(makeStrategyCtx(provider, { root }));
    // Plan returns empty perspectives → agent skips to ReAct loop which calls search_web
    const llm = makeMockLlm(
      '{"scope":"test","assumptions":[],"perspectives":[],"falsificationQuestions":[]}' + '\n\nTHOUGHT: need to search\nACTION: search_web\nARGUMENTS: {"query":"What is React?"}',
    );
    // Second call: answer
    const llmWithAnswer = {
      callOrchestrator: (async () => llmResponse('THOUGHT: done\nANSWER: Done.')) as LlmClient['callOrchestrator'],
      callWorker: async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated' as const, attempts: 1, durationMs: 0 }),
    } as unknown as LlmClient;
    let callCount = 0;
    const multiLlm: LlmClient = {
      callOrchestrator: async (opts) => {
        callCount++;
        if (callCount === 1) return llmResponse('{"scope":"test","assumptions":[],"perspectives":[],"falsificationQuestions":[]}');
        if (callCount === 2) return llmResponse('THOUGHT: need to search\nACTION: search_web\nARGUMENTS: {"query":"What is React?"}');
        return llmResponse('THOUGHT: done\nANSWER: Done.');
      },
      callWorker: async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated' as const, attempts: 1, durationMs: 0 }),
    } as unknown as LlmClient;
    const ctx = makeStrategyCtx(provider, { root, llm: multiLlm });
    const s = new AgentStrategy(ctx);
    await s.analyze('What is React?', ctx);

    expect(seen.length).toBeGreaterThan(0);
    for (const callCtx of seen) {
      expect(callCtx.deadlineAt).toBe(root.deadlineAt);
      expect(callCtx.trace.traceId).toBe(root.trace.traceId);
    }
  });
});

// ── Mock provider ────────────────────────────────────────────────────────

interface MockHooks {
  searchHits?: number;
  failSearch?: boolean;
  failRead?: boolean;
  onSearch?: (ctx: ProviderCallContext) => void;
  onRead?: (ctx: ProviderCallContext) => void;
}

function createMockProvider(hooks: MockHooks = {}): ResearchProvider {
  return {
    name: 'mock-provider',
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
    async search(_ctx, query: string, opts?: { limit?: number }) {
      hooks.onSearch?.(_ctx);
      if (hooks.failSearch === true) throw new Error('search failed');
      if (typeof hooks.searchHits === 'number') {
        // controller abort handled via signal by caller when needed
        return Array.from({ length: Math.min(opts?.limit ?? 10, hooks.searchHits) }, (_, i) => ({
          url: `https://example.com/${encodeURIComponent(query)}-${i}`,
          title: `Result ${i} for ${query}`,
          snippet: 'x',
        }));
      }
      return [];
    },
    async read(ctx, url: string) {
      hooks.onRead?.(ctx);
      if (hooks.failRead === true) throw new Error('read failed');
      return { url, title: 'Page Title', content: 'content '.repeat(50), contentHash: 'abc123' };
    },
    async crawl(url: string) {
      return [{ url, content: 'crawled', contentHash: 'def', depth: 1 }];
    },
    async academic() { return []; },
  };
}
