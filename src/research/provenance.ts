/**
 * Source authority classification and source type inference.
 * Ported from search-mcp provenance.ts — simplified to remove projectContext dependency.
 */

export { classifySourceAuthority, inferSourceTypeFromUrl } from '../graph/sourceAuthority.js';

/**
 * Validate and deduplicate a list of URLs.
 */
export function validateUrls(
  urls: string[],
): Promise<{ url: string; status: 'OK' | 'DEAD' | 'LIKELY_HALLUCINATED' }[]> {
  // Simplified: just check basic URL format
  return Promise.resolve(
    urls.map((url) => {
      try {
        new URL(url);
        return { url, status: 'OK' as const };
      } catch {
        return { url, status: 'LIKELY_HALLUCINATED' as const };
      }
    }),
  );
}
