/**
 * Tests that the agent strategy rejects malicious URLs
 * before sending them to the provider (MCP read/crawl calls).
 */
import { describe, it, expect, vi } from 'vitest';
import { validateFetchableUrl } from '../../../src/providers/searchMcp/urlPolicy.js';
import { AgentStrategy } from '../../../src/research/strategies/agentStrategy.js';
import { BudgetTracker } from '../../../src/research/budget.js';
import { ResearchStateEngine } from '../../../src/research/state.js';
import type { ResearchProvider } from '../../../src/providers/types.js';
import type { StrategyContext } from '../../../src/research/strategies/types.js';

function strategyContext(provider: ResearchProvider, llm?: unknown): StrategyContext {
  const budget = new BudgetTracker({ depth: 'quick', maxSources: 10, maxExtractions: 10, maxGapLoops: 1, minGapLoops: 0, maxToolCalls: 20, maxTokens: 10000, maxTimeMs: 60000, maxStateEntries: 100 });
  return {
    state: new ResearchStateEngine(budget), budget, provider, llm: llm as StrategyContext['llm'],
    config: { storage: { dbPath: ':memory:' }, llm: {}, searchProvider: { command: 'echo', args: [] }, logLevel: 'silent' },
    runContext: { familyId: 'family', researchRunId: 'run' }, reportProgress: async () => {}, depth: 'quick',
  };
}

function urlTestProvider(url: string, read: () => void): ResearchProvider {
  return {
    name: 'test', capabilities: { search: true, read: true, academic: false, code: false, community: { reddit: false, hackernews: false, stackoverflow: false }, media: false, reference: false, browser: false },
    search: async () => [{ url, title: 'unsafe result' }],
    read: async () => { read(); return { url, title: 'read', content: 'content'.repeat(100), contentHash: 'hash' }; },
    crawl: async () => [], academic: async () => [],
  };
}

describe('URL validation (agentStrategy)', () => {
  it('validateFetchableUrl rejects file: scheme (pre-read guard)', () => expect(() => validateFetchableUrl('file:///etc/passwd')).toThrow());
  it('validateFetchableUrl rejects javascript: scheme', () => expect(() => validateFetchableUrl('javascript:alert(1)')).toThrow());
  it('validateFetchableUrl rejects localhost', () => expect(() => validateFetchableUrl('http://localhost/secret')).toThrow());
  it('validateFetchableUrl rejects literal IP', () => expect(() => validateFetchableUrl('http://169.254.169.254/metadata')).toThrow());
  it('validateFetchableUrl accepts safe URL', () => expect(() => validateFetchableUrl('https://example.com/page')).not.toThrow());

  it('validateFetchableUrl blocks attacker-controlled URLs at boundary', () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<script>alert(1)</script>', 'javascript:void(0)', 'ftp://evil.com/payload', 'http://127.0.0.1/admin', 'http://[::1]/admin', 'http://10.0.0.1/metadata', 'http://192.168.1.1/router']) expect(() => validateFetchableUrl(url)).toThrow();
  });

  it('does not call provider.read for invalid agent URL', async () => {
    let reads = 0;
    const provider = urlTestProvider('https://safe.example', () => { reads++; });
    const llm = { callOrchestrator: vi.fn()
      .mockResolvedValueOnce({ success: true, content: 'THOUGHT: read\nACTION: web_read\nARGUMENTS: {"url":"file:///etc/passwd"}' })
      .mockResolvedValueOnce({ success: true, content: 'THOUGHT: done\nANSWER: finished' }) };
    const ctx = strategyContext(provider, llm);
    await new AgentStrategy(ctx).analyze('query', ctx);
    expect(reads).toBe(0);
  });
});
