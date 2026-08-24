/**
 * Unit tests for search-mcp mapping functions.
 *
 * Tests the pure mapping logic: tool call builders, capability mapping,
 * and response extractors. No MCP server required.
 */

import { describe, it, expect } from 'vitest';
import {
  mapCapabilities,
  mapSearch,
  mapRead,
  mapCrawl,
  mapAcademic,
  mapGithub,
  mapReddit,
  mapRedditThread,
  mapHackernews,
  mapStackoverflow,
  mapYoutube,
  mapYoutubeTranscript,
  mapWikipedia,
  mapBrowserOpen,
  mapBrowserExtract,
  mapBrowserClose,
  extractDataArray,
  toResearchHits,
  toReadResult,
  toCrawlResults,
  toGitHubHits,
  toRedditHits,
  toRedditThread,
  toYouTubeHits,
  toTranscriptSegments,
} from '../../../src/providers/searchMcp/mapping.js';

// ── Capability mapping ───────────────────────────────────────────────

describe('mapCapabilities', () => {
  it('maps full search-mcp tool set', () => {
    const caps = mapCapabilities([
      'web_search', 'web_crawl', 'research', 'github',
      'reddit', 'youtube', 'browser', 'semantic_crawl',
    ]);
    expect(caps.search).toBe(true);
    expect(caps.read).toBe(true);
    expect(caps.academic).toBe(true);
    expect(caps.code).toBe(true);
    expect(caps.community.reddit).toBe(true);
    expect(caps.community.hackernews).toBe(true);
    expect(caps.community.stackoverflow).toBe(true);
    expect(caps.media).toBe(true);
    expect(caps.reference).toBe(true);
    expect(caps.browser).toBe(true);
    expect(caps.academicBackends).toContain('arxiv');
  });

  it('handles minimal tool set', () => {
    const caps = mapCapabilities(['web_search']);
    expect(caps.search).toBe(true);
    expect(caps.read).toBe(false);
    expect(caps.academic).toBe(false);
    expect(caps.code).toBe(false);
    expect(caps.community.reddit).toBe(false);
    expect(caps.academicBackends).toBeUndefined();
  });

  it('returns empty capabilities for no tools', () => {
    const caps = mapCapabilities([]);
    expect(caps.search).toBe(false);
    expect(caps.browser).toBe(false);
  });
});

// ── Tool call builders ───────────────────────────────────────────────

describe('mapSearch', () => {
  it('builds web_search call with query', () => {
    const call = mapSearch('machine learning');
    expect(call.name).toBe('web_search');
    expect(call.args.query).toBe('machine learning');
  });

  it('includes limit and freshness when provided', () => {
    const call = mapSearch('test', { limit: 5, freshness: 'week' });
    expect(call.args.limit).toBe(5);
    expect(call.args.freshness).toBe('week');
  });

  it('omits undefined opts', () => {
    const call = mapSearch('test');
    expect(call.args).not.toHaveProperty('limit');
    expect(call.args).not.toHaveProperty('freshness');
  });
});

describe('mapRead', () => {
  it('builds web_crawl call for single page', () => {
    const call = mapRead('https://example.com');
    expect(call.name).toBe('web_crawl');
    expect(call.args.url).toBe('https://example.com');
    expect(call.args.maxDepth).toBe(1);
    expect(call.args.maxPages).toBe(1);
  });
});

describe('mapCrawl', () => {
  it('builds web_crawl call with maxPages', () => {
    const call = mapCrawl('https://example.com', { maxPages: 10 });
    expect(call.name).toBe('web_crawl');
    expect(call.args.maxPages).toBe(10);
  });
});

describe('mapAcademic', () => {
  it('builds research.academic call', () => {
    const call = mapAcademic('quantum computing', { source: 'arxiv', limit: 10 });
    expect(call.name).toBe('research');
    expect(call.args.action).toBe('academic');
    expect(call.args.query).toBe('quantum computing');
    expect(call.args.source).toBe('arxiv');
    expect(call.args.limit).toBe(10);
  });
});

describe('mapGithub', () => {
  it('builds github.search call', () => {
    const call = mapGithub('react hooks', { limit: 20 });
    expect(call.name).toBe('github');
    expect(call.args.action).toBe('search');
    expect(call.args.query).toBe('react hooks');
    expect(call.args.limit).toBe(20);
  });
});

describe('mapReddit', () => {
  it('builds reddit.search call with subreddit', () => {
    const call = mapReddit('best frameworks', { subreddit: 'javascript' });
    expect(call.name).toBe('reddit');
    expect(call.args.action).toBe('search');
    expect(call.args.subreddit).toBe('javascript');
  });

  it('defaults to all subreddit', () => {
    const call = mapReddit('test');
    expect(call.args.subreddit).toBe('all');
  });
});

describe('mapRedditThread', () => {
  it('builds reddit.comments call', () => {
    const call = mapRedditThread('https://reddit.com/r/test/abc123');
    expect(call.name).toBe('reddit');
    expect(call.args.action).toBe('comments');
    expect(call.args.url).toBe('https://reddit.com/r/test/abc123');
  });
});

