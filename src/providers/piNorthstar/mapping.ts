/**
 * Pure mapping functions for the pi-northstar provider (P1 scope only).
 *
 * P1 tools: `web_search`, `fetch`, `research` (academic action), `github`.
 * No social/media/kg/graph/browser mapping — out of scope for Phase 1.
 *
 * Envelope: `pi-northstar call TOOL JSON_ARGS` prints
 * `{ ok: true, data: { content, details } }` (schema `pi-northstar.result`
 * v1). Mapping unwraps `data.details` and converts to ResearchProvider DTOs.
 *
 * Provenance: Pi markers are untrusted evidence and must survive mapping —
 * snippets/titles pass through verbatim (bounds + control-char stripping
 * only, never marker filtering). Every DTO produced here is served under
 * provider name `pi-northstar`.
 */

import type {
  AcademicOpts,
  CrawlResult,
  GitHubHit,
  ReadResult,
  ResearchHit,
  SearchOpts,
} from '../types.js';
import { validateFetchableUrl } from '../searchMcp/urlPolicy.js';
import {
  capArray,
  boundShortField,
  boundMediumField,
  boundBodyField,
} from '../searchMcp/bounds.js';

// ── Tool call shape ────────────────────────────────────────────────────

export interface PiNorthstarToolCall {
  name: string;
  args: Record<string, unknown>;
}

// ── Tool call builders (P1 only) ───────────────────────────────────────

export function mapSearch(query: string, opts?: SearchOpts): PiNorthstarToolCall {
  const args: Record<string, unknown> = { query };
  if (opts?.limit !== undefined) args.limit = opts.limit;
  // Native pi-northstar names the freshness filter `recency`, not `freshness`.
  if (opts?.freshness !== undefined && opts.freshness !== 'all') {
    args.recency = opts.freshness;
  }
  return { name: 'web_search', args };
}

/** Generic fetch-policy failure: never embeds raw URL (agent-tool content safe). */
function fetchPolicyError(): Error {
  const err = new Error('URL failed fetch policy');
  const rec = err as unknown as Record<string, unknown>;
  rec.operation = 'callTool';
  rec.classification = 'PERMANENT';
  return err;
}

export function mapRead(url: string): PiNorthstarToolCall {
  try {
    validateFetchableUrl(url);
  } catch {
    throw fetchPolicyError();
  }
  return { name: 'fetch', args: { url } };
}

export function mapCrawl(
  url: string,
  opts?: { maxPages?: number },
): PiNorthstarToolCall {
  try {
    validateFetchableUrl(url);
  } catch {
    throw fetchPolicyError();
  }
  const args: Record<string, unknown> = { url };
  if (opts?.maxPages !== undefined) args.maxPages = opts.maxPages;
  return { name: 'fetch', args };
}

export function mapAcademic(query: string, opts?: AcademicOpts): PiNorthstarToolCall {
  const args: Record<string, unknown> = { action: 'academic', query };
  if (opts?.source !== undefined) args.source = opts.source;
  if (opts?.limit !== undefined) args.limit = opts.limit;
  if (opts?.yearFrom !== undefined) args.yearFrom = opts.yearFrom;
  return { name: 'research', args };
}

export function mapGithub(query: string, opts?: SearchOpts): PiNorthstarToolCall {
  const args: Record<string, unknown> = { action: 'search', query };
  if (opts?.limit !== undefined) args.limit = opts.limit;
  return { name: 'github', args };
}

// ── Envelope unwrapping ────────────────────────────────────────────────

export interface UnwrappedPiNorthstar {
  /** The `details` payload (results/entities/page). */
  details: unknown;
  /** Raw content blocks, when present. */
  content: unknown[];
}

/**
 * Unwrap one `callTool` result (`{ data, content }` where `data` is the CLI
 * `data` field = `{ content, details }`) down to the `details` payload.
 * Tolerates degraded shapes: missing details → undefined (mappers yield
 * empty results, never throw).
 */
export function unwrapDetails(raw: unknown): UnwrappedPiNorthstar {
  if (raw === null || typeof raw !== 'object') return { details: undefined, content: [] };
  const outer = raw as Record<string, unknown>;
  const data = outer.data;
  if (data === null || typeof data !== 'object') return { details: undefined, content: [] };
  const inner = data as Record<string, unknown>;
  const content = Array.isArray(inner.content) ? inner.content : [];
  return { details: inner.details, content };
}

/** Extract the result array from a details payload (results/entities/…). */
export function extractDetailsArray(details: unknown): unknown[] {
  if (Array.isArray(details)) return details;
  if (details !== null && typeof details === 'object') {
    const obj = details as Record<string, unknown>;
    for (const key of [
      'results',
      'entities',
      'items',
      'papers',
      'pages',
      'repositories',
    ]) {
      const val = obj[key];
      if (Array.isArray(val)) return val;
    }
  }
  return [];
}

// ── Response mappers ───────────────────────────────────────────────────

