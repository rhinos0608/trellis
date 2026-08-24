/**
 * Pure mapping functions: translate ResearchProvider method calls into
 * MCP tool name + action + args that search-mcp actually expects,
 * and translate its responses back into the types.ts shapes.
 *
 * Each function takes parsed MCP tool result data and returns the
 * corresponding ResearchProvider return type. Returns [] / empty for
 * unmappable responses rather than throwing.
 */

import type {
  ResearchCapabilities,
  SearchOpts,
  ResearchHit,
  ReadResult,
  CrawlResult,
  AcademicOpts,
  GitHubHit,
  CommunityOpts,
  RedditHit,
  RedditThread,
  MediaOpts,
  YouTubeHit,
  TranscriptSegment,
  BrowserExtractPlan,
} from '../types.js';

// ── MCP tool call shape ──────────────────────────────────────────────

export interface McpToolCall {
  name: string;
  args: Record<string, unknown>;
}

// ── Capability mapping ───────────────────────────────────────────────

/**
 * Build capabilities from a list of discovered MCP tool names.
 */
export function mapCapabilities(
  mcpToolNames: string[],
): ResearchCapabilities {
  const names = new Set(mcpToolNames);
  const caps: ResearchCapabilities = {
    search: names.has('web_search'),
    read: names.has('web_crawl'),
    academic: names.has('research'),
    code: names.has('github'),
    community: {
      reddit: names.has('reddit'),
      hackernews: names.has('research'),
      stackoverflow: names.has('research'),
    },
    media: names.has('youtube'),
    reference: names.has('research'),
    browser: names.has('browser'),
  };
  if (names.has('research')) {
    caps.academicBackends = [
      'arxiv', 'semantic_scholar', 'openalex', 'crossref',
      'pubmed', 'wikipedia', 'hackernews', 'stackoverflow',
      'datacite', 'ror', 'gdelt', 'wikidata',
    ];
  }
  return caps;
}

// ── Tool call builders ───────────────────────────────────────────────

export function mapSearch(
  query: string,
  opts?: SearchOpts,
): McpToolCall {
  const args: Record<string, unknown> = { query };
  if (opts?.limit !== undefined) args.limit = opts.limit;
  if (opts?.freshness !== undefined) args.freshness = opts.freshness;
  return { name: 'web_search', args };
}

export function mapRead(url: string): McpToolCall {
  return { name: 'web_crawl', args: { url, maxDepth: 1, maxPages: 1 } };
}

export function mapCrawl(
  url: string,
  opts?: { maxPages?: number },
): McpToolCall {
  const args: Record<string, unknown> = { url };
  if (opts?.maxPages !== undefined) args.maxPages = opts.maxPages;
  return { name: 'web_crawl', args };
}

export function mapAcademic(
  query: string,
  opts?: AcademicOpts,
): McpToolCall {
  const args: Record<string, unknown> = { action: 'academic', query };
  if (opts?.source !== undefined) args.source = opts.source;
  if (opts?.limit !== undefined) args.limit = opts.limit;
  if (opts?.yearFrom !== undefined) args.yearFrom = opts.yearFrom;
  return { name: 'research', args };
}

export function mapGithub(
  query: string,
  opts?: SearchOpts,
): McpToolCall {
  const args: Record<string, unknown> = { action: 'search', query };
  if (opts?.limit !== undefined) args.limit = opts.limit;
  return { name: 'github', args };
}

export function mapReddit(
  query: string,
  opts?: CommunityOpts,
): McpToolCall {
  return {
    name: 'reddit',
    args: {
      action: 'search',
      query,
      subreddit: opts?.subreddit ?? 'all',
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    },
  };
}

export function mapRedditThread(
  url: string,
  _opts?: { limit?: number },
): McpToolCall {
  return { name: 'reddit', args: { action: 'comments', url } };
}

export function mapHackernews(
  query: string,
  opts?: SearchOpts,
): McpToolCall {
  const args: Record<string, unknown> = { action: 'hackernews', query };
  if (opts?.limit !== undefined) args.limit = opts.limit;
  return { name: 'research', args };
}

export function mapStackoverflow(
  query: string,
  opts?: SearchOpts,
): McpToolCall {
  const args: Record<string, unknown> = { action: 'stackoverflow', query };
  if (opts?.limit !== undefined) args.limit = opts.limit;
  return { name: 'research', args };
}

export function mapYoutube(
  query: string,
  opts?: MediaOpts,
): McpToolCall {
  const args: Record<string, unknown> = { action: 'search', query };
  if (opts?.limit !== undefined) args.maxResults = opts.limit;
  return { name: 'youtube', args };
}

export function mapYoutubeTranscript(
  videoId: string,
  language?: string,
): McpToolCall {
  const args: Record<string, unknown> = { action: 'transcript', videoId };
  if (language !== undefined) args.language = language;
  return { name: 'youtube', args };
}

