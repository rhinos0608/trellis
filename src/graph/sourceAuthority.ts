/**
 * Source authority classification and source type inference.
 * Moved from research/provenance.ts to graph layer — these are pure
 * functions over persisted source fields, no research/ dependency needed.
 */

import type { AuthorityClass, SourceType } from './types.js';

// ── Authority classification ───────────────────────────────────────────────

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function pathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Classify the authority of a source based on its URL, domain, and source type.
 */
export function classifySourceAuthority(
  source: { url: string; domain: string; sourceType: SourceType },
): AuthorityClass {
  const rawDomain = (source.domain || hostname(source.url)).toLowerCase();
  const domain = rawDomain.replace(/^www\./, '');
  const path = pathname(source.url);

  // GitHub repos
  if (domain === 'github.com') {
    const pathParts = path.split('/').filter(Boolean);
    if (pathParts.length >= 2) {
      // Official org repos (e.g., github.com/nodejs/*, github.com/microsoft/*)
      const owner = pathParts[0];
      if (
        owner === 'nodejs' ||
        owner === 'microsoft' ||
        owner === 'denoland' ||
        owner === 'anthropics'
      ) {
        return 'official_repo';
      }
      return 'third_party_analysis';
    }
  }

  // Package registries
  if (
    domain === 'npmjs.com' ||
    domain === 'pypi.org' ||
    domain === 'crates.io' ||
    domain === 'rubygems.org'
  ) {
    return 'package_registry';
  }

  // Wikipedia
  if (domain === 'wikipedia.org' || domain.endsWith('.wikipedia.org')) return 'encyclopedia';

  // Source-type-based fallback
  if (source.sourceType === 'official_docs') return 'official_spec';
  if (source.sourceType === 'documentation') return 'vendor_sdk_docs';
  if (source.sourceType === 'wikipedia') return 'encyclopedia';
  if (
    source.sourceType === 'reddit' ||
    source.sourceType === 'hackernews' ||
    source.sourceType === 'stackoverflow' ||
    source.sourceType === 'youtube' ||
    source.sourceType === 'forum' ||
    source.sourceType === 'social'
  ) {
    return 'forum_social';
  }
  if (source.sourceType === 'news' || source.sourceType === 'gdelt')
    return 'news';
  if (source.sourceType === 'vendor_docs') return 'vendor_sdk_docs';
  if (source.sourceType === 'package_registry') return 'package_registry';
  if (source.sourceType === 'academic') return 'third_party_analysis';

  return 'third_party_analysis';
}

/**
 * Infer source type from URL.
 */
export function inferSourceTypeFromUrl(
  url: string,
  fallback: SourceType,
): SourceType {
  const domain = hostname(url);

  if (domain === 'github.com') return 'github';
  if (
    domain === 'npmjs.com' ||
    domain === 'pypi.org' ||
    domain === 'crates.io'
  ) {
    return 'package_registry';
  }
  if (domain === 'wikipedia.org') return 'wikipedia';
  if (domain === 'stackoverflow.com' || domain.includes('stackexchange'))
    return 'stackoverflow';
  if (domain === 'reddit.com' || domain === 'old.reddit.com') return 'reddit';
  if (domain === 'news.ycombinator.com') return 'hackernews';
  if (domain === 'arxiv.org' || domain.includes('semanticscholar'))
    return 'academic';
  if (domain === 'youtube.com' || domain === 'youtu.be') return 'youtube';
  if (domain === 'docs.google.com' || domain.includes('documentation'))
    return 'documentation';

  return fallback;
}
