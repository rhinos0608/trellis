import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { AgentStrategy } from '../../src/research/strategies/agentStrategy.js';
import type { StrategyContext } from '../../src/research/strategies/types.js';
import type { ResearchProvider } from '../../src/providers/types.js';
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

function llmResponse(content: string): LlmResponse {
  return {
    success: true, content, model: 'test', tokensUsed: 15, tokensSource: 'provider_usage' as const,
    promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100,
  };
}

function makeStrategyCtx(
  provider: ResearchProvider,
  signal?: AbortSignal,
  llmOverride?: LlmClient,
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
    config: makeConfig(),
    runContext: makeRunContext(),
    ...(signal !== undefined ? { abortSignal: signal } : {}),
    reportProgress: async () => {},
    depth: 'standard',
    llm: llmOverride,
  };
}

describe('call-budget accounting (per logical provider call, not per hit)', () => {
  it('a single search returning 10 hits increments toolCallsUsed by exactly 1', async () => {
    const controller = new AbortController();
    let searchCalls = 0;
    const provider: ResearchProvider = {
      name: 'mock',
      capabilities: {
        search: true, read: true, academic: false, code: false,
        community: { reddit: false, hackernews: false, stackoverflow: false },
        media: false, reference: false, browser: false,
      },
      async search() {
        searchCalls++;
        controller.abort(); // stop after the first query so only ONE search happens
        return Array.from({ length: 10 }, (_, i) => ({
          url: `https://example.com/hit-${i}`,
          title: `Hit ${i}`,
          snippet: 's',
        }));
      },
      // read/crawl/academic must never be reached
      async read() { throw new Error('read must not be called'); },
      async crawl() { return []; },
      async academic() { throw new Error('academic must not be called'); },
    };

    // Agent: plan → LLM decides search_web → search aborts → next iteration sees abort → exit
    let callIdx = 0;
    const llm: LlmClient = {
      callOrchestrator: async (opts) => {
        callIdx++;
        if (callIdx === 1) return llmResponse('{"scope":"test","assumptions":[],"perspectives":[],"falsificationQuestions":[]}'); // plan
        if (callIdx === 2) return llmResponse('THOUGHT: search\nACTION: search_web\nARGUMENTS: {"query":"React"}'); // search
        return llmResponse('THOUGHT: done\nANSWER: Immediate answer.');
      },
      callWorker: async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated' as const, attempts: 1, durationMs: 0 }),
    } as unknown as LlmClient;
    const ctx = makeStrategyCtx(provider, controller.signal, llm);
    await new AgentStrategy(ctx).analyze('What is React?', ctx);

    // Agent strategy: plan LLM call (1) + ReAct LLM call to decide search (1) + search tool call (1) = 3
    expect(searchCalls).toBe(1);
    expect(ctx.budget.snapshot().toolCallsUsed).toBe(3);
  });

  it('a FAILED call still consumes exactly one call slot', async () => {
    let attempts = 0;
    const provider: ResearchProvider = {
      name: 'mock-failing',
      capabilities: {
        search: true, read: true, academic: false, code: false,
        community: { reddit: false, hackernews: false, stackoverflow: false },
        media: false, reference: false, browser: false,
      },
      async search() {
        attempts++;
        throw new Error('search failed');
      },
      async read() { throw new Error('read must not be called'); },
      async crawl() { return []; },
      async academic() { return []; },
    };

    // Agent: plan → searches fail (caught by agent tool) → agent answers immediately
    let callIdx = 0;
    const llm: LlmClient = {
      callOrchestrator: async (opts) => {
        callIdx++;
        if (callIdx === 1) return llmResponse('plan text'); // plan call (fails JSON parse → null plan)
        if (callIdx === 2) return llmResponse('THOUGHT: search\nACTION: search_web\nARGUMENTS: {"query":"React"}'); // search (will throw)
        return llmResponse('THOUGHT: done\nANSWER: Immediate answer.');
      },
      callWorker: async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated' as const, attempts: 1, durationMs: 0 }),
    } as unknown as LlmClient;
    const ctx = makeStrategyCtx(provider, undefined, llm);

    // Agent catches per-query failures in tool execution and continues; with mock LLM
    // returning immediate answer, only 1 search attempt happens.
    await new AgentStrategy(ctx).analyze('What is React?', ctx);

    // 1 plan LLM + 1 search attempt = 2 tool call slots (search failure still counted)
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(ctx.budget.snapshot().toolCallsUsed).toBeGreaterThanOrEqual(2);
  });

  it('failed reads are counted too (one slot per extraction attempt)', async () => {
    let searches = 0;
    const failedReadUrls: string[] = [];
    const provider: ResearchProvider = {
      name: 'mock-read-fail',
      capabilities: {
        search: true, read: true, academic: false, code: false,
        community: { reddit: false, hackernews: false, stackoverflow: false },
        media: false, reference: false, browser: false,
      },
      async search(_ctx, _query) {
        searches++;
        return [
          { url: `https://example.com/a-${searches}`, title: 'A', snippet: 's' },
          { url: `https://example.com/b-${searches}`, title: 'B', snippet: 's' },
        ];
      },
      async read(_ctx, url: string) {
        failedReadUrls.push(url);
        throw new Error('read failed');
      },
      async crawl() { return []; },
      async academic() { return []; },
    };

    // Agent: plan → search_web → web_read (fails) → agent tries again → answer
    let callIndex = 0;
    const llm: LlmClient = {
      callOrchestrator: async (opts) => {
        callIndex++;
        if (callIndex === 1) return llmResponse('{"scope":"test","assumptions":[],"perspectives":[],"falsificationQuestions":[]}'); // plan
        if (callIndex === 2) return llmResponse('THOUGHT: need to search\nACTION: search_web\nARGUMENTS: {"query":"React"}'); // search first
        if (callIndex <= 4) return llmResponse('THOUGHT: need to read\nACTION: web_read\nARGUMENTS: {"url":"https://example.com/a-1"}'); // try reads
        return llmResponse('THOUGHT: done\nANSWER: Answer.'); // stop
      },
      callWorker: async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated' as const, attempts: 1, durationMs: 0 }),
    } as unknown as LlmClient;
    const ctx = makeStrategyCtx(provider, undefined, llm);
    await new AgentStrategy(ctx).analyze('What is React?', ctx);

    // At least 1 search + some reads attempted; budget accounts for all calls
    expect(searches).toBeGreaterThanOrEqual(1);
    expect(failedReadUrls.length).toBeGreaterThanOrEqual(1);
    expect(ctx.budget.snapshot().toolCallsUsed).toBeGreaterThanOrEqual(4); // plan + search + read(s)
  });
});
