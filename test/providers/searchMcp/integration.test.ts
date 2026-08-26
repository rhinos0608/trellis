/**
 * Integration test for search-mcp adapter.
 *
 * Mocks the MCP transport to verify the full adapter flow:
 * provider creation → method call → MCP tool call → response mapping.
 *
 * No real search-mcp server required — tests protocol and mapping logic
 * by simulating MCP tool responses.
 */

import { describe, it, expect, beforeEach } from 'vitest';

const testCtx = { signal: new AbortController().signal, runId: 'test', deadlineAt: Date.now() + 300_000, trace: { traceId: 'test', spanId: 'test' } };
import { createSearchMcpProviderFromClient } from '../../../src/providers/searchMcp/index.js';
import type { SearchMcpClient, ToolCallResult } from '../../../src/providers/searchMcp/client.js';

// ── Mock MCP client ──────────────────────────────────────────────────

function createMockClient(
  toolHandler: (name: string, args: Record<string, unknown>) => ToolCallResult,
): SearchMcpClient {
  return {
    async callTool(name: string, args: Record<string, unknown>, _options: { signal: AbortSignal; deadlineAt: number }): Promise<ToolCallResult> {
      return toolHandler(name, args);
    },
    async close() {},
  };
}

const FULL_TOOL_NAMES = [
  'web_search', 'web_crawl', 'research', 'github',
  'reddit', 'youtube', 'browser', 'semantic_crawl',
];

// ── Tests ────────────────────────────────────────────────────────────

