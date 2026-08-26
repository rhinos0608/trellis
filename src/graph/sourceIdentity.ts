/**
 * Tracking query parameters that should be stripped during canonicalization.
 *
 * Categories:
 * - UTM_* (Google Analytics campaign attribution)
 * - gclid, dclid, gbraid, wbraid (Google Ads click IDs)
 * - fbclid (Facebook Ads click ID)
 * - msclkid (Microsoft/Bing Ads click ID)
 * - mc_cid, mc_eid (Mailchimp campaign/email IDs)
 * - ref, ref_src (generic referrer params used by many platforms)
 * - igshid (Instagram share ID)
 * - _ga, _gl (Google Analytics identifiers)
 * - mkt_tok (Marketo email marketing token)
 * - yclid (Yahoo Ads click ID)
 * - ttclid (TikTok Ads click ID)
 * - li_fat_id (LinkedIn Ads fat ID)
 */
const TRACKING_PARAMS = new Set([
  // UTM — Google Analytics campaign attribution
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_cid', 'utm_reader', 'utm_name', 'utm_social',
  'utm_social-type',
  // Google Ads click IDs
  'gclid', 'dclid', 'gbraid', 'wbraid',
  // Facebook Ads click ID
  'fbclid',
  // Microsoft/Bing Ads click ID
  'msclkid',
  // Mailchimp campaign/email IDs
  'mc_cid', 'mc_eid',
  // Generic referrer tracking (many platforms)
  'ref', 'ref_src', 'referring_source',
  // Instagram share ID
  'igshid',
  // Google Analytics client/session identifiers
  '_ga', '_gl',
  // Yahoo Ads click ID
  'yclid',
  // TikTok Ads click ID
  'ttclid',
  // LinkedIn Ads identifier
  'li_fat_id',
  // Marketo email marketing token
  'mkt_tok',
]);

/** DOI pattern: 10.{digits}/{rest} where rest contains valid DOI chars. */
 
const DOI_PATTERN = /10\.\d{4,9}\/[\w.\-;()/:[\]\\]+/;

/** Hosts that are DOI resolvers. */
const DOI_RESOLVERS = new Set(['doi.org', 'dx.doi.org']);

/**
 * Extract a DOI string from a URL's host or path if present.
 * Returns the raw DOI string (without prefix) or null.
 */
function extractDoi(hostname: string, pathname: string): string | null {
  // Case 1: DOI resolver host — DOI is the path segment
  if (DOI_RESOLVERS.has(hostname.toLowerCase())) {
    const pathDoi = pathname.replace(/^\//, '');
    if (pathDoi && DOI_PATTERN.test(pathDoi)) return pathDoi;
  }
  // Case 2: DOI embedded anywhere in the URL (e.g. http://example.com/10.1234/foo)
  const m = DOI_PATTERN.exec(hostname + pathname);
  return m ? m[0] : null;
}

export function canonicalizeSourceUrl(rawUrl: string, explicitCanonical?: string): string {
  const input = explicitCanonical ?? rawUrl;
  try {
    const parsed = new URL(input);
    // Strip fragment
    parsed.hash = '';

    // --- DOI normalization (must happen before hostname tricks since it reads host+path) ---
    const doi = extractDoi(parsed.hostname, parsed.pathname);
    if (doi) {
      // DOIs are case-insensitive per spec; lowercase for canonical form.
      return `https://doi.org/${doi.toLowerCase()}`;
    }

    // --- Hostname normalization ---
    // Lowercase hostname (hostnames are case-insensitive per RFC 3986).
    parsed.hostname = parsed.hostname.toLowerCase();

    // www. prefix is preserved — not universally redundant and
    // stripping can collide with verified alias equivalence rules.

    // --- GitHub-specific normalization ---
    if (parsed.hostname === 'github.com' || parsed.hostname === 'www.github.com') {
      // Remove trailing .git suffix from repo path segments
      parsed.pathname = parsed.pathname.replace(/\.git(\/?$)/, '$1');
      // Strip trailing slash on GitHub URLs (repo roots)
      if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '');
      }
    }

    // --- Tracking parameter removal ---
    // Use Array.from to avoid downlevelIteration issues with Set iteration.
    const params = Array.from(TRACKING_PARAMS);
    for (const param of params) {
      parsed.searchParams.delete(param);
    }

    // --- Sort remaining query params for stable canonical form ---
    parsed.searchParams.sort();

    let result = parsed.toString();

    // --- Trailing-slash normalization on root path ---
    // URL.toString() always re-adds / for root paths, so we strip it from the
    // output string. Only collapse / → empty when there's no query string,
    // preserving trailing slashes on non-root paths.
    if (parsed.pathname === '/' && parsed.search === '') {
      result = result.replace(/\/$/, '');
    }

    return result;
  } catch {
    return input.trim();
  }
}