export function mapWikipedia(
  query: string,
  opts?: { language?: string },
): McpToolCall {
  const args: Record<string, unknown> = { action: 'wikipedia', query };
  if (opts?.language !== undefined) args.language = opts.language;
  return { name: 'research', args };
}

export function mapBrowserOpen(
  opts?: Record<string, unknown>,
): McpToolCall {
  return {
    name: 'browser',
    args: { action: 'session', op: 'start', ...(opts ?? {}) },
  };
}

export function mapBrowserExtract(
  _sessionId: string,
  url: string,
  _plan: BrowserExtractPlan,
): McpToolCall {
  return { name: 'browser', args: { action: 'navigate', url } };
}

export function mapBrowserClose(sessionId: string): McpToolCall {
  return {
    name: 'browser',
    args: { action: 'session', op: 'close', profile: sessionId },
  };
}

// ── Response extractors ──────────────────────────────────────────────

/**
 * Extract the actual result data from an MCP tool call response.
 *
 * search-mcp's response pipeline wraps data with makeResult():
 * { tool, data: <actual>, duration, meta }
 *
 * Handler return shapes vary:
 * - research actions: direct array (wikipedia) or { papers: [...] } (academic)
 * - web_search: { query, results: [...], ... }
 * - web_crawl: { pages: [...], ... }
 * - github search: { items: [...] } or direct array
 * - youtube search: direct array
 */
export function extractDataArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;

  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;

    for (const key of [
      'results',
      'items',
      'papers',
      'pages',
      'videos',
      'repositories',
      'posts',
      'comments',
    ]) {
      const val = obj[key];
      if (Array.isArray(val)) return val;
    }
  }

  return [];
}

// ── Response mappers ─────────────────────────────────────────────────

export function toResearchHits(raw: unknown): ResearchHit[] {
  return extractDataArray(raw)
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const url = typeof r.url === 'string'
        ? r.url
        : typeof r.link === 'string'
          ? r.link
          : undefined;
      const title = typeof r.title === 'string' ? r.title : undefined;
      if (!url || !title) return null;
      const hit: ResearchHit = { url, title };
      const snippet = typeof r.snippet === 'string'
        ? r.snippet
        : typeof r.abstract === 'string'
          ? r.abstract
          : typeof r.description === 'string'
            ? r.description
            : undefined;
      if (snippet !== undefined) hit.snippet = snippet;
      const pub = typeof r.publishedAt === 'string'
        ? r.publishedAt
        : typeof r.published === 'string'
          ? r.published
          : typeof r.date === 'string'
            ? r.date
            : undefined;
      if (pub !== undefined) hit.publishedAt = pub;
      const domain = typeof r.domain === 'string'
        ? r.domain
        : typeof r.source === 'string'
          ? r.source
          : typeof r.hostname === 'string'
            ? r.hostname
            : undefined;
      if (domain !== undefined) hit.domain = domain;
      return hit;
    })
    .filter((h): h is ResearchHit => h !== null);
}

export function toReadResult(raw: unknown, url: string): ReadResult {
  let content = '';
  let title: string | undefined;
  let publishedAt: string | undefined;

  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // web_crawl returns { pages: [{ url, content, title, ... }] }
    const pages = obj.pages;
    if (Array.isArray(pages) && pages.length > 0) {
      const page = pages[0] as Record<string, unknown>;
      if (typeof page.content === 'string') content = page.content;
      if (typeof page.title === 'string') title = page.title;
      if (typeof page.published === 'string') publishedAt = page.published;
    }
    // Fallback: direct content/title fields
    if (!content && typeof obj.content === 'string') content = obj.content;
    if (!title && typeof obj.title === 'string') title = obj.title;
  }

  const contentHash = simpleHash(content);

  const result: ReadResult = {
    url,
    content,
    contentHash,
  };
  if (title !== undefined) result.title = title;
  if (publishedAt !== undefined) result.publishedAt = publishedAt;
  return result;
}

export function toCrawlResults(raw: unknown): CrawlResult[] {
  let pages: unknown[] = [];
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.pages)) pages = obj.pages;
    else if (Array.isArray(obj.results)) pages = obj.results;
  }

  return pages
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const p = item as Record<string, unknown>;
      const url = typeof p.url === 'string' ? p.url : undefined;
      const content = typeof p.content === 'string' ? p.content : undefined;
      if (!url || !content) return null;
      const cr: CrawlResult = {
        url,
        content,
        contentHash: simpleHash(content),
        depth: typeof p.depth === 'number' ? p.depth : 0,
      };
      if (typeof p.title === 'string') cr.title = p.title;
      return cr;
    })
    .filter((r): r is CrawlResult => r !== null);
}

