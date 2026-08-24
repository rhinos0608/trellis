import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { PipelineStrategy } from '../../src/research/strategies/pipelineStrategy.js';
import type { StrategyContext } from '../../src/research/strategies/types.js';
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';
import type { RunContext } from '../../src/research/types.js';

// ── Mock provider ────────────────────────────────────────────────────────

function createMockProvider(): ResearchProvider {
  return {
    name: 'mock-provider',
    capabilities: {
      search: true,
      read: true,
      academic: true,
      code: false,
      community: { reddit: false, hackernews: false, stackoverflow: false },
      media: false,
      reference: false,
      browser: false,
    },
    async search(query: string, opts?: { limit?: number }) {
      const limit = opts?.limit ?? 10;
      return Array.from({ length: Math.min(limit, 5) }, (_, i) => ({
        url: `https://example.com/${encodeURIComponent(query)}-${i}`,
        title: `Result ${i} for ${query}`,
        snippet: `This is a snippet about ${query} from source ${i}.`,
      }));
    },
    async read(url: string) {
      return {
        url,
        title: 'Page Title',
        content: 'This is the full page content. '.repeat(50),
        contentHash: 'abc123',
      };
    },
    async crawl(url: string) {
      return [{ url, content: 'crawled', contentHash: 'def', depth: 1 }];
    },
    async academic(query: string) {
      return [{
        url: `https://arxiv.org/abs/${encodeURIComponent(query)}`,
        title: `Academic paper on ${query}`,
        snippet: 'Academic snippet',
      }];
    },
  };
}

function makeConfig(): TrellisConfig {
  return {
    storage: { dbPath: ':memory:' },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'echo', args: [] },
    logLevel: 'silent',
  };
}

function makeRunContext(): RunContext {
  return {
    familyId: 'fam-test',
    researchRunId: 'run-test',
  };
}

function makeStrategyCtx(overrides?: {
  provider?: ResearchProvider;
  budgetOverrides?: Record<string, number>;
}): StrategyContext {
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
    ...overrides?.budgetOverrides,
  });
  const state = new ResearchStateEngine(budget);
  return {
    state,
    budget,
    provider: overrides?.provider ?? createMockProvider(),
    config: makeConfig(),
    runContext: makeRunContext(),
    depth: 'standard',
  };
}

