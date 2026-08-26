/**
 * Response field bounding helpers for search-mcp provider responses.
 *
 * Applied to ALL mapped provider response arrays/strings to prevent
 * oversized payloads from flowing into the pipeline.
 *
 * Caps (documented, enforced here):
 * - Arrays: 100 items max (truncate)
 * - Title/domain/author/path-like strings: 2 KiB UTF-8 (truncate + '…')
 * - Snippet/description/transcript-segment text: 16 KiB UTF-8 (truncate + '…')
 * - Page/read body content: 256 KiB UTF-8 (truncate + '…')
 * - URLs: REJECT overlong (per urlPolicy), never truncate a URL
 * - All strings: NUL and control characters stripped (whitespace preserved)
 */

// ── Array cap ────────────────────────────────────────────────────────

/** Maximum items to keep in any mapped response array. */
export const MAX_ARRAY_ITEMS = 100;

/** Truncate an array to MAX_ARRAY_ITEMS. Returns input unchanged if ≤ cap. */
export function capArray<T>(arr: T[]): T[] {
  if (arr.length > MAX_ARRAY_ITEMS) return arr.slice(0, MAX_ARRAY_ITEMS);
  return arr;
}

// ── String field caps (bytes, UTF-8) ────────────────────────────────

/** Max bytes for short metadata fields (title, domain, author, path). */
export const MAX_SHORT_FIELD = 2 * 1024; // 2 KiB

/** Max bytes for medium text fields (snippet, description, transcript segment). */
export const MAX_MEDIUM_FIELD = 16 * 1024; // 16 KiB

/** Max bytes for body content (page/read). */
export const MAX_BODY_FIELD = 256 * 1024; // 256 KiB

/** Truncate a string to `maxBytes` UTF-8, appending '…' if truncated. */
export function capString(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  // Truncate by bytes, reserving space for UTF-8 ellipsis.
  const ellipsisBytes = Buffer.byteLength('\u2026', 'utf8');
  if (maxBytes < ellipsisBytes) return truncateUtf8(value, maxBytes);
  return truncateUtf8(value, maxBytes - ellipsisBytes) + '\u2026';
}

// ── NUL / control character stripping ────────────────────────────────

/**
 * Strip NUL bytes and other C0/C1 control characters from a string.
 * Preserves normal whitespace: \n, \t, \r, space.
 */
export function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, '');
}

// ── Combined helpers (convenience) ──────────────────────────────────

/** Cap + strip a short metadata field (title, domain, author, path). */
export function boundShortField(value: string): string {
  return capString(stripControlChars(value), MAX_SHORT_FIELD);
}

/** Cap + strip a medium text field (snippet, description, transcript). */
export function boundMediumField(value: string): string {
  return capString(stripControlChars(value), MAX_MEDIUM_FIELD);
}

/** Cap + strip body content. */
export function boundBodyField(value: string): string {
  return capString(stripControlChars(value), MAX_BODY_FIELD);
}

// ── Internal UTF-8 byte helpers ──────────────────────────────────────

/** Get byte length of a string (UTF-8). */
function byteLength(str: string): number {
  return Buffer.byteLength(str, 'utf-8');
}

/** Truncate string to at most `maxBytes` UTF-8 bytes. */
function truncateUtf8(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(str, 'utf-8');
  if (buf.length <= maxBytes) return str;
  // Remove incomplete trailing sequences without introducing U+FFFD.
  let end = maxBytes;
  let result = buf.subarray(0, end).toString('utf-8');
  while (result.includes('\uFFFD') && end > 0) {
    result = buf.subarray(0, --end).toString('utf-8');
  }
  return result;
}
