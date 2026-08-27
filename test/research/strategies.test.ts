import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { AgentStrategy } from '../../src/research/strategies/agentStrategy.js';
import type { StrategyContext, ResearchPlan } from '../../src/research/strategies/types.js';
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';
import type { RunContext } from '../../src/research/types.js';
import type { LlmClient, LlmResponse } from '../../src/research/llm/client.js';

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

// ── AgentStrategy tests ────────────────────────────────────────────────

type LlmCallFn = (opts: { messages: { role: string; content: string }[] }) => Promise<LlmResponse>;

function makeMockLlm(calls: LlmCallFn[]): LlmClient {
  let callIndex = 0;
  const fake: Record<string, unknown> = {
    callOrchestrator: async (opts: { messages: { role: string; content: string }[] }) => {
      const fn = calls[Math.min(callIndex, calls.length - 1)]!;
      callIndex++;
      return fn(opts);
    },
    callWorker: async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated' as const, attempts: 1, durationMs: 0 }),
  };
  return fake as unknown as LlmClient;
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

const VALID_PLAN_JSON = JSON.stringify({
  scope: 'Investigate TypeScript features and ecosystem.',
  assumptions: ['TypeScript is widely used'],
  perspectives: [
    { name: 'implementer', question: 'How does TypeScript improve developer productivity?' },
    { name: 'skeptic', question: 'What are the costs of adopting TypeScript?' },
  ],
  falsificationQuestions: ['Would any evidence show TypeScript reduces productivity?'],
});

function makeAgentStrategyCtx(overrides?: {
  llm?: LlmClient;
  persistPlan?: StrategyContext['persistPlan'];
  getPriorKnowledge?: StrategyContext['getPriorKnowledge'];
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
    llm: overrides?.llm,
    config: makeConfig(),
    runContext: makeRunContext(),
    reportProgress: async () => {},
    depth: 'standard',
    ...(overrides?.persistPlan !== undefined ? { persistPlan: overrides.persistPlan } : {}),
    ...(overrides?.getPriorKnowledge !== undefined ? { getPriorKnowledge: overrides.getPriorKnowledge } : {}),
  };
}

describe('AgentStrategy', () => {
  it('returns empty result when no LLM', async () => {
    const ctx = makeAgentStrategyCtx();
    const strategy = new AgentStrategy(ctx);
    const result = await strategy.analyze('Test query', ctx);
    expect(result.report.query).toBe('Test query');
    expect(result.report.degradationMode).toBe('source_note_synthesis');
    expect(result.report.limitations).toContain('Agent strategy requires an LLM.');
  });

  it('generates plan via LLM and persists it', async () => {
    const persistCalls: { plan: ResearchPlan; kind: string }[] = [];
    const llm = makeMockLlm([
      // First call: plan generation
      () => llmResponse(VALID_PLAN_JSON),
      // Second call: answer immediately
      () => llmResponse('THOUGHT: Found enough info\nANSWER: TypeScript is great.'),
    ]);
    const ctx = makeAgentStrategyCtx({
      llm,
      persistPlan: async (plan, kind) => { persistCalls.push({ plan, kind }); },
    });
    const strategy = new AgentStrategy(ctx);
    await strategy.analyze('What is TypeScript?', ctx);

    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]!.kind).toBe('created');
    expect(persistCalls[0]!.plan.scope).toContain('TypeScript');
    expect(persistCalls[0]!.plan.perspectives.length).toBeGreaterThanOrEqual(2);
  });

  it('calls postProcessFindings, markAudited, and synthesizes', async () => {
    const llm = makeMockLlm([
      () => llmResponse(VALID_PLAN_JSON),
      () => llmResponse('THOUGHT: need to search\nACTION: search_web\nARGUMENTS: {"query": "TypeScript"}'),
      () => llmResponse('THOUGHT: enough data\nANSWER: TypeScript is great.'),
    ]);
    const ctx = makeAgentStrategyCtx({ llm });
    const strategy = new AgentStrategy(ctx);
    const result = await strategy.analyze('What is TypeScript?', ctx);

    // Output parity: report is synthesized, audit flag is set
    expect(result.report).toBeDefined();
    expect(result.report.query).toBe('What is TypeScript?');
    expect(result.report.narrativeMarkdown).toContain('Research Report');
    expect(ctx.state.isAudited()).toBe(true);
    expect(result.canonicalFindings).toBeDefined();
    expect(Array.isArray(result.canonicalFindings)).toBe(true);
  });

  it('includes prior knowledge in planning prompt', async () => {
    const priorClaims = ['TypeScript 5.0 introduced decorators', 'TypeScript is maintained by Microsoft'];
    const priorGaps = ['Missing coverage of TypeScript performance benchmarks'];
    let planningPrompt = '';
    const llm = makeMockLlm([
      (opts) => {
        planningPrompt = opts.messages.map((m) => m.content).join('\n');
        return llmResponse(VALID_PLAN_JSON);
      },
      () => llmResponse('THOUGHT: done\nANSWER: Answer.'),
    ]);
    const ctx = makeAgentStrategyCtx({
      llm,
      getPriorKnowledge: async () => ({ knownClaims: priorClaims, knownGaps: priorGaps }),
    });
    const strategy = new AgentStrategy(ctx);
    await strategy.analyze('TypeScript?', ctx);

    expect(planningPrompt).toContain('PRIOR KNOWLEDGE');
    expect(planningPrompt).toContain(priorClaims[0]!);
    expect(planningPrompt).toContain(priorGaps[0]!);
  });

  it('sets sub-questions from plan perspectives', async () => {
    const llm = makeMockLlm([
      () => llmResponse(VALID_PLAN_JSON),
      () => llmResponse('THOUGHT: done\nANSWER: Answer.'),
    ]);
    const ctx = makeAgentStrategyCtx({ llm });
    const strategy = new AgentStrategy(ctx);
    await strategy.analyze('TypeScript?', ctx);

    const sqs = ctx.state.getSubQuestions();
    expect(sqs.length).toBe(2);
    expect(sqs[0]!.text).toContain('developer productivity');
    expect(sqs[1]!.text).toContain('costs of adopting');
  });

  it('works without persistPlan callback', async () => {
    const llm = makeMockLlm([
      () => llmResponse(VALID_PLAN_JSON),
      () => llmResponse('THOUGHT: done\nANSWER: Answer.'),
    ]);
    const ctx = makeAgentStrategyCtx({ llm });
    const strategy = new AgentStrategy(ctx);
    // No persistPlan set — should not throw
    const result = await strategy.analyze('TypeScript?', ctx);
    expect(result.report).toBeDefined();
  });

  it('handles invalid plan JSON gracefully', async () => {
    const llm = makeMockLlm([
      () => llmResponse('This is not JSON at all'),
      () => llmResponse('THOUGHT: done\nANSWER: Answer.'),
    ]);
    const ctx = makeAgentStrategyCtx({ llm });
    const strategy = new AgentStrategy(ctx);
    const result = await strategy.analyze('TypeScript?', ctx);
    // Should still produce a valid result
    expect(result.report).toBeDefined();
    expect(result.report.query).toBe('TypeScript?');
  });

  it('close() cleans up', async () => {
    const ctx = makeAgentStrategyCtx();
    const strategy = new AgentStrategy(ctx);
    await expect(strategy.close()).resolves.toBeUndefined();
  });
});
