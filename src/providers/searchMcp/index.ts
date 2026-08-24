/**
 * Factory: wires MCP client + mapping functions into a ResearchProvider.
 *
 * Creates a search-mcp adapter that communicates over the real MCP protocol
 * (stdio transport, child process), implementing the ResearchProvider interface.
 */

import type {
  ResearchProvider,
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
  const capabilities = discoverCapabilities();

  const provider: ResearchProvider = {
    name: PROVIDER_NAME,
    capabilities,

    async search(query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapSearch(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    async read(url: string): Promise<ReadResult> {
      const call = mapRead(url);
      const result = await client.callTool(call.name, call.args);
      return toReadResult(result.data, url);
    },

    async crawl(url: string, opts?: { maxPages?: number }): Promise<CrawlResult[]> {
      const call = mapCrawl(url, opts);
      const result = await client.callTool(call.name, call.args);
      return toCrawlResults(result.data);
    },

    async academic(query: string, opts?: AcademicOpts): Promise<ResearchHit[]> {
      const call = mapAcademic(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    async github(query: string, opts?: SearchOpts): Promise<GitHubHit[]> {
      const call = mapGithub(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toGitHubHits(result.data);
    },

    async reddit(query: string, opts?: CommunityOpts): Promise<RedditHit[]> {
      const call = mapReddit(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toRedditHits(result.data);
    },

    async redditThread(url: string, opts?: { limit?: number }): Promise<RedditThread> {
      const call = mapRedditThread(url, opts);
      const result = await client.callTool(call.name, call.args);
      return toRedditThread(result.data);
    },

    async hackernews(query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapHackernews(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    async stackoverflow(query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapStackoverflow(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    async youtube(query: string, opts?: MediaOpts): Promise<YouTubeHit[]> {
      const call = mapYoutube(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toYouTubeHits(result.data);
    },

    async youtubeTranscript(videoId: string, language?: string): Promise<TranscriptSegment[]> {
      const call = mapYoutubeTranscript(videoId, language);
      const result = await client.callTool(call.name, call.args);
      return toTranscriptSegments(result.data);
    },

    async wikipedia(query: string, opts?: { language?: string }): Promise<ResearchHit[]> {
      const call = mapWikipedia(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    browser: {
      async open(opts?: Record<string, unknown>): Promise<string> {
        const call = mapBrowserOpen(opts);
        const result = await client.callTool(call.name, call.args);
        // Return session ID from response or generate one
        const data = result.data;
        if (data !== null && typeof data === 'object' && typeof (data as Record<string, unknown>).sessionId === 'string') {
          return (data as Record<string, unknown>).sessionId as string;
        }
        return 'default';
      },

      async extract(sessionId: string, url: string, plan: BrowserExtractPlan): Promise<BrowserExtractResult> {
        const call = mapBrowserExtract(sessionId, url, plan);
        const result = await client.callTool(call.name, call.args);
        return { data: result.data };
      },

      async close(sessionId: string): Promise<void> {
        const call = mapBrowserClose(sessionId);
        await client.callTool(call.name, call.args);
      },
    },
  };

  logger.info({ provider: PROVIDER_NAME, capabilities }, 'search-mcp provider created');
  return provider;
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

    async search(query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapSearch(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    async read(url: string): Promise<ReadResult> {
      const call = mapRead(url);
      const result = await client.callTool(call.name, call.args);
      return toReadResult(result.data, url);
    },

    async crawl(url: string, opts?: { maxPages?: number }): Promise<CrawlResult[]> {
      const call = mapCrawl(url, opts);
      const result = await client.callTool(call.name, call.args);
      return toCrawlResults(result.data);
    },

    async academic(query: string, opts?: AcademicOpts): Promise<ResearchHit[]> {
      const call = mapAcademic(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    async github(query: string, opts?: SearchOpts): Promise<GitHubHit[]> {
      const call = mapGithub(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toGitHubHits(result.data);
    },

    async reddit(query: string, opts?: CommunityOpts): Promise<RedditHit[]> {
      const call = mapReddit(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toRedditHits(result.data);
    },

    async redditThread(url: string, opts?: { limit?: number }): Promise<RedditThread> {
      const call = mapRedditThread(url, opts);
      const result = await client.callTool(call.name, call.args);
      return toRedditThread(result.data);
    },

    async hackernews(query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapHackernews(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    async stackoverflow(query: string, opts?: SearchOpts): Promise<ResearchHit[]> {
      const call = mapStackoverflow(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    async youtube(query: string, opts?: MediaOpts): Promise<YouTubeHit[]> {
      const call = mapYoutube(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toYouTubeHits(result.data);
    },

    async youtubeTranscript(videoId: string, language?: string): Promise<TranscriptSegment[]> {
      const call = mapYoutubeTranscript(videoId, language);
      const result = await client.callTool(call.name, call.args);
      return toTranscriptSegments(result.data);
    },

    async wikipedia(query: string, opts?: { language?: string }): Promise<ResearchHit[]> {
      const call = mapWikipedia(query, opts);
      const result = await client.callTool(call.name, call.args);
      return toResearchHits(result.data);
    },

    browser: {
      async open(opts?: Record<string, unknown>): Promise<string> {
        const call = mapBrowserOpen(opts);
        const result = await client.callTool(call.name, call.args);
        const data = result.data;
        if (data !== null && typeof data === 'object' && typeof (data as Record<string, unknown>).sessionId === 'string') {
          return (data as Record<string, unknown>).sessionId as string;
        }
        return 'default';
      },

      async extract(sessionId: string, url: string, plan: BrowserExtractPlan): Promise<BrowserExtractResult> {
        const call = mapBrowserExtract(sessionId, url, plan);
        const result = await client.callTool(call.name, call.args);
        return { data: result.data };
      },

      async close(sessionId: string): Promise<void> {
        const call = mapBrowserClose(sessionId);
        await client.callTool(call.name, call.args);
      },
    },
  };
}

/**
 * Discover capabilities. Assumes all standard search-mcp tools are available.
 *
 * For a production implementation, extend SearchMcpClient to expose listTools()
 * and dynamically probe tool availability. For now, map the known tool families.
 */
function discoverCapabilities(): ResearchCapabilities {
  const knownTools = [
    'web_search', 'web_crawl', 'research', 'github',
    'reddit', 'youtube', 'browser', 'semantic_crawl',
    'packages', 'agentic_browse',
  ];
  return mapCapabilities(knownTools);
}
