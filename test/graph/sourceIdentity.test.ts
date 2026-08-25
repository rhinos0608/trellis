import { describe, expect, it } from 'vitest';
import { canonicalizeSourceUrl } from '../../src/graph/sourceIdentity.js';

describe('canonicalizeSourceUrl', () => {
  it('strips fragment', () => expect(canonicalizeSourceUrl('https://example.com/path#section')).toBe('https://example.com/path'));
  it('sorts query parameters', () => expect(canonicalizeSourceUrl('https://example.com/?b=2&a=1#x')).toBe('https://example.com/?a=1&b=2'));
  it('preserves trailing slash', () => expect(canonicalizeSourceUrl('https://example.com/path/')).toBe('https://example.com/path/'));
  it('falls back to trimmed invalid URL', () => expect(canonicalizeSourceUrl('  not a url  ')).toBe('not a url'));
  it('uses explicit canonical URL', () => expect(canonicalizeSourceUrl('https://raw.example/a#x', 'https://canonical.example/b#y')).toBe('https://canonical.example/b'));
});