describe('PipelineStrategy', () => {
  it('returns ResearchResult with report, timeline, and canonicalFindings', async () => {
    const strategy = new PipelineStrategy();
    const ctx = makeStrategyCtx();
    const result = await strategy.analyze('What is React?', ctx);

    // Validate the contract shape
    expect(result).toHaveProperty('report');
    expect(result).toHaveProperty('timeline');
    expect(result).toHaveProperty('canonicalFindings');

    const { report } = result;
    expect(report.query).toBe('What is React?');
    expect(report.classification).toBe('explainer');
    expect(typeof report.degradationMode).toBe('string');
    expect(typeof report.executiveSummary).toBe('string');
    expect(typeof report.narrativeMarkdown).toBe('string');
    expect(Array.isArray(report.themes)).toBe(true);
    expect(Array.isArray(report.contradictions)).toBe(true);
    expect(Array.isArray(report.uncertainties)).toBe(true);
    expect(Array.isArray(report.sourceNotes)).toBe(true);
    expect(Array.isArray(report.openQuestions)).toBe(true);
    expect(Array.isArray(report.limitations)).toBe(true);
    expect(typeof report.sourceCount).toBe('number');
    expect(typeof report.findingCount).toBe('number');
    expect(Array.isArray(report.sourceDiversity)).toBe(true);
    expect(Array.isArray(report.evidenceSources)).toBe(true);
  });

  it('report is structured (not narrative prose as source)', async () => {
    const strategy = new PipelineStrategy();
    const ctx = makeStrategyCtx();
    const result = await strategy.analyze('What is React?', ctx);

    // Structured output: findings are separate from report
    expect(result.canonicalFindings).toBeDefined();
    expect(Array.isArray(result.canonicalFindings)).toBe(true);

    // report.findingCount matches canonicalFindings length
    expect(result.report.findingCount).toBe(result.canonicalFindings!.length);
  });

  it('sources are discovered via provider', async () => {
    const strategy = new PipelineStrategy();
    const ctx = makeStrategyCtx();
    await strategy.analyze('Test query', ctx);

    // State should have sources from the mock provider
    expect(ctx.state.sourceCount()).toBeGreaterThan(0);
  });

  it('findings are extracted from sources', async () => {
    const strategy = new PipelineStrategy();
    const ctx = makeStrategyCtx();
    const result = await strategy.analyze('Test query', ctx);

    // The mock provider returns content >100 chars, so findings should be created
    expect(ctx.state.findingCount()).toBeGreaterThan(0);
    expect(result.canonicalFindings!.length).toBeGreaterThan(0);
  });

  it('timeline contains phase entries', async () => {
    const strategy = new PipelineStrategy();
    const ctx = makeStrategyCtx();
    const result = await strategy.analyze('Test query', ctx);

    expect(result.timeline.length).toBeGreaterThan(0);
    const phases = result.timeline.map((p) => p.phase);
    expect(phases).toContain('decomposition');
    expect(phases).toContain('discovery');
  });

  it('handles budget exhaustion gracefully', async () => {
    const strategy = new PipelineStrategy();
    const ctx = makeStrategyCtx({
      budgetOverrides: { maxToolCalls: 1, maxTimeMs: 999_999_999 },
    });
    // Pre-exhaust budget
    ctx.budget.recordToolCall();
    const result = await strategy.analyze('Test query', ctx);
    // Should still return a valid report (partial synthesis)
    expect(result.report).toBeDefined();
    expect(result.report.query).toBe('Test query');
  });

  it('sub-questions are generated during decomposition', async () => {
    const strategy = new PipelineStrategy();
    const ctx = makeStrategyCtx();
    await strategy.analyze('Test query', ctx);

    const sqs = ctx.state.getSubQuestions();
    expect(sqs.length).toBe(5); // fixed dimensions
    expect(sqs[0]!.text).toContain('Test query');
  });

  it('provider.read is called for extraction', async () => {
    const readCalls: string[] = [];
    const provider = createMockProvider();
    const originalRead = provider.read;
    provider.read = async (url: string) => {
      readCalls.push(url);
      return originalRead(url);
    };

    const strategy = new PipelineStrategy();
    const ctx = makeStrategyCtx({ provider });
    await strategy.analyze('Test query', ctx);

    expect(readCalls.length).toBeGreaterThan(0);
  });

  it('close() cleans up', async () => {
    const strategy = new PipelineStrategy();
    await expect(strategy.close()).resolves.toBeUndefined();
  });
});

describe('StrategyRegistry', () => {
  it('registers and creates strategies', async () => {
    const { StrategyRegistry } = await import('../../src/research/strategies/registry.js');
    const registry = new StrategyRegistry();
    registry.register('pipeline', (ctx) => {
      const s = new PipelineStrategy();
      return s;
    });

    expect(registry.has('pipeline')).toBe(true);
    expect(registry.has('agent')).toBe(false);

    const ctx = makeStrategyCtx();
    const strategy = registry.create('pipeline', ctx);
    expect(strategy.name).toBe('pipeline');
  });

  it('throws for unknown strategy', async () => {
    const { StrategyRegistry } = await import('../../src/research/strategies/registry.js');
    const registry = new StrategyRegistry();
    const ctx = makeStrategyCtx();
    expect(() => registry.create('nonexistent', ctx)).toThrow('Unknown strategy');
  });

  it('selectDefault returns pipeline when no LLM', async () => {
    const { StrategyRegistry } = await import('../../src/research/strategies/registry.js');
    const registry = new StrategyRegistry();
    const ctx = makeStrategyCtx();
    expect(registry.selectDefault(ctx)).toBe('pipeline');
  });

  it('selectDefault returns pipeline for deterministic mode', async () => {
    const { StrategyRegistry } = await import('../../src/research/strategies/registry.js');
    const registry = new StrategyRegistry();
    const ctx = makeStrategyCtx();
    ctx.deterministic = true;
    expect(registry.selectDefault(ctx)).toBe('pipeline');
  });

  it('selectDefault returns tree for tree depth', async () => {
    const { StrategyRegistry } = await import('../../src/research/strategies/registry.js');
    const registry = new StrategyRegistry();
    const ctx = makeStrategyCtx();
    ctx.depth = 'tree';
    expect(registry.selectDefault(ctx)).toBe('tree');
  });
});