function dropUnsafe(url: string): string | null {
  try {
    validateFetchableUrl(url);
    return url;
  } catch {
    return null;
  }
}

export function toResearchHits(details: unknown): ResearchHit[] {
  return capArray(extractDetailsArray(details))
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const rawUrl = typeof r.url === 'string' ? r.url : undefined;
      const rawTitle = typeof r.title === 'string'
        ? r.title
        : typeof r.id === 'string'
          ? r.id
          : undefined;
      if (!rawUrl || !rawTitle) return null;
      const url = dropUnsafe(rawUrl);
      if (url === null) return null;
      const hit: ResearchHit = { url, title: boundShortField(rawTitle) };
      const snippet = typeof r.snippet === 'string'
        ? r.snippet
        : typeof r.description === 'string'
          ? r.description
          : undefined;
      if (snippet !== undefined) hit.snippet = boundMediumField(snippet);
      const domain = typeof r.source === 'string'
        ? r.source
        : typeof r.backend === 'string'
          ? r.backend
          : typeof r.domain === 'string'
            ? r.domain
            : undefined;
      if (domain !== undefined) hit.domain = boundShortField(domain);
      if (typeof r.publishedAt === 'string') {
        hit.publishedAt = boundShortField(r.publishedAt);
      }
      return hit;
    })
    .filter((h): h is ResearchHit => h !== null);
}

export function toReadResult(details: unknown, url: string): ReadResult {
  let content = '';
  let title: string | undefined;
  let publishedAt: string | undefined;
  if (details !== null && typeof details === 'object') {
    const obj = details as Record<string, unknown>;
    if (typeof obj.content === 'string') content = obj.content;
    if (typeof obj.title === 'string' && obj.title.length > 0) title = obj.title;
    if (typeof obj.publishedAt === 'string') publishedAt = obj.publishedAt;
  }
  content = boundBodyField(content);
  if (title !== undefined) title = boundShortField(title);
  if (publishedAt !== undefined) publishedAt = boundShortField(publishedAt);
  const result: ReadResult = { url, content, contentHash: simpleHash(content) };
  if (title !== undefined) result.title = title;
  if (publishedAt !== undefined) result.publishedAt = publishedAt;
  return result;
}

export function toCrawlResults(details: unknown, fallbackUrl?: string): CrawlResult[] {
  let pages = extractDetailsArray(details);
  if (pages.length === 0) {
    // Single-page fetch shape: { url, title, content } with no array wrapper.
    if (
      details !== null &&
      typeof details === 'object' &&
      typeof (details as Record<string, unknown>).content === 'string'
    ) {
      pages = [details];
    } else {
      return [];
    }
  }
  return capArray(pages)
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const p = item as Record<string, unknown>;
      const rawUrl = typeof p.url === 'string' ? p.url : fallbackUrl;
      const rawContent = typeof p.content === 'string' ? p.content : undefined;
      if (!rawUrl || rawContent === undefined) return null;
      const url = dropUnsafe(rawUrl);
      if (url === null) return null;
      const content = boundBodyField(rawContent);
      const cr: CrawlResult = {
        url,
        content,
        contentHash: simpleHash(content),
        depth: typeof p.depth === 'number' ? p.depth : 0,
      };
      if (typeof p.title === 'string' && p.title.length > 0) {
        cr.title = boundShortField(p.title);
      }
      return cr;
    })
    .filter((r): r is CrawlResult => r !== null);
}

export function toGitHubHits(details: unknown): GitHubHit[] {
  return capArray(extractDetailsArray(details))
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const r = item as Record<string, unknown>;
      const repo = typeof r.repository === 'string'
        ? r.repository
        : typeof r.repo === 'string'
          ? r.repo
          : typeof r.full_name === 'string'
            ? r.full_name
            : undefined;
      const rawUrl = typeof r.url === 'string'
        ? r.url
        : typeof r.html_url === 'string'
          ? r.html_url
          : undefined;
      if (!repo || !rawUrl) return null;
      const url = dropUnsafe(rawUrl);
      if (url === null) return null;
      const hit: GitHubHit = { repo: boundShortField(repo), url };
      if (typeof r.path === 'string') hit.path = boundShortField(r.path);
      if (typeof r.title === 'string' && r.title !== r.path) {
        hit.description = boundMediumField(r.title);
      }
      if (typeof r.snippet === 'string') hit.snippet = boundMediumField(r.snippet);
      else if (typeof r.description === 'string' && hit.description === undefined) {
        hit.description = boundMediumField(r.description);
      }
      if (typeof r.stars === 'number') hit.stars = r.stars;
      else if (typeof r.stargazers_count === 'number') hit.stars = r.stargazers_count;
      return hit;
    })
    .filter((h): h is GitHubHit => h !== null);
}

// ── Utility ────────────────────────────────────────────────────────────

/** Simple DJB2 hash for content fingerprinting (matches searchMcp mapping). */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return `djb2:${(hash >>> 0).toString(16)}`;
}
