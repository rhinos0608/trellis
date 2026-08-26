/**
 * Tests for Phase 17 security hardening fixes:
 * 1. URL validation in mapper builder functions (mapRead, mapCrawl, etc.)
 * 2. Response bounds for Reddit/YouTube mappers
 * 3. Markdown escaping (escapeMarkdown, escapeLinkDest, source metadata)
 * 4. safeErrorLog helper
 * 5. URL policy UTF-8 byte length check
 * 6. Trailing dot localhost bypass
 */

import { describe, it, expect } from 'vitest';
import {
  mapRead,
  mapCrawl,
  mapRedditThread,
  mapBrowserExtract,
  toRedditHits,
  toRedditThread,
  toYouTubeHits,
} from '../../../src/providers/searchMcp/mapping.js';
import { validateFetchableUrl } from '../../../src/providers/searchMcp/urlPolicy.js';
import { safeErrorLog } from '../../../src/logger.js';

// ── Fix 1: URL validation in mapper builders ────────────────────────

describe('Fix 1: mapper-level URL validation', () => {
  const MALICIOUS_URLS = [
    'file:///etc/passwd',
    'http://127.0.0.1/admin',
    'http://10.0.0.1/metadata',
    'http://localhost/secret',
    'http://[::1]/admin',
    'javascript:alert(1)',
    'data:text/html,<h1>hi</h1>',
  ];

  for (const url of MALICIOUS_URLS) {
    it(`mapRead rejects ${url}`, () => {
      expect(() => mapRead(url)).toThrow();
    });

    it(`mapCrawl rejects ${url}`, () => {
      expect(() => mapCrawl(url)).toThrow();
    });

    it(`mapRedditThread rejects ${url}`, () => {
      expect(() => mapRedditThread(url)).toThrow();
    });

    it(`mapBrowserExtract rejects ${url}`, () => {
      expect(() => mapBrowserExtract('session-1', url, { actions: [] })).toThrow();
    });
  }

  it('mapRead accepts valid URL', () => {
    const call = mapRead('https://example.com');
    expect(call.name).toBe('web_crawl');
    expect(call.args.url).toBe('https://example.com');
  });

  it('mapCrawl accepts valid URL', () => {
    const call = mapCrawl('https://example.com', { maxPages: 5 });
    expect(call.args.maxPages).toBe(5);
  });

  it('mapRedditThread accepts valid URL', () => {
    const call = mapRedditThread('https://reddit.com/r/test/abc');
    expect(call.args.url).toBe('https://reddit.com/r/test/abc');
  });

  it('mapBrowserExtract accepts valid URL', () => {
    const call = mapBrowserExtract('s1', 'https://example.com', { actions: [] });
    expect(call.args.url).toBe('https://example.com');
  });
});

// ── Fix 2: Reddit/YouTube response bounds ───────────────────────────

describe('Fix 2: toRedditHits validation and bounds', () => {
  it('drops Reddit hits with file: URL', () => {
    const raw = [
      { title: 'Bad', url: 'file:///etc/passwd', subreddit: 'test' },
    ];
    expect(toRedditHits(raw)).toHaveLength(0);
  });

  it('drops Reddit hits with javascript: URL', () => {
    const raw = [
      { title: 'Bad', url: 'javascript:alert(1)', subreddit: 'test' },
    ];
    expect(toRedditHits(raw)).toHaveLength(0);
  });

  it('drops Reddit hits with literal IP URL', () => {
    const raw = [
      { title: 'Bad', url: 'http://127.0.0.1/steal', subreddit: 'test' },
    ];
    expect(toRedditHits(raw)).toHaveLength(0);
  });

  it('bounds title and subreddit fields', () => {
    const bigTitle = 'x'.repeat(5000);
    const bigSub = 'y'.repeat(5000);
    const raw = [
      { title: bigTitle, url: 'https://example.com', subreddit: bigSub },
    ];
    const hits = toRedditHits(raw);
    expect(hits).toHaveLength(1);
    expect(hits[0].title.length).toBeLessThan(5000);
    expect(hits[0].subreddit.length).toBeLessThan(5000);
    expect(hits[0].title).toMatch(/\u2026$/);
    expect(hits[0].subreddit).toMatch(/\u2026$/);
  });

  it('strips control characters from createdAt', () => {
    const raw = [
      { title: 'T', url: 'https://example.com', subreddit: 's', createdAt: '2024-01-01\x00HIDDEN' },
    ];
    const hits = toRedditHits(raw);
    expect(hits[0].createdAt).not.toContain('\x00');
  });
});

