/**
 * Unit tests for pi-northstar auto-detect, capabilities, factory fail-fast,
 * and the owner registry. No binary required. Default-off is asserted:
 * nothing here spawns a real process.
 */

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import type { TrellisConfig } from '../../../src/config/index.js';
import {
  createPiNorthstarProvider,
  createPiNorthstarProviderFromClient,
  isPiNorthstarEnabled,
  piNorthstarCapabilities,
  resolvePiNorthstarCommand,
  PI_NORTHSTAR_PROVIDER_NAME,
} from '../../../src/providers/piNorthstar/index.js';
import { createPiNorthstarClient } from '../../../src/providers/piNorthstar/client.js';
import type { PiNorthstarExecutor } from '../../../src/providers/piNorthstar/client.js';
import {
  getOwnedProvider,
  closeOwnedProvider,
  resetOwnerRegistryForTests,
} from '../../../src/providers/ownerRegistry.js';
import type { ProviderCallContext } from '../../../src/providers/types.js';

function baseConfig(overrides?: Partial<TrellisConfig['piNorthstar']>): TrellisConfig {
  return {
    storage: { dbPath: ':memory:' },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'node', args: [] },
    piNorthstar: { autoDetect: false, ...overrides },
    logLevel: 'silent',
  };
}

function ctx(): ProviderCallContext {
  return {
    signal: new AbortController().signal,
    runId: 'run-1',
    deadlineAt: Date.now() + 10_000,
    trace: { traceId: 't', spanId: 's' },
  };
}

/** Fake executor: status/config succeed; call returns canned details per tool. */
function fakeExecutor(): PiNorthstarExecutor {
  return (command, args) => {
    void command;
    if (args[args.length - 1] === 'status') {
      return Promise.resolve({
        stdout: JSON.stringify({ ok: true, data: { backend: 'native-cli' } }),
        stderr: '',
        exitCode: 0,
      });
    }
    const tool = args.includes('github')
      ? 'github'
      : args.includes('research')
        ? 'research'
        : args.includes('fetch')
          ? 'fetch'
          : args.includes('search')
            ? 'web_search'
            : undefined;
    let details: unknown = {};
    if (tool === 'web_search' || tool === 'research') {
      details = { results: [{ title: 'T', url: 'https://example.com/', snippet: 's' }] };
    } else if (tool === 'fetch') {
      details = { url: 'https://example.com/', title: 'T', content: 'body' };
    } else if (tool === 'github') {
      details = {
        entities: [{ title: 'README.md', url: 'https://github.com/o/r', repository: 'o/r' }],
      };
    }
    return Promise.resolve({
      stdout: JSON.stringify({ ok: true, data: { content: [], details } }),
      stderr: '',
      exitCode: 0,
    });
  };
}

afterEach(() => {
  resetOwnerRegistryForTests();
});

describe('isPiNorthstarEnabled', () => {
  it('defaults off (zero behavior change)', () => {
    expect(isPiNorthstarEnabled(baseConfig())).toBe(false);
  });

  it('on when autoDetect true', () => {
    expect(isPiNorthstarEnabled(baseConfig({ autoDetect: true }))).toBe(true);
  });
});

describe('resolvePiNorthstarCommand', () => {
  it('finds pi-northstar on PATH (single switch, no explicit override)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pns-'));
    const bin = join(dir, 'pi-northstar');
    writeFileSync(bin, '#!/bin/sh\necho hi\n');
    chmodSync(bin, 0o755);
    const r = resolvePiNorthstarCommand(baseConfig({ autoDetect: true }), {
      cwd: tmpdir(),
      pathEnv: dir,
    });
    expect(r.source).toBe('path');
    expect(r.command).toBe(bin);
  });

  it('finds a sibling checkout under the renamed Pi-Northstar directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'pns-sibling-'));
    const cwd = join(root, 'trellis');
    const binDir = join(root, 'Pi-Northstar', 'bin');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const script = join(binDir, 'pi-northstar.mjs');
    writeFileSync(script, 'console.log("ok");\n');
    const r = resolvePiNorthstarCommand(baseConfig({ autoDetect: true }), {
      cwd,
      pathEnv: '',
    });
    expect(r.source).toBe('sibling');
    expect(r.args).toEqual([script]);
  });

  it('fails closed with actionable error when nothing found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pns-empty-'));
    expect(() =>
      resolvePiNorthstarCommand(baseConfig({ autoDetect: true }), {
        cwd: dir,
        pathEnv: dir,
      }),
    ).toThrow(/no binary was found/);
  });
});