export function toGitHubHits(raw: unknown): GitHubHit[] {
  return extractDataArray(raw)
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const repo = typeof r.full_name === 'string'
        ? r.full_name
        : typeof r.repo === 'string'
          ? r.repo
          : undefined;
      const url = typeof r.html_url === 'string'
        ? r.html_url
        : typeof r.url === 'string'
          ? r.url
          : undefined;
      if (!repo || !url) return null;
      const hit: GitHubHit = { repo, url };
      if (typeof r.description === 'string') hit.description = r.description;
      if (typeof r.snippet === 'string') hit.snippet = r.snippet;
      if (typeof r.path === 'string') hit.path = r.path;
      if (typeof r.stargazers_count === 'number') hit.stars = r.stargazers_count;
      else if (typeof r.stars === 'number') hit.stars = r.stars;
      return hit;
    })
    .filter((h): h is GitHubHit => h !== null);
}

export function toRedditHits(raw: unknown): RedditHit[] {
  return extractDataArray(raw)
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const title = typeof r.title === 'string' ? r.title : undefined;
      const url = typeof r.url === 'string' ? r.url : undefined;
      const subreddit = typeof r.subreddit === 'string' ? r.subreddit : undefined;
      if (!title || !url || !subreddit) return null;
      return {
        title,
        url,
        subreddit,
        score: typeof r.score === 'number' ? r.score : 0,
        numComments: typeof r.numComments === 'number'
          ? r.numComments
          : typeof r.num_comments === 'number'
            ? r.num_comments
            : 0,
        createdAt: typeof r.createdAt === 'string'
          ? r.createdAt
          : typeof r.created === 'string'
            ? r.created
            : new Date().toISOString(),
      } satisfies RedditHit;
    })
    .filter((h): h is RedditHit => h !== null);
}

export function toRedditThread(raw: unknown): RedditThread {
  const empty: RedditThread = { title: '', url: '', body: '', comments: [] };
  if (raw === null || typeof raw !== 'object') return empty;
  const r = raw as Record<string, unknown>;

  const post = r.post as Record<string, unknown> | undefined;
  const title = (typeof post?.title === 'string' ? post.title : '') ||
    (typeof r.title === 'string' ? r.title : '');
  const url = (typeof post?.url === 'string' ? post.url : '') ||
    (typeof r.url === 'string' ? r.url : '');
  const body = (typeof post?.selftext === 'string' ? post.selftext : '') ||
    (typeof r.body === 'string' ? r.body : '');

  const rawComments = Array.isArray(r.comments) ? r.comments : [];
  const comments = rawComments
    .filter((c): c is Record<string, unknown> =>
      c !== null && typeof c === 'object')
    .map((c) => ({
      author: typeof c.author === 'string' ? c.author : '[unknown]',
      body: typeof c.body === 'string' ? c.body : '',
      score: typeof c.score === 'number' ? c.score : 0,
    }));

  return { title, url, body, comments };
}

export function toYouTubeHits(raw: unknown): YouTubeHit[] {
  return extractDataArray(raw)
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const v = item as Record<string, unknown>;
      const videoId = typeof v.videoId === 'string'
        ? v.videoId
        : typeof v.id === 'object' && v.id !== null
          ? typeof (v.id as Record<string, unknown>).videoId === 'string'
            ? (v.id as Record<string, unknown>).videoId as string
            : undefined
          : undefined;
      const title = typeof v.title === 'string' ? v.title : undefined;
      if (!videoId || !title) return null;

      const channelTitle = typeof v.channelTitle === 'string'
        ? v.channelTitle
        : typeof v.channel === 'string'
          ? v.channel
          : '';
      const publishedAt = typeof v.publishedAt === 'string'
        ? v.publishedAt
        : typeof v.published === 'string'
          ? v.published
          : new Date().toISOString();

      const hit: YouTubeHit = {
        videoId,
        title,
        channel: channelTitle,
        publishedAt,
        url: typeof v.url === 'string' ? v.url : `https://www.youtube.com/watch?v=${videoId}`,
      };
      return hit;
    })
    .filter((h): h is YouTubeHit => h !== null);
}

export function toTranscriptSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const s = item as Record<string, unknown>;
      const text = typeof s.text === 'string' ? s.text : undefined;
      if (!text) return null;
      return {
        text,
        start: typeof s.start === 'number' ? s.start : 0,
        duration: typeof s.duration === 'number' ? s.duration : 0,
      } satisfies TranscriptSegment;
    })
    .filter((s): s is TranscriptSegment => s !== null);
}

// ── Utility ──────────────────────────────────────────────────────────

/** Simple DJB2 hash for content fingerprinting. Non-crypto, good enough for dedup. */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return `djb2:${(hash >>> 0).toString(16)}`;
}