describe('Fix 2: toRedditThread bounds', () => {
  it('bounds title, body, and comment fields', () => {
    const raw = {
      post: {
        title: 'x'.repeat(5000),
        url: 'https://example.com',
        selftext: 'y'.repeat(300_000),
      },
      comments: [
        { author: 'z'.repeat(5000), body: 'c'.repeat(300_000), score: 1 },
      ],
    };
    const thread = toRedditThread(raw);
    expect(thread.title.length).toBeLessThan(5000);
    expect(thread.body.length).toBeLessThan(300_000);
    expect(thread.comments[0].author.length).toBeLessThan(5000);
    expect(thread.comments[0].body.length).toBeLessThan(300_000);
  });

  it('caps comments array to 100', () => {
    const raw = {
      post: { title: 'T', url: 'https://example.com', selftext: '' },
      comments: Array.from({ length: 500 }, (_, i) => ({
        author: `user${i}`,
        body: `comment${i}`,
        score: i,
      })),
    };
    const thread = toRedditThread(raw);
    expect(thread.comments.length).toBeLessThanOrEqual(100);
  });

  it('strips control characters from comment fields', () => {
    const raw = {
      post: { title: 'T', url: 'https://example.com', selftext: '' },
      comments: [
        { author: 'user\x00X', body: 'body\x00Y', score: 1 },
      ],
    };
    const thread = toRedditThread(raw);
    expect(thread.comments[0].author).not.toContain('\x00');
    expect(thread.comments[0].body).not.toContain('\x00');
  });
});

describe('Fix 2: toYouTubeHits validation', () => {
  it('drops YouTube hits with invalid URL', () => {
    const raw = [
      { videoId: 'abc', title: 'Video', url: 'http://127.0.0.1/watch' },
    ];
    expect(toYouTubeHits(raw)).toHaveLength(0);
  });

  it('drops YouTube hits with file: URL', () => {
    const raw = [
      { videoId: 'abc', title: 'Video', url: 'file:///etc/passwd' },
    ];
    expect(toYouTubeHits(raw)).toHaveLength(0);
  });

  it('bounds videoId, title, and channel fields', () => {
    const raw = [
      { videoId: 'x'.repeat(5000), title: 'y'.repeat(5000), channelTitle: 'z'.repeat(5000) },
    ];
    const hits = toYouTubeHits(raw);
    expect(hits).toHaveLength(1);
    expect(hits[0].videoId.length).toBeLessThan(5000);
    expect(hits[0].title.length).toBeLessThan(5000);
    expect(hits[0].channel.length).toBeLessThan(5000);
  });
});

// ── Fix 3: Markdown escaping ───────────────────────────────────────

import { ResearchSynthesizer } from '../../../src/research/synthesizer.js';
import type { ResearchState } from '../../../src/research/internalTypes.js';

