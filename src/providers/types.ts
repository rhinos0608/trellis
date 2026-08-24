/**
 * ResearchProvider — the narrow acquisition/provider interface between
 * Trellis's research core and any information-acquisition backend. Search-
 * mcp becomes ONE implementation (an out-of-process MCP client adapter,
 * see providers/search-mcp/), not a special-cased dependency of research
 * core. See docs/ARCHITECTURE.md §5.
 *
 * All return types are plain JSON-serializable objects — no class
 * instances or streams — so a provider backed by a real MCP tool call is a
 * transparent swap for one backed by direct function calls.
 *
 * Owned by Worker 5 (provider abstraction + search-mcp adapter). Consumed
 * by research/ (Worker 6) exclusively through this interface — research
 * core must never import a specific provider's internals directly.
 */

export interface ResearchCapabilities {
  search: boolean;
  read: boolean;
  academic: boolean;
  code: boolean;
  community: { reddit: boolean; hackernews: boolean; stackoverflow: boolean };
  media: boolean;
  reference: boolean;
  browser: boolean;
  academicBackends?: string[];
}

export interface SearchOpts {
  limit?: number;
  freshness?: 'day' | 'week' | 'month' | 'year' | 'all';
}

export interface ResearchHit {
  url: string;
  title: string;
  snippet?: string;
  publishedAt?: string;
  domain?: string;
}

export interface ReadResult {
  url: string;
  title?: string;
  content: string;
  contentHash: string;
  publishedAt?: string;
}

export interface CrawlResult {
  url: string;
  title?: string;
  content: string;
  contentHash: string;
  depth: number;
}

export interface AcademicOpts extends SearchOpts {
  source?: string;
  yearFrom?: number;
  yearTo?: number;
}

export interface GitHubHit {
  repo: string;
  path?: string;
  url: string;
  description?: string;
  snippet?: string;
  stars?: number;
}

export interface CommunityOpts extends SearchOpts {
  subreddit?: string;
}

export interface RedditHit {
  title: string;
  url: string;
  subreddit: string;
  score: number;
  numComments: number;
  createdAt: string;
}

export interface RedditThread {
  title: string;
  url: string;
  body: string;
  comments: { author: string; body: string; score: number }[];
}

export interface MediaOpts extends SearchOpts {
  channel?: string;
}

export interface YouTubeHit {
  videoId: string;
  title: string;
  channel: string;
  publishedAt: string;
  url: string;
}

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

export interface SemanticOpts {
  query: string;
  topK?: number;
}

export interface SemanticResult {
  chunks: { text: string; score: number; sourceUrl: string }[];
}

export interface SemanticCodeOpts {
  query: string;
  repo?: string;
  language?: string;
  topK?: number;
}

export interface SemanticCodeResult {
  matches: { file: string; snippet: string; score: number; repo: string }[];
}

export interface BrowserExtractPlan {
  actions: Record<string, unknown>[];
}

export interface BrowserExtractResult {
  data: unknown;
}

/**
 * A single acquisition backend. Every method is optional except the core
 * four (search/read/crawl/academic) — a provider declares what it actually
 * supports via `capabilities` and Trellis's research core checks that
 * before calling, rather than every provider needing to implement all 16
 * methods.
 */
export interface ResearchProvider {
  readonly name: string;
  readonly capabilities: ResearchCapabilities;

  search(query: string, opts?: SearchOpts): Promise<ResearchHit[]>;
  read(url: string): Promise<ReadResult>;
  crawl(url: string, opts?: { maxPages?: number }): Promise<CrawlResult[]>;
  academic(query: string, opts?: AcademicOpts): Promise<ResearchHit[]>;

  github?(query: string, opts?: SearchOpts): Promise<GitHubHit[]>;
  reddit?(query: string, opts?: CommunityOpts): Promise<RedditHit[]>;
  redditThread?(url: string, opts?: { limit?: number }): Promise<RedditThread>;
  hackernews?(query: string, opts?: SearchOpts): Promise<ResearchHit[]>;
  stackoverflow?(query: string, opts?: SearchOpts): Promise<ResearchHit[]>;
  youtube?(query: string, opts?: MediaOpts): Promise<YouTubeHit[]>;
  youtubeTranscript?(videoId: string, language?: string): Promise<TranscriptSegment[]>;
  wikipedia?(query: string, opts?: { language?: string }): Promise<ResearchHit[]>;

  semanticSearch?(query: string, opts: SemanticOpts): Promise<SemanticResult>;
  semanticCrawl?(url: string, query: string, opts?: SemanticOpts): Promise<SemanticResult>;
  semanticCode?(query: string, opts: SemanticCodeOpts): Promise<SemanticCodeResult>;

  browser?: {
    open(opts?: Record<string, unknown>): Promise<string>;
    extract(sessionId: string, url: string, plan: BrowserExtractPlan): Promise<BrowserExtractResult>;
    close(sessionId: string): Promise<void>;
  };
}
