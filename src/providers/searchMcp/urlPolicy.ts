/**
 * Shared URL validation boundary for Trellis's search-mcp integration.
 *
 * Validates URLs BEFORE Trellis's own code sends them to the MCP provider
 * (read/crawl calls) and when mapping provider responses back into
 * Trellis types (ResearchHit, CrawlResult, etc.).
 *
 * Scope: This validator only checks URLs that Trellis itself forwards to
 * search-mcp for crawling/reading. DNS resolution, redirect following, and
 * private-IP resolution after DNS are search-mcp's responsibility — Trellis
 * never resolves DNS itself. This means DNS-resolved private addresses and
 * redirect-based SSRF are explicitly OUT OF scope here.
 */

import { isIP } from 'node:net';

const MAX_URL_LENGTH = 8 * 1024; // 8 KiB
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const BLOCKED_HOSTS = new Set(['localhost']);
const TRAILING_DOT_LOCALENDPOINT = '.localhost';

/**
 * Validate a URL is safe for Trellis to forward to search-mcp.
 *
 * Returns the parsed URL on success. Throws `Error` with descriptive
 * message on rejection.
 */
export function validateFetchableUrl(rawUrl: string): URL {
  // 1. Length check (UTF-8 bytes, not JS string length)
  if (Buffer.byteLength(rawUrl, 'utf8') > MAX_URL_LENGTH) {
    throw new Error(`URL exceeds maximum length of ${String(MAX_URL_LENGTH)} bytes`);
  }

  // 2. Parse
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  // 3. Scheme check
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(`URL scheme ${parsed.protocol} is not allowed (must be http: or https:)`);
  }

  // 4. Hostname required
  if (!parsed.hostname) {
    throw new Error('URL must have a non-empty hostname');
  }

  // 5. Reject embedded credentials
  if (parsed.username || parsed.password) {
    throw new Error('URL contains embedded credentials (user:pass@host)');
  }

  // 6. Reject localhost and *.localhost
  //    Normalize trailing dot (valid DNS FQDN syntax for localhost.)
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTS.has(host) || host.endsWith(TRAILING_DOT_LOCALENDPOINT)) {
    throw new Error(`URL hostname "${host}" is blocked`);
  }

  // 7. Reject literal IP addresses (IPv4 and IPv6)
  //    This catches direct private/loopback/link-local/metadata-endpoint
  //    IP targets. DNS-resolved private addresses are OUT OF scope —
  //    Trellis never resolves DNS; that's search-mcp's responsibility.
  //    Note: URL API returns IPv6 hostnames with brackets (e.g. "[::1]");
  //    strip them before the isIP check.
  const rawHost = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host;
  if (isIP(rawHost) !== 0) {
    throw new Error(`URL hostname "${host}" is a literal IP address`);
  }

  return parsed;
}
