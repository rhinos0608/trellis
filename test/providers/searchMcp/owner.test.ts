import { describe, expect, it, beforeEach } from 'vitest';
import {
  getProvider,
  closeProvider,
  resetProviderOwnerForTests,
} from '../../../src/providers/searchMcp/owner.js';
import type { ResearchProvider } from '../../../src/providers/types.js';
import type { TrellisConfig } from '../../../src/config/index.js';

function makeConfig(): TrellisConfig {
  return {
    storage: { dbPath: ':memory:' },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'echo', args: ['x'] },
    logLevel: 'silent',
  };
}

function fakeProvider(closeCalls: number[]): ResearchProvider {
  return {
    name: 'fake-provider',
    capabilities: {
      search: true,
      read: false,
      academic: false,
      code: false,
      community: { reddit: false, hackernews: false, stackoverflow: false },
      media: false,
      reference: false,
      browser: false,
    },
    async search() { return []; },
    async read() { throw new Error('not implemented'); },
    async crawl() { return []; },
    async academic() { return []; },
    close: async () => { closeCalls.push(1); },
  };
}

describe('provider owner', () => {
  beforeEach(() => {
    resetProviderOwnerForTests();
  });

  it('creates lazily and caches exactly ONE instance', async () => {
    let created = 0;
    const factory = async (_cfg: TrellisConfig): Promise<ResearchProvider> => {
      created++;
      return fakeProvider([]);
    };
    const a = await getProvider(makeConfig(), factory);
    const b = await getProvider(makeConfig(), factory);
    expect(created).toBe(1);
    expect(b).toBe(a);
  });

  it('closeProvider calls underlying close(), then recreates on next getProvider', async () => {
    const closeCalls: number[] = [];
    const factory = async (): Promise<ResearchProvider> => fakeProvider(closeCalls);
    const p = await getProvider(makeConfig(), factory);
    await closeProvider();
    expect(closeCalls.length).toBe(1);

    const p2 = await getProvider(makeConfig(), factory);
    expect(p2).not.toBe(p);
  });

  it('closeProvider is idempotent — safe twice, safe when never created', async () => {
    await expect(closeProvider()).resolves.toBeUndefined();

    const closeCalls: number[] = [];
    await getProvider(makeConfig(), async () => fakeProvider(closeCalls));
    await closeProvider();
    await closeProvider();
    expect(closeCalls.length).toBe(1);
  });

  it('CONCURRENT closeProvider calls invoke underlying close() exactly once', async () => {
    const closeCalls: number[] = [];
    const factory = async (): Promise<ResearchProvider> => fakeProvider(closeCalls);
    await getProvider(makeConfig(), factory);

    await Promise.all([closeProvider(), closeProvider(), closeProvider()]);
    expect(closeCalls.length).toBe(1);
  });

  it('closeProvider during in-flight creation closes the late provider, never publishes it', async () => {
    const resolvers: Array<(p: ResearchProvider) => void> = [];
    let created = 0;
    const factory = (): Promise<ResearchProvider> =>
      new Promise<ResearchProvider>((resolve) => {
        created++;
        resolvers.push(resolve);
      });
    const closeCalls: number[] = [];

    const closedProvider = fakeProvider(closeCalls);
    void getProvider(makeConfig(), factory); // creation #1 in flight
    const closer = closeProvider(); // captures the in-flight creation
    resolvers[0]!(closedProvider); // creation resolves AFTER close started
    await closer;

    expect(created).toBeGreaterThanOrEqual(1);
    expect(closeCalls.length).toBe(1); // ONLY the late-created provider was closed

    // Drain microtasks/timers so any retry creation surfaces, then settle it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 1; i < created; i++) resolvers[i]!(fakeProvider(closeCalls));
    expect(closeCalls.length).toBe(1); // fresh provider NOT auto-closed

    // Next getProvider never returns the closed singleton.
    const next = await getProvider(makeConfig(), factory);
    expect(next).not.toBe(closedProvider);
  });

  it('getProvider after a completed close recreates (never returns closed singleton)', async () => {
    const closeCalls: number[] = [];
    const first = await getProvider(makeConfig(), async () => fakeProvider(closeCalls));
    await closeProvider();
    const second = await getProvider(makeConfig(), async () => fakeProvider(closeCalls));
    expect(second).not.toBe(first);
  });
});