describe('piNorthstarCapabilities', () => {
  it('advertises P1 only: search/read/academic/code', () => {
    const caps = piNorthstarCapabilities();
    expect(caps.search).toBe(true);
    expect(caps.read).toBe(true);
    expect(caps.academic).toBe(true);
    expect(caps.code).toBe(true);
    expect(caps.community).toEqual({ reddit: false, hackernews: false, stackoverflow: false });
    expect(caps.media).toBe(false);
    expect(caps.reference).toBe(false);
    expect(caps.browser).toBe(false);
  });
});

describe('createPiNorthstarProvider', () => {
  it('fails fast when disabled (default off)', async () => {
    await expect(createPiNorthstarProvider(baseConfig())).rejects.toThrow(/disabled/);
  });

  it('fails closed when enabled but unresolvable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pns-empty-'));
    const realCwd = process.cwd();
    process.chdir(dir);
    try {
      await expect(
        createPiNorthstarProvider(baseConfig({ autoDetect: true })),
      ).rejects.toThrow(/no binary was found/);
    } finally {
      process.chdir(realCwd);
    }
  });

  it('serves P1 methods end to end via injected executor', async () => {
    const executor = fakeExecutor();
    const provider = await createPiNorthstarProvider(baseConfig({ autoDetect: true }), {
      executor,
      resolved: { command: 'pi-northstar', args: [], source: 'path' },
    });
    expect(provider.name).toBe(PI_NORTHSTAR_PROVIDER_NAME);

    expect(await provider.search(ctx(), 'q')).toHaveLength(1);
    const read = await provider.read(ctx(), 'https://example.com/');
    expect(read.content).toBe('body');
    const crawl = await provider.crawl(ctx(), 'https://example.com/');
    expect(crawl).toHaveLength(1);
    expect(await provider.academic(ctx(), 'q')).toHaveLength(1);
    expect(await provider.github(ctx(), 'q')).toHaveLength(1);
    // P1 scope: no out-of-scope methods advertised on the instance.
    expect(provider.reddit).toBeUndefined();
    expect(provider.youtube).toBeUndefined();
    expect(provider.browser).toBeUndefined();
    await provider.close?.();
  });

  it('from-client factory maps all P1 methods', async () => {
    const client = createPiNorthstarClient(
      { command: 'x', args: [], source: 'path' },
      { executor: fakeExecutor(), retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } },
    );
    const provider = createPiNorthstarProviderFromClient(client);
    expect(await provider.search(ctx(), 'q')).toHaveLength(1);
    expect((await provider.read(ctx(), 'https://example.com/')).content).toBe('body');
  });
});

describe('ownerRegistry', () => {
  it('shares one instance per name; close forgets it', async () => {
    let creations = 0;
    const factory = () => {
      creations++;
      const client = createPiNorthstarClient(
        { command: 'x', args: [], source: 'path' },
        { executor: fakeExecutor(), retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 } },
      );
      return Promise.resolve(createPiNorthstarProviderFromClient(client));
    };
    const a = await getOwnedProvider('pi-northstar', factory);
    const b = await getOwnedProvider('pi-northstar', factory);
    expect(a).toBe(b);
    expect(creations).toBe(1);
    await closeOwnedProvider('pi-northstar');
    await getOwnedProvider('pi-northstar', factory);
    expect(creations).toBe(2);
    await closeOwnedProvider();
  });
});
