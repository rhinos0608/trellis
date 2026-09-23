/**
 * Factory: wires the pi-northstar CLI client + mapping functions into a
 * ResearchProvider (P1 scope: search/read/crawl/academic/github only).
 *
 * Detection is AUTOMATIC and opt-in via single switch (`piNorthstar.autoDetect`,
 * default off = zero behavior change). Resolution order:
 *   1. `pi-northstar` on PATH (parent process PATH used for discovery only,
 *      never forwarded to the child)
 *   2. sibling Northstar checkout (`../Pi-Atlas`, `../Pi-Northstar`, or
 *      `../Northstar`, relative to cwd)
 *   3. local `./bin/pi-northstar.mjs` (relative to cwd)
 * Fails closed with an actionable error when enabled but unresolvable.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import type {
  AcademicOpts,
  CrawlResult,
  GitHubHit,
  ProviderCallContext,
  ReadResult,
  ResearchCapabilities,
  ResearchHit,
  ResearchProvider,
  SearchOpts,
} from '../types.js';
import type { TrellisConfig } from '../../config/index.js';
import { logger } from '../../logger.js';
import {
  createPiNorthstarClient,
  parseCallOutput,
  spawnPiNorthstar,
  type DiscoveredPiNorthstarClient,
  type PiNorthstarClient,
  type PiNorthstarExecutor,
  type ResolvedPiNorthstar,
} from './client.js';
import {
  mapAcademic,
  mapCrawl,
  mapGithub,
  mapRead,
  mapSearch,
  toCrawlResults,
  toGitHubHits,
  toReadResult,
  toResearchHits,
  unwrapDetails,
} from './mapping.js';

export const PI_NORTHSTAR_PROVIDER_NAME = 'pi-northstar';

/** P1 capabilities: web_search/fetch/research/github. Everything else off. */
export function piNorthstarCapabilities(): ResearchCapabilities {
  return {
    search: true,
    read: true,
    academic: true,
    code: true,
    community: { reddit: false, hackernews: false, stackoverflow: false },
    media: false,
    reference: false,
    browser: false,
    academicBackends: [
      'arxiv', 'semantic_scholar', 'openalex', 'crossref',
      'pubmed', 'wikipedia', 'hackernews', 'stackoverflow',
      'datacite', 'ror', 'gdelt', 'wikidata',
    ],
  };
}

export function isPiNorthstarEnabled(cfg: TrellisConfig): boolean {
  return cfg.piNorthstar.autoDetect;
}

/**
 * Resolve the pi-northstar spawn target. Throws an actionable error when
 * nothing is found (fail closed — caller surfaces it, never silently
 * falls back to another provider).
 */
export function resolvePiNorthstarCommand(
  cfg: TrellisConfig,
  opts?: { cwd?: string; pathEnv?: string },
): ResolvedPiNorthstar {
  const cwd = opts?.cwd ?? process.cwd();
  const tried: string[] = [];
  void cfg;

  // 1. PATH lookup (discovery only; child env never inherits PATH).
  const pathEnv = opts?.pathEnv ?? process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = resolve(dir, 'pi-northstar');
    if (existsSync(candidate)) {
      // existsSync alone admits non-executables (EACCES at spawn, then
      // pointless retries): require execute permission before accepting.
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
      return { command: candidate, args: [], source: 'path' };
    }
  }
  tried.push('pi-northstar on PATH (not found)');

  // 2. Sibling checkout + 3. local bin (`.mjs` runs under node itself).
  const siblings: { path: string; source: ResolvedPiNorthstar['source'] }[] = [
    { path: resolve(cwd, '../Pi-Atlas/bin/pi-northstar.mjs'), source: 'sibling' },
    { path: resolve(cwd, '../Pi-Northstar/bin/pi-northstar.mjs'), source: 'sibling' },
    { path: resolve(cwd, '../Northstar/bin/pi-northstar.mjs'), source: 'sibling' },
    { path: resolve(cwd, 'bin/pi-northstar.mjs'), source: 'local' },
  ];
  for (const { path, source } of siblings) {
    tried.push(path);
    if (existsSync(path)) {
      return { command: process.execPath, args: [path], source };
    }
  }

  throw new Error(
    'pi-northstar provider is enabled but no binary was found. ' +
      `Tried: ${tried.join('; ')}. ` +
      'Install pi-northstar on PATH or check out Pi-Atlas/Pi-Northstar next to trellis.'
  );
}

async function discoverStatus(
  resolved: ResolvedPiNorthstar,
  executor: PiNorthstarExecutor,
): Promise<unknown> {
  const timeoutMs = 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const exec = await executor(
      resolved.command,
      [...resolved.args, 'status'],
      { signal: controller.signal, timeoutMs },
    );
    return parseCallOutput('status', exec).data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a ResearchProvider backed by the pi-northstar CLI subprocess.
 * Fails fast when disabled or when the binary cannot be resolved.
 */
export async function createPiNorthstarProvider(
  cfg: TrellisConfig,
  deps?: { executor?: PiNorthstarExecutor; resolved?: ResolvedPiNorthstar },
): Promise<ResearchProvider> {
  if (!isPiNorthstarEnabled(cfg)) {
    throw new Error(
      'pi-northstar provider is disabled. ' +
        'Set TRELLIS_PI_NORTHSTAR_AUTODETECT=1 to enable automatic detection.',
    );
  }
  const resolved = deps?.resolved ?? resolvePiNorthstarCommand(cfg);
  const executor = deps?.executor ?? spawnPiNorthstar;
  // Capability discovery via status: proves the binary runs before we
  // advertise P1 capabilities. Config stays advisory (logged, not gated).
  const status = await discoverStatus(resolved, executor);
  logger.info(
    { provider: PI_NORTHSTAR_PROVIDER_NAME, source: resolved.source, status },
    'pi-northstar provider created',
  );
  const client = createPiNorthstarClient(resolved, { executor, status });
  return createPiNorthstarProviderFromClient(client);
}

/** Create a provider from an existing client (testing + custom wiring). */
export function createPiNorthstarProviderFromClient(
  client: PiNorthstarClient | DiscoveredPiNorthstarClient,
): ResearchProvider {
  const capabilities = piNorthstarCapabilities();
  return {
    name: PI_NORTHSTAR_PROVIDER_NAME,
    capabilities,

    async search(
      ctx: ProviderCallContext,
      query: string,
      opts?: SearchOpts,
    ): Promise<ResearchHit[]> {
      const call = mapSearch(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(unwrapDetails(result).details);
    },

    async read(ctx: ProviderCallContext, url: string): Promise<ReadResult> {
      const call = mapRead(url);
      const result = await client.callTool(call.name, call.args, ctx);
      return toReadResult(unwrapDetails(result).details, url);
    },

    async crawl(
      ctx: ProviderCallContext,
      url: string,
      opts?: { maxPages?: number },
    ): Promise<CrawlResult[]> {
      const call = mapCrawl(url, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toCrawlResults(unwrapDetails(result).details, url);
    },

    async academic(
      ctx: ProviderCallContext,
      query: string,
      opts?: AcademicOpts,
    ): Promise<ResearchHit[]> {
      const call = mapAcademic(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toResearchHits(unwrapDetails(result).details);
    },

    async github(
      ctx: ProviderCallContext,
      query: string,
      opts?: SearchOpts,
    ): Promise<GitHubHit[]> {
      const call = mapGithub(query, opts);
      const result = await client.callTool(call.name, call.args, ctx);
      return toGitHubHits(unwrapDetails(result).details);
    },

    close: () => {
      return client.close();
    },
  };
}

