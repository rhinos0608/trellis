import { describe, it, expect } from 'vitest';
import {
  classifySourceAuthority,
  inferSourceTypeFromUrl,
} from '../../src/graph/sourceAuthority.js';
import type { SourceType } from '../../src/graph/types.js';

function makeSource(url: string, sourceType: SourceType = 'web', domain?: string) {
  return { url, domain: domain ?? '', sourceType };
}

describe('classifySourceAuthority', () => {
  it('returns official_repo for nodejs GitHub repos', () => {
    expect(classifySourceAuthority(
      makeSource('https://github.com/nodejs/node', 'github'),
    )).toBe('official_repo');
  });

  it('returns official_repo for microsoft GitHub repos', () => {
    expect(classifySourceAuthority(
      makeSource('https://github.com/microsoft/vscode', 'github'),
    )).toBe('official_repo');
  });

  it('returns third_party_analysis for non-official GitHub repos', () => {
    expect(classifySourceAuthority(
      makeSource('https://github.com/user/repo', 'github'),
    )).toBe('third_party_analysis');
  });

  it('returns package_registry for npmjs.com', () => {
    expect(classifySourceAuthority(
      makeSource('https://www.npmjs.com/package/vitest', 'web'),
    )).toBe('package_registry');
  });

  it('returns package_registry for pypi.org', () => {
    expect(classifySourceAuthority(
      makeSource('https://pypi.org/project/requests/', 'web'),
    )).toBe('package_registry');
  });

  it('returns encyclopedia for wikipedia.org domain', () => {
    expect(classifySourceAuthority(
      makeSource('https://en.wikipedia.org/wiki/React', 'wikipedia'),
    )).toBe('encyclopedia');
  });

  it('returns official_spec for official_docs source type', () => {
    expect(classifySourceAuthority(
      makeSource('https://docs.example.com/api', 'official_docs'),
    )).toBe('official_spec');
  });

  it('returns vendor_sdk_docs for documentation source type', () => {
    expect(classifySourceAuthority(
      makeSource('https://docs.example.com', 'documentation'),
    )).toBe('vendor_sdk_docs');
  });

  it('returns forum_social for reddit source type', () => {
    expect(classifySourceAuthority(
      makeSource('https://reddit.com/r/reactjs', 'reddit'),
    )).toBe('forum_social');
  });

  it('returns forum_social for hackernews source type', () => {
    expect(classifySourceAuthority(
      makeSource('https://news.ycombinator.com/item?id=1', 'hackernews'),
    )).toBe('forum_social');
  });

  it('returns news for news source type', () => {
    expect(classifySourceAuthority(
      makeSource('https://techcrunch.com/article', 'news'),
    )).toBe('news');
  });

  it('returns third_party_analysis for academic source type', () => {
    expect(classifySourceAuthority(
      makeSource('https://arxiv.org/abs/1234', 'academic'),
    )).toBe('third_party_analysis');
  });

  it('returns third_party_analysis as default fallback', () => {
    expect(classifySourceAuthority(
      makeSource('https://blog.example.com/post', 'web'),
    )).toBe('third_party_analysis');
  });

  it('handles www prefix stripping', () => {
    expect(classifySourceAuthority(
      makeSource('https://www.wikipedia.org/wiki/Test', 'web'),
    )).toBe('encyclopedia');
  });

  it('returns official_repo for denoland GitHub', () => {
    expect(classifySourceAuthority(
      makeSource('https://github.com/denoland/deno', 'github'),
    )).toBe('official_repo');
  });

  it('returns official_repo for anthropics GitHub', () => {
    expect(classifySourceAuthority(
      makeSource('https://github.com/anthropics/claude', 'github'),
    )).toBe('official_repo');
  });
});

describe('inferSourceTypeFromUrl', () => {
  it('returns github for github.com', () => {
    expect(inferSourceTypeFromUrl('https://github.com/user/repo', 'web')).toBe('github');
  });

  it('returns package_registry for npmjs.com', () => {
    expect(inferSourceTypeFromUrl('https://www.npmjs.com/package/vitest', 'web')).toBe('package_registry');
  });

  it('returns package_registry for pypi.org', () => {
    expect(inferSourceTypeFromUrl('https://pypi.org/project/requests/', 'web')).toBe('package_registry');
  });

  it('returns wikipedia for wikipedia.org', () => {
    expect(inferSourceTypeFromUrl('https://www.wikipedia.org/wiki/Test', 'web')).toBe('wikipedia');
  });

  it('returns stackoverflow for stackoverflow.com', () => {
    expect(inferSourceTypeFromUrl('https://stackoverflow.com/questions/123', 'web')).toBe('stackoverflow');
  });

  it('returns stackoverflow for stackexchange domains', () => {
    expect(inferSourceTypeFromUrl('https://unix.stackexchange.com/questions/1', 'web')).toBe('stackoverflow');
  });

  it('returns reddit for reddit.com', () => {
    expect(inferSourceTypeFromUrl('https://www.reddit.com/r/react', 'web')).toBe('reddit');
  });

  it('returns reddit for old.reddit.com', () => {
    expect(inferSourceTypeFromUrl('https://old.reddit.com/r/react', 'web')).toBe('reddit');
  });

  it('returns hackernews for news.ycombinator.com', () => {
    expect(inferSourceTypeFromUrl('https://news.ycombinator.com/item?id=1', 'web')).toBe('hackernews');
  });

  it('returns academic for arxiv.org', () => {
    expect(inferSourceTypeFromUrl('https://arxiv.org/abs/1234', 'web')).toBe('academic');
  });

  it('returns academic for semanticscholar', () => {
    expect(inferSourceTypeFromUrl('https://api.semanticscholar.org/graph/v1', 'web')).toBe('academic');
  });

  it('returns youtube for youtube.com', () => {
    expect(inferSourceTypeFromUrl('https://youtube.com/watch?v=abc', 'web')).toBe('youtube');
  });

  it('returns youtube for youtu.be', () => {
    expect(inferSourceTypeFromUrl('https://youtu.be/abc', 'web')).toBe('youtube');
  });

  it('returns documentation for docs.google.com', () => {
    expect(inferSourceTypeFromUrl('https://docs.google.com/document/d/1', 'web')).toBe('documentation');
  });

  it('returns fallback for unknown domains', () => {
    expect(inferSourceTypeFromUrl('https://blog.example.com/post', 'news')).toBe('news');
  });

  it('returns package_registry for crates.io', () => {
    expect(inferSourceTypeFromUrl('https://crates.io/crates/serde', 'web')).toBe('package_registry');
  });
});
