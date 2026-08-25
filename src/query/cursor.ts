import { InvalidCursorError, InvalidQueryError } from './errors.js';

/**
 * Keyset pagination cursor codec. Cursors are base64url(JSON) so clients
 * treat them as fully opaque; decodeCursor validates shape strictly.
 */

export type QueryKind = 'claims' | 'sources' | 'claim-observations' | 'evidence' | 'claim-relations';

export interface CursorPayload {
  v: 1;
  kind: QueryKind;
  /**
   * Sort-key tuple for the row after which to resume. Shape varies by kind:
   * - claims:             [lastSeenAt: string | null, id: string] (null lastSeenAt sorts last)
   * - sources:            [lastSeenAt: string, id: string]
   * - claim-observations: [observedAt: string, id: string]
   * - evidence:           [id: string]
   * - claim-relations:    [id: string]
   */
  key: (string | null)[];
}

const KEY_LENGTHS: Record<QueryKind, number> = {
  claims: 2,
  sources: 2,
  'claim-observations': 2,
  evidence: 1,
  'claim-relations': 1,
};

/** Kinds whose first key element may be null. */
const NULLABLE_FIRST: ReadonlySet<QueryKind> = new Set(['claims']);

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes and validates a cursor for the given query kind. Throws
 * InvalidCursorError on malformed base64, invalid JSON, wrong version,
 * wrong kind (cross-query cursor reuse), wrong tuple length, or wrong
 * element types.
 */
export function decodeCursor(cursor: string, expectedKind: QueryKind): CursorPayload {
  let json: string;
  try {
    json = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError('Cursor is not valid base64url');
  }
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(cursor)) {
    // Node's base64url decoding silently skips invalid characters; reject
    // anything that isn't canonical base64url so tampered cursors fail loudly.
    throw new InvalidCursorError('Cursor is not valid base64url');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidCursorError('Cursor payload is not valid JSON');
  }

  const payload = parsed as Partial<CursorPayload> | null;
  if (payload === null || typeof payload !== 'object') {
    throw new InvalidCursorError('Cursor payload is not an object');
  }
  if (payload.v !== 1) {
    throw new InvalidCursorError(`Unsupported cursor version ${JSON.stringify(payload.v)}, expected 1`);
  }
  if (payload.kind !== expectedKind) {
    throw new InvalidCursorError(`Cursor is for '${String(payload.kind)}', expected '${expectedKind}'`);
  }
  if (!Array.isArray(payload.key)) {
    throw new InvalidCursorError('Cursor key must be an array');
  }

  const expectedLength = KEY_LENGTHS[expectedKind];
  if (payload.key.length !== expectedLength) {
    throw new InvalidCursorError(`Cursor key has ${String(payload.key.length)} elements, expected ${String(expectedLength)} for '${expectedKind}'`);
  }

  for (let i = 0; i < payload.key.length; i++) {
    const element = payload.key[i];
    if (element !== null && typeof element !== 'string') {
      throw new InvalidCursorError(`Cursor key element ${String(i)} must be a string or null, got ${typeof element}`);
    }
    if (element === null && !(i === 0 && NULLABLE_FIRST.has(expectedKind))) {
      throw new InvalidCursorError(`Cursor key element ${String(i)} must be a non-null string for '${expectedKind}'`);
    }
  }

  return { v: 1, kind: expectedKind, key: [...payload.key] };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Resolves an explicit page limit. Missing limit → default 50. Positive
 * integers above MAX_LIMIT clamp down to 100. Zero, negative, NaN, or
 * non-integer explicit values throw InvalidQueryError — nonsense input is
 * rejected, not silently coerced; only a MISSING limit uses the default.
 */
export function resolveLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidQueryError(`Invalid limit ${String(limit)}: must be a positive integer between 1 and ${String(MAX_LIMIT)}`);
  }
  return Math.min(limit, MAX_LIMIT);
}

/**
 * Basic hygiene for free-text search input: trims surrounding whitespace,
 * returns undefined when empty after trim, rejects strings over the cap.
 * Cap is 200 chars — long enough for realistic FTS5 MATCH expressions,
 * short enough to keep LIKE/MATCH cost bounded. Does NOT validate FTS5
 * syntax itself (that happens where MATCH actually runs).
 */
export const MAX_SEARCH_QUERY_LENGTH = 200;

export function validateSearchQuery(q: string | undefined): string | undefined {
  if (q === undefined) return undefined;
  const trimmed = q.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new InvalidQueryError(`Search query exceeds maximum length of ${String(MAX_SEARCH_QUERY_LENGTH)}`);
  }
  return trimmed;
}
