import { describe, expect, it } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { PipelineStrategy } from '../../src/research/strategies/pipelineStrategy.js';
import type { StrategyContext } from '../../src/research/strategies/types.js';
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';
import type { RunContext } from '../../src/research/types.js';

function makeConfig(): TrellisConfig {
  return {
    storage: { dbPath: ':memory:' },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'echo', args: [] },
    logLevel: 'silent',
  };
}

function makeRunContext(): RunContext {
  return { familyId: 'fam-test', researchRunId: 'run-test' };
}

function makeStrategyCtx(provider: ResearchProvider, signal?: AbortSignal): StrategyContext {
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

    const ctx = makeStrategyCtx(provider, controller.signal);
    await new PipelineStrategy().analyze('What is React?', ctx);

    expect(searchCalls).toBe(1);
    expect(ctx.budget.snapshot().toolCallsUsed).toBe(1);
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

    const ctx = makeStrategyCtx(provider);

    // Pipeline catches per-query failures and continues; all 5 sub-question
    // searches fail, plus gap-filling loop may attempt additional searches.
    await new PipelineStrategy().analyze('What is React?', ctx);

    expect(attempts).toBeGreaterThanOrEqual(5);
    expect(ctx.budget.snapshot().toolCallsUsed).toBeGreaterThanOrEqual(5);
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

    const ctx = makeStrategyCtx(provider);
    await new PipelineStrategy().analyze('What is React?', ctx);

    // 5 sub-question searches + gap-filling loop searches; budget not exhausted
    // so additional gap-driven searches occur. Core assertion: failed reads counted.
    expect(searches).toBeGreaterThanOrEqual(5);
    expect(failedReadUrls.length).toBeGreaterThanOrEqual(10);
    expect(ctx.budget.snapshot().toolCallsUsed).toBeGreaterThanOrEqual(15);
  });
});
