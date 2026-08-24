/**
 * Unit tests for the provider registry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider,
  getProvider,
  listProviders,
  unregisterProvider,
  clearProviders,
} from '../../src/providers/registry.js';
import type { ResearchProvider } from '../../src/providers/types.js';

function fakeProvider(name: string): ResearchProvider {
  return {
    name,
    capabilities: {
      search: true,
      read: true,
      academic: false,
      code: false,
      community: { reddit: false, hackernews: false, stackoverflow: false },
      media: false,
      reference: false,
      browser: false,
    },
    search: async () => [],
    read: async () => ({ url: '', content: '', contentHash: '' }),
    crawl: async () => [],
    academic: async () => [],
  };
}

describe('provider registry', () => {
  beforeEach(() => {
    clearProviders();
  });

  it('registers and retrieves a provider', () => {
    const p = fakeProvider('test-provider');
    registerProvider(p);
    expect(getProvider('test-provider')).toBe(p);
  });

  it('returns undefined for unknown provider', () => {
    expect(getProvider('nonexistent')).toBeUndefined();
  });

  it('lists registered providers', () => {
    registerProvider(fakeProvider('a'));
    registerProvider(fakeProvider('b'));
    expect(listProviders()).toEqual(['a', 'b']);
  });

  it('unregisters a provider', () => {
    registerProvider(fakeProvider('x'));
    expect(unregisterProvider('x')).toBe(true);
    expect(getProvider('x')).toBeUndefined();
  });

  it('returns false when unregistering nonexistent provider', () => {
    expect(unregisterProvider('nope')).toBe(false);
  });

  it('overwrites on duplicate registration', () => {
    const p1 = fakeProvider('dup');
    const p2 = fakeProvider('dup');
    registerProvider(p1);
    registerProvider(p2);
    expect(getProvider('dup')).toBe(p2);
  });

  it('clearProviders removes all', () => {
    registerProvider(fakeProvider('a'));
    registerProvider(fakeProvider('b'));
    clearProviders();
    expect(listProviders()).toEqual([]);
  });
});
