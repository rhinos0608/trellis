import { describe, expect, it } from 'vitest';
import { canonicalizeSourceUrl } from '../../src/graph/sourceIdentity.js';

describe('canonicalizeSourceUrl', () => {
  // --- Existing behavior preserved ---
  it('strips fragment', () =>
    expect(canonicalizeSourceUrl('https://example.com/path#section')).toBe('https://example.com/path'));

  it('sorts query parameters', () =>
    expect(canonicalizeSourceUrl('https://example.com/?b=2&a=1#x')).toBe('https://example.com/?a=1&b=2'));

  it('preserves trailing slash on non-root paths', () =>
    expect(canonicalizeSourceUrl('https://example.com/path/')).toBe('https://example.com/path/'));

  it('falls back to trimmed invalid URL', () =>
    expect(canonicalizeSourceUrl('  not a url  ')).toBe('not a url'));

  it('uses explicit canonical URL', () =>
    expect(
      canonicalizeSourceUrl('https://raw.example/a#x', 'https://canonical.example/b#y'),
    ).toBe('https://canonical.example/b'));

  // --- Tracking parameter removal ---
  describe('tracking parameter removal', () => {
    it('strips UTM parameters', () => {
      const url = 'https://example.com/page?utm_source=twitter&utm_medium=social&keep=1';
      expect(canonicalizeSourceUrl(url)).toBe('https://example.com/page?keep=1');
    });

    it('strips ad click IDs (gclid, fbclid, msclkid)', () => {
      const url = 'https://example.com/?gclid=abc&fbclid=xyz&msclkid=123&val=42';
      expect(canonicalizeSourceUrl(url)).toBe('https://example.com/?val=42');
    });

    it('strips Mailchimp tracking params', () => {
      const url = 'https://example.com/?mc_cid=abc&mc_eid=def&actual=1';
      expect(canonicalizeSourceUrl(url)).toBe('https://example.com/?actual=1');
    });

    it('strips ref and ref_src', () => {
      const url = 'https://example.com/page?ref=twitter&ref_src=twsrc&real=1';
      expect(canonicalizeSourceUrl(url)).toBe('https://example.com/page?real=1');
    });

    it('strips _ga and _gl', () => {
      const url = 'https://example.com/?_ga=1.1&gl=x&_gl=0';
      expect(canonicalizeSourceUrl(url)).toBe('https://example.com/?gl=x');
    });

    it('strips igshid', () => {
      const url = 'https://example.com/?igshid=abc&k=v';
      expect(canonicalizeSourceUrl(url)).toBe('https://example.com/?k=v');
    });

    it('strips all tracking params leaving no query string', () => {
      const url = 'https://example.com/page?utm_source=x&gclid=y';
      expect(canonicalizeSourceUrl(url)).toBe('https://example.com/page');
    });

    it('two URLs differ only by tracking params - same canonical form', () => {
      const a = 'https://example.com/page?utm_source=a&utm_medium=b';
      const b = 'https://example.com/page?utm_source=x&utm_medium=y';
      expect(canonicalizeSourceUrl(a)).toBe(canonicalizeSourceUrl(b));
    });
  });

  // --- DOI normalization ---
  describe('DOI normalization', () => {
    it('doi.org resolver to canonical form', () => {
      expect(canonicalizeSourceUrl('https://doi.org/10.1234/example.5678')).toBe(
        'https://doi.org/10.1234/example.5678',
      );
    });

    it('dx.doi.org resolver to canonical form', () => {
      expect(canonicalizeSourceUrl('https://dx.doi.org/10.1234/example.5678')).toBe(
        'https://doi.org/10.1234/example.5678',
      );
    });

    it('doi.org with fragments/query stripped to canonical', () => {
      expect(canonicalizeSourceUrl('https://doi.org/10.1234/FOO?arg=1#frag')).toBe(
        'https://doi.org/10.1234/foo',
      );
    });

    it('DOI case-insensitive lowercased', () => {
      expect(canonicalizeSourceUrl('https://doi.org/10.1000/ABC.DEF')).toBe(
        'https://doi.org/10.1000/abc.def',
      );
    });

    it('doi.org with http scheme canonical to https', () => {
      expect(canonicalizeSourceUrl('http://doi.org/10.5555/test.123')).toBe(
        'https://doi.org/10.5555/test.123',
      );
    });

    it('embedded DOI in non-resolver URL normalized', () => {
      expect(canonicalizeSourceUrl('http://example.com/paper/10.1234/journal.42')).toBe(
        'https://doi.org/10.1234/journal.42',
      );
    });
  });

  // --- GitHub normalization ---
  describe('GitHub normalization', () => {
    it('www.github.com preserves www prefix', () => {
      expect(canonicalizeSourceUrl('https://www.github.com/user/repo')).toBe(
        'https://www.github.com/user/repo',
      );
    });

    it('github.com trailing slash on repo normalized', () => {
      expect(canonicalizeSourceUrl('https://github.com/user/repo/')).toBe(
        'https://github.com/user/repo',
      );
    });

    it('.git suffix removed from repo URL', () => {
      expect(canonicalizeSourceUrl('https://github.com/user/repo.git')).toBe(
        'https://github.com/user/repo',
      );
    });

    it('.git suffix with trailing slash removed', () => {
      expect(canonicalizeSourceUrl('https://github.com/user/repo.git/')).toBe(
        'https://github.com/user/repo',
      );
    });

    it('GITHUB.COM hostname lowercased', () => {
      expect(canonicalizeSourceUrl('https://GITHUB.COM/user/repo')).toBe(
        'https://github.com/user/repo',
      );
    });

    it('github.com with tracking params stripped', () => {
      expect(
        canonicalizeSourceUrl('https://github.com/user/repo?ref=sidebar&utm_source=x'),
      ).toBe('https://github.com/user/repo');
    });
  });

  // --- www / hostname normalization ---
  describe('www and hostname normalization', () => {
    it('www. prefix is preserved', () => {
      expect(canonicalizeSourceUrl('https://www.example.com/page')).toBe(
        'https://www.example.com/page',
      );
    });

    it('hostname lowercased', () => {
      expect(canonicalizeSourceUrl('https://EXAMPLE.COM/page')).toBe(
        'https://example.com/page',
      );
    });

    it('www. + uppercase are preserved and lowercased', () => {
      expect(canonicalizeSourceUrl('https://WWW.Example.COM/')).toBe(
        'https://www.example.com',
      );
    });

    it('http scheme preserved not forced to https', () => {
      expect(canonicalizeSourceUrl('http://example.com/page')).toBe(
        'http://example.com/page',
      );
    });
  });

  // --- Trailing-slash normalization on root ---
  describe('root trailing-slash normalization', () => {
    it('root path / with no query stripped', () => {
      expect(canonicalizeSourceUrl('https://example.com/')).toBe('https://example.com');
    });

    it('root path / with query params slash stripped params kept', () => {
      expect(canonicalizeSourceUrl('https://example.com/?a=1')).toBe(
        'https://example.com/?a=1',
      );
    });

    it('non-root trailing slash preserved', () => {
      expect(canonicalizeSourceUrl('https://example.com/path/')).toBe(
        'https://example.com/path/',
      );
    });
  });

  // --- Unparseable input fallback ---
  describe('unparseable input fallback', () => {
    it('whitespace-only returns empty', () => {
      expect(canonicalizeSourceUrl('   ')).toBe('');
    });

    it('garbage string trimmed', () => {
      expect(canonicalizeSourceUrl('  ::invalid:: ')).toBe('::invalid::');
    });

    it('bare path treated as fallback not a valid URL', () => {
      expect(canonicalizeSourceUrl('not-a-url')).toBe('not-a-url');
    });
  });

  // --- No false-positive identity collisions ---
  describe('no false-positive identity collisions', () => {
    it('genuinely different URLs remain different', () => {
      const urls = [
        'https://a.com/page1',
        'https://a.com/page2',
        'https://a.com/page1?x=1',
        'https://a.com/page1?x=2',
        'https://b.com/page1',
        'http://a.com/page1',
      ];
      const canonicals = urls.map((u) => canonicalizeSourceUrl(u));
      const unique = new Set(canonicals);
      expect(unique.size).toBe(urls.length);
    });

    it('different DOIs stay different', () => {
      const a = canonicalizeSourceUrl('https://doi.org/10.1000/aaa');
      const b = canonicalizeSourceUrl('https://doi.org/10.1000/bbb');
      expect(a).not.toBe(b);
    });

    it('www and non-www different paths stay different', () => {
      const a = canonicalizeSourceUrl('https://www.example.com/a');
      const b = canonicalizeSourceUrl('https://www.example.com/b');
      expect(a).not.toBe(b);
    });

    it('scheme difference preserved for non-DOI URLs', () => {
      expect(canonicalizeSourceUrl('http://example.com')).not.toBe(
        canonicalizeSourceUrl('https://example.com'),
      );
    });
  });

  // --- Combined / integration ---
  describe('combined transformations', () => {
    it('tracking + www + fragment + sort all apply', () => {
      expect(
        canonicalizeSourceUrl(
          'https://WWW.Example.COM/page?utm_source=x&z=1&a=2#top',
        ),
      ).toBe('https://www.example.com/page?a=2&z=1');
    });

    it('explicit canonical goes through same normalization', () => {
      expect(
        canonicalizeSourceUrl(
          'https://raw.example/a',
          'https://WWW.CANONICAL.COM/b?utm_source=x&k=v',
        ),
      ).toBe('https://www.canonical.com/b?k=v');
    });
  });
});
