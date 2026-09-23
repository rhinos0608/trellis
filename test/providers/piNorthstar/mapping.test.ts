/**
 * Unit tests for pi-northstar mapping (P1 scope). No binary required.
 */

import { describe, it, expect } from 'vitest';
import {
  mapSearch,
  mapRead,
  mapCrawl,
  mapAcademic,
  mapGithub,
  unwrapDetails,
  extractDetailsArray,
  toResearchHits,
  toReadResult,
  toCrawlResults,
  toGitHubHits,
} from '../../../src/providers/piNorthstar/mapping.js';

// Fixture: pi-northstar.result v1 ok envelope for web_search.
function webSearchEnvelope() {
  return {
    data: {
      content: [{ type: 'text', text: '## 1. Example\nhttps://example.com/\nSnippet' }],
      details: {
        query: 'example',
        results: [
          {
            title: 'Example',
            url: 'https://example.com/',
            snippet: 'Snippet text',
            source: 'serper',
          },
          // Unsafe URL must be dropped by mapping.
          { title: 'Bad', url: 'javascript:alert(1)', snippet: 'x' },
          // Missing title must be skipped.
          { url: 'https://example.com/no-title' },
        ],
      },
    },
  };
}

describe('tool call builders', () => {
  it('mapSearch targets web_search with recency (not freshness)', () => {
    expect(mapSearch('q')).toEqual({ name: 'web_search', args: { query: 'q' } });
    expect(mapSearch('q', { limit: 5, freshness: 'week' })).toEqual({
      name: 'web_search',
      args: { query: 'q', limit: 5, recency: 'week' },
    });
    // 'all' means no recency filter.
    expect(mapSearch('q', { freshness: 'all' })).toEqual({
      name: 'web_search',
      args: { query: 'q' },
    });
  });

  it('mapRead/mapCrawl target fetch and reject unsafe URLs', () => {
    expect(mapRead('https://example.com/')).toEqual({
      name: 'fetch',
      args: { url: 'https://example.com/' },
    });
    expect(mapCrawl('https://example.com/', { maxPages: 3 })).toEqual({
      name: 'fetch',
      args: { url: 'https://example.com/', maxPages: 3 },
    });
    expect(() => mapRead('javascript:alert(1)')).toThrow();
    expect(() => mapCrawl('http://localhost/x')).toThrow();
  });

  it('mapRead/mapCrawl policy failures never surface the raw URL (PERMANENT)', () => {
    const nasty = 'https://example.com/secret-path?token=abc123';
    for (const fn of [
      // Unparseable: old `Invalid URL: <raw>` message would echo the input.
      () => mapRead('::::' + nasty),
      () => mapCrawl('http://localhost/' + nasty),
      () => mapRead('ftp://example.com/' + nasty),
    ]) {
      try {
        fn();
        expect.unreachable();
      } catch (err: unknown) {
        expect(err instanceof Error && err.message).not.toContain(nasty);
        expect(err instanceof Error && err.message).toBe('URL failed fetch policy');
        expect((err as Record<string, unknown>).classification).toBe('PERMANENT');
      }
    }
    // Safe URL still passes through untouched.
    expect(mapRead(nasty)).toEqual({ name: 'fetch', args: { url: nasty } });
  });

  it('mapAcademic targets research/academic', () => {
    expect(mapAcademic('q', { source: 'arxiv', limit: 4, yearFrom: 2020 })).toEqual({
      name: 'research',
      args: { action: 'academic', query: 'q', source: 'arxiv', limit: 4, yearFrom: 2020 },
    });
  });

  it('mapGithub targets github/search', () => {
    expect(mapGithub('q', { limit: 7 })).toEqual({
      name: 'github',
      args: { action: 'search', query: 'q', limit: 7 },
    });
  });
});

