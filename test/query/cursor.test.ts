import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, resolveLimit, validateSearchQuery } from '../../src/query/cursor.js';
import { InvalidCursorError, InvalidQueryError } from '../../src/query/errors.js';

describe('cursor codec', () => {
  it('round-trips a claims cursor with a real tuple', () => {
    const payload = { v: 1 as const, kind: 'claims' as const, key: ['2026-02-14T10:00:00.000Z', '01ABC123'] };
    const decoded = decodeCursor(encodeCursor(payload), 'claims');
    expect(decoded).toEqual(payload);
  });

  it('round-trips a claims cursor with null lastSeenAt', () => {
    const payload = { v: 1 as const, kind: 'claims' as const, key: [null, '01XYZ789'] };
    expect(decodeCursor(encodeCursor(payload), 'claims')).toEqual(payload);
  });

  it('rejects malformed base64', () => {
    expect(() => decodeCursor('!!!not-base64url!!!', 'claims')).toThrow(InvalidCursorError);
  });

  it('rejects valid base64 wrapping invalid JSON', () => {
    const badJson = Buffer.from('{not json', 'utf8').toString('base64url');
    expect(() => decodeCursor(badJson, 'claims')).toThrow(InvalidCursorError);
  });

  it('rejects wrong version', () => {
    const cursor = Buffer.from(JSON.stringify({ v: 2, kind: 'claims', key: ['2026-01-01T00:00:00Z', 'x'] }), 'utf8').toString('base64url');
    expect(() => decodeCursor(cursor, 'claims')).toThrow(/version/);
  });

  it('rejects cross-query cursor reuse (sources cursor decoded as claims)', () => {
    const sourcesCursor = encodeCursor({ v: 1, kind: 'sources', key: ['2026-02-14T10:00:00.000Z', 'src-1'] });
    expect(() => decodeCursor(sourcesCursor, 'claims')).toThrow(InvalidCursorError);
    // and in the other direction
    const claimsCursor = encodeCursor({ v: 1, kind: 'claims', key: ['2026-02-14T10:00:00.000Z', 'claim-1'] });
    expect(() => decodeCursor(claimsCursor, 'sources')).toThrow(InvalidCursorError);
  });

  it('rejects wrong tuple length for the kind', () => {
    const short = Buffer.from(JSON.stringify({ v: 1, kind: 'claims', key: ['only-one'] }), 'utf8').toString('base64url');
    expect(() => decodeCursor(short, 'claims')).toThrow(InvalidCursorError);
    const long = Buffer.from(JSON.stringify({ v: 1, kind: 'evidence', key: ['a', 'b'] }), 'utf8').toString('base64url');
    expect(() => decodeCursor(long, 'evidence')).toThrow(InvalidCursorError);
  });

  it('rejects wrong element types', () => {
    const numeric = Buffer.from(JSON.stringify({ v: 1, kind: 'sources', key: [12345, 'src-1'] }), 'utf8').toString('base64url');
    expect(() => decodeCursor(numeric, 'sources')).toThrow(InvalidCursorError);
    const nullInNonNullable = Buffer.from(JSON.stringify({ v: 1, kind: 'sources', key: [null, 'src-1'] }), 'utf8').toString('base64url');
    expect(() => decodeCursor(nullInNonNullable, 'sources')).toThrow(InvalidCursorError);
    // null allowed only at position 0 of claims
    const nullSecondClaims = Buffer.from(JSON.stringify({ v: 1, kind: 'claims', key: ['ts', null] }), 'utf8').toString('base64url');
    expect(() => decodeCursor(nullSecondClaims, 'claims')).toThrow(InvalidCursorError);
  });
});

describe('resolveLimit', () => {
  it('defaults to 50 when missing', () => {
    expect(resolveLimit()).toBe(50);
    expect(resolveLimit(undefined)).toBe(50);
  });

  it('passes through valid values', () => {
    expect(resolveLimit(10)).toBe(10);
    expect(resolveLimit(1)).toBe(1);
    expect(resolveLimit(100)).toBe(100);
  });

  it('clamps values above the cap to 100 (chosen behavior: clamp high, throw nonsense)', () => {
    expect(resolveLimit(500)).toBe(100);
    expect(resolveLimit(101)).toBe(100);
  });

  it('throws InvalidQueryError for negative, zero, NaN, and non-integer input', () => {
    expect(() => resolveLimit(-5)).toThrow(InvalidQueryError);
    expect(() => resolveLimit(0)).toThrow(InvalidQueryError);
    expect(() => resolveLimit(Number.NaN)).toThrow(InvalidQueryError);
    expect(() => resolveLimit(12.5)).toThrow(InvalidQueryError);
  });
});

describe('validateSearchQuery', () => {
  it('returns undefined for missing, empty, or whitespace-only input', () => {
    expect(validateSearchQuery(undefined)).toBeUndefined();
    expect(validateSearchQuery('')).toBeUndefined();
    expect(validateSearchQuery('   \t\n ')).toBeUndefined();
  });

  it('trims normal strings', () => {
    expect(validateSearchQuery('  better-sqlite3 WAL mode  ')).toBe('better-sqlite3 WAL mode');
  });

  it('throws InvalidQueryError over the 200-char cap', () => {
    expect(() => validateSearchQuery('a'.repeat(201))).toThrow(InvalidQueryError);
    expect(validateSearchQuery('a'.repeat(200))).toBe('a'.repeat(200));
  });
});