describe('mapHackernews', () => {
  it('builds research.hackernews call', () => {
    const call = mapHackernews('rust async');
    expect(call.name).toBe('research');
    expect(call.args.action).toBe('hackernews');
  });
});

describe('mapStackoverflow', () => {
  it('builds research.stackoverflow call', () => {
    const call = mapStackoverflow('typescript generics');
    expect(call.name).toBe('research');
    expect(call.args.action).toBe('stackoverflow');
  });
});

describe('mapYoutube', () => {
  it('builds youtube.search call', () => {
    const call = mapYoutube('node.js tutorial', { limit: 5 });
    expect(call.name).toBe('youtube');
    expect(call.args.action).toBe('search');
    expect(call.args.maxResults).toBe(5);
  });
});

describe('mapYoutubeTranscript', () => {
  it('builds youtube.transcript call', () => {
    const call = mapYoutubeTranscript('dQw4w9WgXcQ', 'en');
    expect(call.name).toBe('youtube');
    expect(call.args.action).toBe('transcript');
    expect(call.args.videoId).toBe('dQw4w9WgXcQ');
    expect(call.args.language).toBe('en');
  });

  it('omits language when undefined', () => {
    const call = mapYoutubeTranscript('abc123');
    expect(call.args).not.toHaveProperty('language');
  });
});

describe('mapWikipedia', () => {
  it('builds research.wikipedia call', () => {
    const call = mapWikipedia('quantum mechanics', { language: 'de' });
    expect(call.name).toBe('research');
    expect(call.args.action).toBe('wikipedia');
    expect(call.args.language).toBe('de');
  });
});

describe('mapBrowserOpen', () => {
  it('builds browser.session start call', () => {
    const call = mapBrowserOpen({ headless: true });
    expect(call.name).toBe('browser');
    expect(call.args.action).toBe('session');
    expect(call.args.op).toBe('start');
    expect(call.args.headless).toBe(true);
  });
});

describe('mapBrowserClose', () => {
  it('builds browser.session close call', () => {
    const call = mapBrowserClose('session-123');
    expect(call.name).toBe('browser');
    expect(call.args.action).toBe('session');
    expect(call.args.op).toBe('close');
  });
});

describe('mapBrowserExtract', () => {
  it('builds browser.navigate call', () => {
    const call = mapBrowserExtract('s1', 'https://example.com', { actions: [] });
    expect(call.name).toBe('browser');
    expect(call.args.action).toBe('navigate');
    expect(call.args.url).toBe('https://example.com');
  });
});

// ── Response extractors ──────────────────────────────────────────────

