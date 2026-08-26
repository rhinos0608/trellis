/**
 * Unit tests for the URL validation boundary (urlPolicy.ts).
 */

import { describe, it, expect } from 'vitest';
import { validateFetchableUrl } from '../../../src/providers/searchMcp/urlPolicy.js';

describe('validateFetchableUrl', () => {
  // ── Valid URLs ────────────────────────────────────────────────────

  it('accepts a valid https URL', () => {
    const url = validateFetchableUrl('https://example.com/page?q=1');
    expect(url.hostname).toBe('example.com');
    expect(url.protocol).toBe('https:');
  });

  it('accepts a valid http URL', () => {
    const url = validateFetchableUrl('http://example.com');
    expect(url.protocol).toBe('http:');
  });

  it('accepts a URL with port', () => {
    const url = validateFetchableUrl('https://example.com:8080/path');
    expect(url.port).toBe('8080');
  });

  // ── Scheme rejection ──────────────────────────────────────────────

  it('rejects file: scheme', () => {
    expect(() => validateFetchableUrl('file:///etc/passwd')).toThrow('not allowed');
  });

  it('rejects data: scheme', () => {
    expect(() => validateFetchableUrl('data:text/html,<h1>hi</h1>')).toThrow('not allowed');
  });

  it('rejects javascript: scheme', () => {
    expect(() => validateFetchableUrl('javascript:alert(1)')).toThrow('not allowed');
  });

  it('rejects ftp: scheme', () => {
    expect(() => validateFetchableUrl('ftp://files.example.com/doc.pdf')).toThrow('not allowed');
  });

  // ── Embedded credentials ──────────────────────────────────────────

  it('rejects URL with embedded username', () => {
    expect(() => validateFetchableUrl('https://admin:secret@example.com')).toThrow('credentials');
  });

  // ── Localhost / literal IPs ───────────────────────────────────────

  it('rejects localhost', () => {
    expect(() => validateFetchableUrl('http://localhost/secret')).toThrow('blocked');
  });

  it('rejects *.localhost', () => {
    expect(() => validateFetchableUrl('http://evil.localhost/secret')).toThrow('blocked');
  });

  it('rejects literal IPv4', () => {
    expect(() => validateFetchableUrl('http://127.0.0.1/secret')).toThrow('literal IP');
  });

  it('rejects literal private IPv4', () => {
    expect(() => validateFetchableUrl('http://10.0.0.1/secret')).toThrow('literal IP');
  });

  it('rejects literal private IPv4 (192.168.x.x)', () => {
    expect(() => validateFetchableUrl('http://192.168.1.1/secret')).toThrow('literal IP');
  });

  it('rejects literal IPv6 loopback', () => {
    expect(() => validateFetchableUrl('http://[::1]/secret')).toThrow('literal IP');
  });

  it('rejects literal IPv6', () => {
    expect(() => validateFetchableUrl('http://[fe80::1]/secret')).toThrow('literal IP');
  });

  // ── Overlong URL ──────────────────────────────────────────────────

  it('rejects URL exceeding 8 KiB', () => {
    const longPath = 'a'.repeat(9000);
    expect(() => validateFetchableUrl(`https://example.com/${longPath}`)).toThrow('maximum length');
  });

  // ── Empty host ────────────────────────────────────────────────────

  it('rejects URL with no hostname', () => {
    // Relative URL has no hostname — URL constructor would throw
    expect(() => validateFetchableUrl('not-a-url')).toThrow('Invalid URL');
  });
});