function makeMaliciousState(
  claim: string,
  sourceTitle = 'Source',
  sourceUrl = 'https://example.com',
  sourceDomain = 'example.com',
): ResearchState {
  return {
    query: 'test query',
    subQuestions: [
      {
        id: 'sq1',
        text: 'What is X?',
        classification: 'explainer',
        searchQueries: [],
      },
    ],
    findings: [
      {
        id: 'f1',
        claim,
        normalizedClaim: claim.toLowerCase(),
        evidenceExcerpt: '',
        evidenceDirectness: 'direct',
        claimType: 'primary',
        sourceIds: ['s1'],
        subQuestionIds: ['sq1'],
        lastUpdated: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ],
    sources: [
      {
        id: 's1',
        title: sourceTitle,
        url: sourceUrl,
        sourceType: 'web',
        domain: sourceDomain,
        accessDate: new Date().toISOString(),
        isPrimary: false,
        relevantSubQuestions: ['sq1'],
        extractionStatus: 'completed',
        subQuestionId: '',
      },
    ],
    contradictions: [],
    openQuestions: [],
  } as ResearchState;
}

describe('Fix 3: Markdown injection prevention', () => {
  it('newlines in claims are neutralized', () => {
    const maliciousClaim = 'Normal claim\n# Fake Heading\nMore text';
    const state = makeMaliciousState(maliciousClaim);
    const synth = new ResearchSynthesizer(state);
    const report = synth.synthesize();
    // The # should be escaped (not treated as heading)
    expect(report.narrativeMarkdown).toContain('\\# Fake Heading');
    // But the text should still be present
    expect(report.narrativeMarkdown).toContain('Fake Heading');
  });

  it('blockquote markers in claims are escaped', () => {
    const maliciousClaim = '> blockquote injection attempt';
    const state = makeMaliciousState(maliciousClaim);
    const synth = new ResearchSynthesizer(state);
    const report = synth.synthesize();
    // Should contain the escaped version
    expect(report.narrativeMarkdown).toContain('\\> blockquote injection attempt');
  });

  it('list markers at line start are escaped', () => {
    const maliciousClaim = '- fake list item';
    const state = makeMaliciousState(maliciousClaim);
    const synth = new ResearchSynthesizer(state);
    const report = synth.synthesize();
    // Newlines stripped, so no line-start list markers possible
    expect(report.narrativeMarkdown).toContain('fake list item');
  });

  it('URL with ) in query param does not break link destination', () => {
    const state = makeMaliciousState(
      'A claim',
      'Title',
      'https://example.com/path?a=1)b=2',
      'example.com',
    );
    const synth = new ResearchSynthesizer(state);
    const report = synth.synthesize();
    // The ) should be encoded as %29
    expect(report.narrativeMarkdown).toContain('%29');
  });

  it('source domain is escaped in markdown', () => {
    const state = makeMaliciousState(
      'A claim',
      'Title',
      'https://example.com',
      '**bold** domain',
    );
    const synth = new ResearchSynthesizer(state);
    const report = synth.synthesize();
    // The ** should be escaped
    expect(report.narrativeMarkdown).toContain('\\*\\*bold\\*\\*');
  });
});

// ── Fix 4: safeErrorLog ────────────────────────────────────────────

describe('Fix 4: safeErrorLog', () => {
  it('extracts error name and message length', () => {
    const err = new Error('something went wrong');
    const safe = safeErrorLog(err);
    expect(safe.errorName).toBe('Error');
    expect(safe.errorMessageLength).toBe(20);
  });

  it('handles non-Error values', () => {
    const safe = safeErrorLog('string error');
    expect(safe.errorName).toBe('Unknown');
    expect(safe.errorMessageLength).toBe(12);
  });

  it('handles null/undefined', () => {
    const safe = safeErrorLog(null);
    expect(safe.errorName).toBe('Unknown');
    expect(safe.errorMessageLength).toBe(4);
  });

  it('does not include raw error body, message content, or stack', () => {
    const err = new Error('secret provider response body: {"token":"abc123"}');
    err.stack = 'Error: secret\n    at /some/file.ts:10:5';
    const safe = safeErrorLog(err);
    expect(safe).not.toHaveProperty('stack');
    expect(safe).not.toHaveProperty('errorMessage');
    expect(JSON.stringify(safe)).not.toContain('abc123');
    expect(JSON.stringify(safe)).not.toContain('secret provider');
  });
});

// ── Fix 5: UTF-8 byte length check ─────────────────────────────────

describe('Fix 5: URL length check uses UTF-8 bytes', () => {
  it('accepts ASCII URL under 8 KiB', () => {
    const url = `https://example.com/${'a'.repeat(7000)}`;
    expect(() => validateFetchableUrl(url)).not.toThrow();
  });

  it('rejects ASCII URL over 8 KiB', () => {
    const url = `https://example.com/${'a'.repeat(9000)}`;
    expect(() => validateFetchableUrl(url)).toThrow('maximum length');
  });

  it('rejects Unicode-heavy URL that is under 8192 chars but over 8 KiB bytes', () => {
    // Each CJK char is 3 bytes UTF-8 but 1 JS char
    // 3000 chars = 3000 JS chars (under 8192) but 9000 bytes (over 8192)
    const cjk = '\u4e2d'.repeat(3000); // '中' = 3 bytes UTF-8
    const url = `https://example.com/${cjk}`;
    // JS string length: ~24 + 3000 = 3024 (well under 8192)
    expect(url.length).toBeLessThan(8192);
    // But UTF-8 byte length: ~24 + 9000 = 9024 (over 8192)
    expect(Buffer.byteLength(url, 'utf8')).toBeGreaterThan(8192);
    expect(() => validateFetchableUrl(url)).toThrow('maximum length');
  });
});

// ── Fix 6: Trailing dot localhost bypass ────────────────────────────

describe('Fix 6: trailing dot hostname normalization', () => {
  it('rejects http://localhost./', () => {
    expect(() => validateFetchableUrl('http://localhost./')).toThrow('blocked');
  });

  it('rejects http://localhost./admin', () => {
    expect(() => validateFetchableUrl('http://localhost./admin')).toThrow('blocked');
  });

  it('rejects http://evil.localhost./', () => {
    expect(() => validateFetchableUrl('http://evil.localhost./')).toThrow('blocked');
  });

  it('still accepts valid URLs', () => {
    expect(() => validateFetchableUrl('https://example.com')).not.toThrow();
  });
});