describe('SearchMcpProvider integration', () => {
  let calls: { name: string; args: Record<string, unknown> }[];

  beforeEach(() => {
    calls = [];
  });

  function handler(name: string, args: Record<string, unknown>): ToolCallResult {
    calls.push({ name, args });

    // Simulate search-mcp responses for different tools
    switch (name) {
      case 'web_search':
        return {
          data: {
            query: args.query,
            results: [
              { url: 'https://example.com/1', title: 'Result 1', snippet: 'Snippet 1', domain: 'example.com' },
              { url: 'https://example.com/2', title: 'Result 2', snippet: 'Snippet 2' },
            ],
          },
          content: [],
        };

      case 'web_crawl':
        return {
          data: {
            pages: [
              {
                url: args.url,
                content: '# Page Content\n\nThis is the page content.',
                title: 'Test Page',
                depth: 0,
              },
            ],
          },
          content: [],
        };

      case 'research':
        if (args.action === 'academic') {
          return {
            data: [
              { title: 'Paper 1', url: 'https://arxiv.org/abs/1234.5678', abstract: 'Abstract 1', date: '2024-01-15' },
              { title: 'Paper 2', url: 'https://doi.org/10.1234/test', abstract: 'Abstract 2' },
            ],
            content: [],
          };
        }
        if (args.action === 'wikipedia') {
          return {
            data: [
              { title: 'Quantum Computing', url: 'https://en.wikipedia.org/wiki/Quantum_computing', snippet: 'Overview of quantum computing' },
            ],
            content: [],
          };
        }
        if (args.action === 'hackernews') {
          return {
            data: [
              { title: 'HN Post', url: 'https://news.ycombinator.com/item?id=123', snippet: 'HN content' },
            ],
            content: [],
          };
        }
        if (args.action === 'stackoverflow') {
          return {
            data: [
              { title: 'SO Question', url: 'https://stackoverflow.com/q/123', snippet: 'Question body' },
            ],
            content: [],
          };
        }
        return { data: [], content: [] };

      case 'github':
        return {
          data: {
            items: [
              { full_name: 'facebook/react', html_url: 'https://github.com/facebook/react', description: 'A JS library', stargazers_count: 200000 },
            ],
          },
          content: [],
        };

      case 'reddit':
        if (args.action === 'search') {
          return {
            data: [
              { title: 'Reddit Post', url: 'https://reddit.com/r/test/abc', subreddit: 'test', score: 100, num_comments: 20, createdAt: '2024-01-01' },
            ],
            content: [],
          };
        }
        if (args.action === 'comments') {
          return {
            data: {
              post: { title: 'Thread', url: args.url, selftext: 'Thread body' },
              comments: [
                { author: 'user1', body: 'Comment 1', score: 10 },
              ],
            },
            content: [],
          };
        }
        return { data: [], content: [] };

      case 'youtube':
        if (args.action === 'search') {
          return {
            data: [
              { videoId: 'abc123', title: 'Video Title', channelTitle: 'Channel', publishedAt: '2024-01-01' },
            ],
            content: [],
          };
        }
        if (args.action === 'transcript') {
          return {
            data: [
              { text: 'Hello world', start: 0, duration: 2.5 },
              { text: 'This is a test', start: 2.5, duration: 1.5 },
            ],
            content: [],
          };
        }
        return { data: [], content: [] };

      default:
        return { data: null, content: [] };
    }
  }

  it('has correct capabilities', () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    expect(provider.name).toBe('search-mcp');
    expect(provider.capabilities.search).toBe(true);
    expect(provider.capabilities.read).toBe(true);
    expect(provider.capabilities.academic).toBe(true);
    expect(provider.capabilities.code).toBe(true);
    expect(provider.capabilities.community.reddit).toBe(true);
    expect(provider.capabilities.media).toBe(true);
  });

  it('search() calls web_search and returns ResearchHit[]', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.search(testCtx, 'machine learning', { limit: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('web_search');
    expect(calls[0].args.query).toBe('machine learning');
    expect(calls[0].args.limit).toBe(5);

    expect(hits).toHaveLength(2);
    expect(hits[0].url).toBe('https://example.com/1');
    expect(hits[0].title).toBe('Result 1');
    expect(hits[0].snippet).toBe('Snippet 1');
    expect(hits[0].domain).toBe('example.com');
  });

  it('read() calls web_crawl and returns ReadResult', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const result = await provider.read(testCtx, 'https://example.com');

    expect(calls[0].name).toBe('web_crawl');
    expect(calls[0].args.url).toBe('https://example.com');

    expect(result.url).toBe('https://example.com');
    expect(result.content).toContain('Page Content');
    expect(result.title).toBe('Test Page');
    expect(result.contentHash).toMatch(/^djb2:/);
  });

  it('academic() calls research.academic and returns ResearchHit[]', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.academic(testCtx, 'quantum computing', { source: 'arxiv', limit: 10 });

    expect(calls[0].name).toBe('research');
    expect(calls[0].args.action).toBe('academic');
    expect(calls[0].args.source).toBe('arxiv');

    expect(hits).toHaveLength(2);
    expect(hits[0].title).toBe('Paper 1');
    expect(hits[0].url).toBe('https://arxiv.org/abs/1234.5678');
    expect(hits[0].snippet).toBe('Abstract 1');
  });

  it('wikipedia() calls research.wikipedia', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.wikipedia(testCtx, 'quantum mechanics');

    expect(calls[0].name).toBe('research');
    expect(calls[0].args.action).toBe('wikipedia');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('Quantum Computing');
  });

  it('github() calls github.search and returns GitHubHit[]', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.github(testCtx, 'react');

    expect(calls[0].name).toBe('github');
    expect(calls[0].args.action).toBe('search');
    expect(hits).toHaveLength(1);
    expect(hits[0].repo).toBe('facebook/react');
    expect(hits[0].stars).toBe(200000);
  });

  it('reddit() calls reddit.search and returns RedditHit[]', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.reddit(testCtx, 'frameworks', { subreddit: 'javascript' });

    expect(calls[0].name).toBe('reddit');
    expect(calls[0].args.action).toBe('search');
    expect(calls[0].args.subreddit).toBe('javascript');
    expect(hits).toHaveLength(1);
    expect(hits[0].subreddit).toBe('test');
  });

  it('redditThread() calls reddit.comments and returns RedditThread', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const thread = await provider.redditThread!(testCtx, 'https://reddit.com/r/test/abc');

    expect(calls[0].name).toBe('reddit');
    expect(calls[0].args.action).toBe('comments');
    expect(thread.title).toBe('Thread');
    expect(thread.body).toBe('Thread body');
    expect(thread.comments).toHaveLength(1);
  });

  it('hackernews() calls research.hackernews', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.hackernews!('rust');

    expect(calls[0].name).toBe('research');
    expect(calls[0].args.action).toBe('hackernews');
    expect(hits).toHaveLength(1);
  });

  it('stackoverflow() calls research.stackoverflow', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.stackoverflow!('typescript generics');

    expect(calls[0].name).toBe('research');
    expect(calls[0].args.action).toBe('stackoverflow');
    expect(hits).toHaveLength(1);
  });

  it('youtube() calls youtube.search and returns YouTubeHit[]', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.youtube!('tutorial');

    expect(calls[0].name).toBe('youtube');
    expect(calls[0].args.action).toBe('search');
    expect(hits).toHaveLength(1);
    expect(hits[0].videoId).toBe('abc123');
    expect(hits[0].channel).toBe('Channel');
  });

  it('youtubeTranscript() calls youtube.transcript', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const segments = await provider.youtubeTranscript!(testCtx, 'abc123', 'en');

    expect(calls[0].name).toBe('youtube');
    expect(calls[0].args.action).toBe('transcript');
    expect(calls[0].args.videoId).toBe('abc123');
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('Hello world');
    expect(segments[1].start).toBe(2.5);
  });

  it('crawl() calls web_crawl and returns CrawlResult[]', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const results = await provider.crawl(testCtx, 'https://example.com', { maxPages: 3 });

    expect(calls[0].name).toBe('web_crawl');
    expect(calls[0].args.maxPages).toBe(3);
    expect(results).toHaveLength(1);
    expect(results[0].depth).toBe(0);
  });

  it('browser.open() calls browser.session start', async () => {
    const client = createMockClient(handler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const sessionId = await provider.browser!.open({ headless: true });

    expect(calls[0].name).toBe('browser');
    expect(calls[0].args.action).toBe('session');
    expect(calls[0].args.op).toBe('start');
    expect(typeof sessionId).toBe('string');
  });

  it('handles empty results gracefully', async () => {
    const emptyHandler = (): ToolCallResult => ({ data: [], content: [] });
    const client = createMockClient(emptyHandler);
    const provider = createSearchMcpProviderFromClient(client, FULL_TOOL_NAMES);

    const hits = await provider.search(testCtx, 'nothing');
    expect(hits).toEqual([]);

    const githubHits = await provider.github(testCtx, 'nothing');
    expect(githubHits).toEqual([]);
  });
});