describe('unwrapDetails', () => {
  it('unwraps ok envelope to details + content', () => {
    const out = unwrapDetails(webSearchEnvelope());
    expect(out.content).toHaveLength(1);
    expect(out.details).toMatchObject({ query: 'example' });
  });

  it('degrades to undefined details on partial shapes', () => {
    expect(unwrapDetails(undefined)).toEqual({ details: undefined, content: [] });
    expect(unwrapDetails(null)).toEqual({ details: undefined, content: [] });
    expect(unwrapDetails({ data: null })).toEqual({ details: undefined, content: [] });
    expect(unwrapDetails({ data: { content: [] } })).toEqual({ details: undefined, content: [] });
  });

  it('extractDetailsArray handles results/entities/pages/array', () => {
    expect(extractDetailsArray([{ a: 1 }])).toHaveLength(1);
    expect(extractDetailsArray({ results: [1, 2] })).toHaveLength(2);
    expect(extractDetailsArray({ entities: [1] })).toHaveLength(1);
    expect(extractDetailsArray({ pages: [1, 2, 3] })).toHaveLength(3);
    expect(extractDetailsArray({ nope: true })).toEqual([]);
    expect(extractDetailsArray(undefined)).toEqual([]);
  });
});

describe('toResearchHits', () => {
  it('maps ok fixture, drops unsafe URL and title-less entry', () => {
    const hits = toResearchHits(unwrapDetails(webSearchEnvelope()).details);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      url: 'https://example.com/',
      title: 'Example',
      snippet: 'Snippet text',
      domain: 'serper',
    });
  });

  it('maps entities shape and preserves Pi markers verbatim', () => {
    const hits = toResearchHits({
      entities: [
        {
          title: 'Hit [pi-marker:abc]',
          url: 'https://example.com/a',
          snippet: 'northstar:pi-northstar.result v1 ok',
          backend: 'github-api',
        },
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain('pi-northstar.result');
    expect(hits[0]?.domain).toBe('github-api');
  });

  it('caps arrays at 100 and titles at 2 KiB', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      title: `t${String(i)}`,
      url: `https://example.com/${String(i)}`,
    }));
    const hits = toResearchHits({ results: many });
    expect(hits).toHaveLength(100);
    const long = toResearchHits({
      results: [{ title: 'x'.repeat(5000), url: 'https://example.com/' }],
    });
    expect(long[0]?.title.length).toBeLessThanOrEqual(2049);
    expect(long[0]?.title.endsWith('…')).toBe(true);
  });

  it('returns [] for empty/degraded details', () => {
    expect(toResearchHits(undefined)).toEqual([]);
    expect(toResearchHits({ results: [] })).toEqual([]);
  });
});

describe('toReadResult', () => {
  it('maps fetch details', () => {
    const r = toReadResult(
      { url: 'https://example.com/', title: 'T', content: 'hello' },
      'https://example.com/',
    );
    expect(r).toMatchObject({ url: 'https://example.com/', title: 'T', content: 'hello' });
    expect(r.contentHash).toMatch(/^djb2:/);
  });

  it('degrades to empty content (never throws)', () => {
    const r = toReadResult(undefined, 'https://example.com/');
    expect(r.content).toBe('');
    expect(toReadResult({}, 'https://example.com/').content).toBe('');
  });
});

describe('toCrawlResults', () => {
  it('wraps single fetch shape as one depth-0 result', () => {
    const out = toCrawlResults(
      { url: 'https://example.com/', title: 'T', content: 'body' },
      'https://example.com/',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ url: 'https://example.com/', depth: 0 });
  });

  it('drops unsafe pages, keeps safe ones', () => {
    const out = toCrawlResults({
      pages: [
        { url: 'http://169.254.169.254/', content: 'meta' },
        { url: 'https://example.com/ok', content: 'fine' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://example.com/ok');
  });

  it('returns [] for empty/degraded details', () => {
    expect(toCrawlResults(undefined)).toEqual([]);
    expect(toCrawlResults({})).toEqual([]);
  });
});

describe('toGitHubHits', () => {
  it('maps entities fixture', () => {
    const out = toGitHubHits({
      entities: [
        {
          title: 'README.md',
          url: 'https://github.com/o/r/blob/abc/README.md',
          path: 'README.md',
          repository: 'o/r',
        },
        { title: 'Bad', url: 'file:///etc/passwd', repository: 'o/evil' },
        { title: 'NoRepo', url: 'https://github.com/x' },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo: 'o/r', path: 'README.md' });
  });

  it('infers repository from current Northstar GitHub entity URLs', () => {
    const out = toGitHubHits({
      entities: [{
        title: 'README.md',
        url: 'https://github.com/o/r/blob/abc/README.md',
        source: 'github',
      }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.repo).toBe('o/r');
  });

  it('returns [] for empty/degraded details', () => {
    expect(toGitHubHits(undefined)).toEqual([]);
  });
});
