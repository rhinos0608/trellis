/**
 * Factory: wires MCP client + mapping functions into a ResearchProvider.
 *
 * Creates a search-mcp adapter that communicates over the real MCP protocol
 * (stdio transport, child process), implementing the ResearchProvider interface.
 */

import type {
  ResearchProvider,
  ProviderCallContext,
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
  BrowserExtractResult,
} from '../types.js';
import type { TrellisConfig } from '../../config/index.js';
import {
  createSearchMcpClient,
  type SearchMcpClient,
} from './client.js';
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
  toResearchHits,
  toReadResult,
  toCrawlResults,
  toGitHubHits,
  toRedditHits,
  toRedditThread,
  toYouTubeHits,
  toTranscriptSegments,
} from './mapping.js';
import { logger } from '../../logger.js';

const PROVIDER_NAME = 'search-mcp';

/**
 * Create a ResearchProvider backed by a real out-of-process MCP client
 * communicating with search-mcp via stdio transport.
 */
export async function createSearchMcpProvider(
  cfg: TrellisConfig,
): Promise<ResearchProvider> {
  const client = await createSearchMcpClient(cfg);
  let capabilities: ResearchCapabilities;
  try {
    capabilities = capabilitiesFromToolNames(client.toolNames);
  } catch (err: unknown) {
    // Validation runs AFTER connect; on failure close the client so the
    // spawned MCP child process doesn't leak, then re-throw the original error.
    try {
      await client.close();
    } catch {
      // best-effort cleanup — original error must still propagate
    }
    throw err;
  }

  const provider: ResearchProvider = {
    name: PROVIDER_NAME,
    capabilities,

    async search(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapSearch(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    async read(ctx: ProviderCallContext, url: string): Promise<ReadResult> {
      const call = mapRead(url);
      const result = await client.callTool(call.name, call.args, ctx);
      return toReadResult(result.data, url);
    },

    async crawl(ctx: ProviderCallContext, url: string, opts?: { maxPages?: number }): Promise<CrawlResult[]> {
      const call = mapCrawl(url, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toCrawlResults(result.data);
    },

    async academic(ctx: ProviderCallContext, query: string, opts?: AcademicOpts): Promise<ResearchHit[]> {
      const call = mapAcademic(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    async github(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<GitHubHit[]> {
      const call = mapGithub(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toGitHubHits(result.data);
    },

    async reddit(ctx: ProviderCallContext, query: string, opts?: CommunityOpts): Promise<RedditHit[]> {
      const call = mapReddit(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toRedditHits(result.data);
    },

    async redditThread(ctx: ProviderCallContext, url: string, opts?: { limit?: number }): Promise<RedditThread> {
      const call = mapRedditThread(url, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toRedditThread(result.data);
    },

    async hackernews(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapHackernews(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    async stackoverflow(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapStackoverflow(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    async youtube(ctx: ProviderCallContext, query: string, opts?: MediaOpts): Promise<YouTubeHit[]> {
      const call = mapYoutube(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toYouTubeHits(result.data);
    },

    async youtubeTranscript(ctx: ProviderCallContext, videoId: string, language?: string): Promise<TranscriptSegment[]> {
      const call = mapYoutubeTranscript(videoId, language);
      const result = await client.callTool(call.name, call.args, ctx);
      return toTranscriptSegments(result.data);
    },

    async wikipedia(ctx: ProviderCallContext, query: string, opts?: { language?: string }): Promise<ResearchHit[]> {
      const call = mapWikipedia(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    browser: {
      async open(ctx: ProviderCallContext, opts?: Record<string, unknown>): Promise<string> {
        const call = mapBrowserOpen(opts);
        const result = await client.callTool(call.name, call.args, ctx);
        // Return session ID from response or generate one
        const data = result.data;
        if (data !== null && typeof data === 'object' && typeof (data as Record<string, unknown>).sessionId === 'string') {
          return (data as Record<string, unknown>).sessionId as string;
        }
        return 'default';
      },

      async extract(ctx: ProviderCallContext, sessionId: string, url: string, plan: BrowserExtractPlan): Promise<BrowserExtractResult> {
        const call = mapBrowserExtract(sessionId, url, plan);
        const result = await client.callTool(call.name, call.args, ctx);
        return { data: result.data };
      },

      async close(ctx: ProviderCallContext, sessionId: string): Promise<void> {
        const call = mapBrowserClose(sessionId);
        await client.callTool(call.name, call.args, ctx);
      },
    },

    close: () => client.close(),
  };

  logger.info({ provider: PROVIDER_NAME, capabilities }, 'search-mcp provider created');
  return provider;
}

/** Tools the pipeline strategy cannot run without. */
const REQUIRED_SEARCH_MCP_TOOLS = ['web_search', 'web_crawl'] as const;

/**
 * Derive ResearchCapabilities from the ACTUAL tools reported by listTools()
 * at connect time, and fail fast if the minimum usable set is missing —
 * rather than silently advertising capabilities that don't exist.
 */
export function capabilitiesFromToolNames(toolNames: string[]): ResearchCapabilities {
  const missing = REQUIRED_SEARCH_MCP_TOOLS.filter((tool) => !toolNames.includes(tool));
  if (missing.length > 0) {
    throw new Error(
      `search-mcp server is missing required tool(s): ${missing.join(', ')}. ` +
      `Discovered tools: ${toolNames.length > 0 ? toolNames.join(', ') : '(none)'}. ` +
      'Is search-mcp built and fully configured?',
    );
  }
  return mapCapabilities(toolNames);
}

/**
 * Create a provider from an already-connected client (for testing).
 */
export function createSearchMcpProviderFromClient(
  client: SearchMcpClient,
  toolNames: string[],
): ResearchProvider {
  const capabilities = mapCapabilities(toolNames);

  return {
    name: PROVIDER_NAME,
    capabilities,

    async search(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapSearch(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    async read(ctx: ProviderCallContext, url: string): Promise<ReadResult> {
      const call = mapRead(url);
      const result = await client.callTool(call.name, call.args, ctx);
      return toReadResult(result.data, url);
    },

    async crawl(ctx: ProviderCallContext, url: string, opts?: { maxPages?: number }): Promise<CrawlResult[]> {
      const call = mapCrawl(url, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toCrawlResults(result.data);
    },

    async academic(ctx: ProviderCallContext, query: string, opts?: AcademicOpts): Promise<ResearchHit[]> {
      const call = mapAcademic(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    async github(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<GitHubHit[]> {
      const call = mapGithub(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toGitHubHits(result.data);
    },

    async reddit(ctx: ProviderCallContext, query: string, opts?: CommunityOpts): Promise<RedditHit[]> {
      const call = mapReddit(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toRedditHits(result.data);
    },

    async redditThread(ctx: ProviderCallContext, url: string, opts?: { limit?: number }): Promise<RedditThread> {
      const call = mapRedditThread(url, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toRedditThread(result.data);
    },

    async hackernews(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapHackernews(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    async stackoverflow(ctx: ProviderCallContext, query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapStackoverflow(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    async youtube(ctx: ProviderCallContext, query: string, opts?: MediaOpts): Promise<YouTubeHit[]> {
      const call = mapYoutube(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toYouTubeHits(result.data);
    },

    async youtubeTranscript(ctx: ProviderCallContext, videoId: string, language?: string): Promise<TranscriptSegment[]> {
      const call = mapYoutubeTranscript(videoId, language);
      const result = await client.callTool(call.name, call.args, ctx);
      return toTranscriptSegments(result.data);
    },

    async wikipedia(ctx: ProviderCallContext, query: string, opts?: { language?: string }): Promise<ResearchHit[]> {
      const call = mapWikipedia(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(result.data);
    },

    browser: {
      async open(ctx: ProviderCallContext, opts?: Record<string, unknown>): Promise<string> {
        const call = mapBrowserOpen(opts);
        const result = await client.callTool(call.name, call.args, ctx);
        const data = result.data;
        if (data !== null && typeof data === 'object' && typeof (data as Record<string, unknown>).sessionId === 'string') {
          return (data as Record<string, unknown>).sessionId as string;
        }
        return 'default';
      },

      async extract(ctx: ProviderCallContext, sessionId: string, url: string, plan: BrowserExtractPlan): Promise<BrowserExtractResult> {
        const call = mapBrowserExtract(sessionId, url, plan);
        const result = await client.callTool(call.name, call.args, ctx);
        return { data: result.data };
      },

      async close(ctx: ProviderCallContext, sessionId: string): Promise<void> {
        const call = mapBrowserClose(sessionId);
        await client.callTool(call.name, call.args, ctx);
      },
    },

    close: () => client.close(),
  };
}