describe('extractDataArray', () => {
  it('returns array directly', () => {
    expect(extractDataArray([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('extracts from results field', () => {
    expect(extractDataArray({ results: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('extracts from papers field', () => {
    expect(extractDataArray({ papers: [{ title: 'test' }] })).toEqual([{ title: 'test' }]);
  });

  it('extracts from items field', () => {
    expect(extractDataArray({ items: [1] })).toEqual([1]);
  });

  it('returns empty for non-object', () => {
    expect(extractDataArray(null)).toEqual([]);
    expect(extractDataArray('string')).toEqual([]);
    expect(extractDataArray(42)).toEqual([]);
  });

  it('returns empty when no array field found', () => {
    expect(extractDataArray({ foo: 'bar' })).toEqual([]);
  });
});

describe('toResearchHits', () => {
  it('maps array of objects to ResearchHit[]', () => {
    const raw = [
      { url: 'https://example.com', title: 'Example', snippet: 'A test page' },
      { url: 'https://test.com', title: 'Test', domain: 'test.com' },
    ];
    const hits = toResearchHits(raw);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: 'https://example.com',
      title: 'Example',
      snippet: 'A test page',
    });
    expect(hits[1].domain).toBe('test.com');
  });

  it('handles link field as url fallback', () => {
    const raw = [{ link: 'https://fallback.com', title: 'Fallback' }];
    const hits = toResearchHits(raw);
    expect(hits[0].url).toBe('https://fallback.com');
  });

  it('handles abstract as snippet fallback', () => {
    const raw = [{ url: 'https://a.com', title: 'A', abstract: 'Paper abstract' }];
    const hits = toResearchHits(raw);
    expect(hits[0].snippet).toBe('Paper abstract');
  });

  it('skips items without url or title', () => {
    const raw = [
      { url: 'https://a.com' },         // missing title
      { title: 'B' },                    // missing url
      { url: 'https://c.com', title: 'C' }, // valid
    ];
    expect(toResearchHits(raw)).toHaveLength(1);
  });

  it('returns empty for non-array', () => {
    expect(toResearchHits(null)).toEqual([]);
    expect(toResearchHits('string')).toEqual([]);
  });

  it('extracts from wrapper object', () => {
    const raw = { results: [{ url: 'https://a.com', title: 'A' }] };
    expect(toResearchHits(raw)).toHaveLength(1);
  });
});

describe('toReadResult', () => {
  it('extracts content from web_crawl pages', () => {
    const raw = {
      pages: [{ url: 'https://example.com', content: '# Hello', title: 'Hello' }],
    };
    const result = toReadResult(raw, 'https://example.com');
    expect(result.url).toBe('https://example.com');
    expect(result.content).toBe('# Hello');
    expect(result.title).toBe('Hello');
    expect(result.contentHash).toMatch(/^djb2:/);
  });

  it('handles direct content field', () => {
    const raw = { content: 'Plain text', title: 'Page' };
    const result = toReadResult(raw, 'https://test.com');
    expect(result.content).toBe('Plain text');
  });

  it('returns empty content for null', () => {
    const result = toReadResult(null, 'https://test.com');
    expect(result.content).toBe('');
    expect(result.contentHash).toMatch(/^djb2:/);
  });
});

describe('toCrawlResults', () => {
  it('maps pages array to CrawlResult[]', () => {
    const raw = {
      pages: [
        { url: 'https://a.com', content: 'Page A', title: 'A', depth: 0 },
        { url: 'https://b.com', content: 'Page B', depth: 1 },
      ],
    };
    const results = toCrawlResults(raw);
    expect(results).toHaveLength(2);
    expect(results[0].depth).toBe(0);
    expect(results[1].depth).toBe(1);
  });

  it('skips pages without url or content', () => {
    const raw = { pages: [{ url: 'https://a.com' }, { content: 'no url' }] };
    expect(toCrawlResults(raw)).toHaveLength(0);
  });
});

describe('toGitHubHits', () => {
  it('maps github search items', () => {
    const raw = {
      items: [
        { full_name: 'user/repo', html_url: 'https://github.com/user/repo', description: 'A repo', stargazers_count: 100 },
      ],
    };
    const hits = toGitHubHits(raw);
    expect(hits).toHaveLength(1);
    expect(hits[0].repo).toBe('user/repo');
    expect(hits[0].stars).toBe(100);
  });

  it('handles direct array', () => {
    const raw = [{ full_name: 'x/y', html_url: 'https://github.com/x/y' }];
    expect(toGitHubHits(raw)).toHaveLength(1);
  });
});

describe('toRedditHits', () => {
  it('maps reddit search results', () => {
    const raw = [
      { title: 'Post', url: 'https://reddit.com/...', subreddit: 'test', score: 42, num_comments: 5 },
    ];
    const hits = toRedditHits(raw);
    expect(hits).toHaveLength(1);
    expect(hits[0].subreddit).toBe('test');
    expect(hits[0].numComments).toBe(5);
  });
});

describe('toRedditThread', () => {
  it('maps reddit comments response', () => {
    const raw = {
      post: { title: 'Thread', url: 'https://reddit.com/...', selftext: 'Body text' },
      comments: [
        { author: 'user1', body: 'Comment 1', score: 10 },
        { author: 'user2', body: 'Comment 2', score: 5 },
      ],
    };
    const thread = toRedditThread(raw);
    expect(thread.title).toBe('Thread');
    expect(thread.body).toBe('Body text');
    expect(thread.comments).toHaveLength(2);
    expect(thread.comments[0].author).toBe('user1');
  });

  it('returns empty thread for null', () => {
    const thread = toRedditThread(null);
    expect(thread.title).toBe('');
    expect(thread.comments).toEqual([]);
  });
});

describe('toYouTubeHits', () => {
  it('maps youtube search results', () => {
    const raw = [
      { videoId: 'abc123', title: 'Video', channelTitle: 'Channel', publishedAt: '2024-01-01' },
    ];
    const hits = toYouTubeHits(raw);
    expect(hits).toHaveLength(1);
    expect(hits[0].videoId).toBe('abc123');
    expect(hits[0].channel).toBe('Channel');
    expect(hits[0].url).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('handles nested id.videoId', () => {
    const raw = [{ id: { videoId: 'nested' }, title: 'Nested' }];
    const hits = toYouTubeHits(raw);
    expect(hits[0].videoId).toBe('nested');
  });
});

describe('toTranscriptSegments', () => {
  it('maps transcript segments', () => {
    const raw = [
      { text: 'Hello', start: 0, duration: 2.5 },
      { text: 'World', start: 2.5, duration: 1.5 },
    ];
    const segments = toTranscriptSegments(raw);
    expect(segments).toHaveLength(2);
    expect(segments[0].text).toBe('Hello');
    expect(segments[1].start).toBe(2.5);
  });

  it('returns empty for non-array', () => {
    expect(toTranscriptSegments(null)).toEqual([]);
    expect(toTranscriptSegments('string')).toEqual([]);
  });

  it('skips segments without text', () => {
    const raw = [{ start: 0, duration: 1 }, { text: 'OK', start: 1, duration: 1 }];
    expect(toTranscriptSegments(raw)).toHaveLength(1);
  });
});
