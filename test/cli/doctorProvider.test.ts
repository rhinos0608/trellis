/**
 * `trellis doctor --provider` tests (Phase 11B).
 * runDoctor is invoked directly with injected provider deps so no real
 * search-mcp child process is spawned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, closeDb, getLatestEventCursor, rebuildProjection } from '../../src/store/index.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { rebuildKnowledgeReadModel } from '../../src/store/readModel/index.js';
import type { TrellisConfig } from '../../src/config/index.js';
import { createKnowledgeQueryService } from '../../src/query/service.js';
import { createCurationApplicationService } from '../../src/app/curationService.js';
import { runDoctor, type DoctorProviderDeps } from '../../src/cli/commands/operations.js';
import type { CommandContext, CliRuntime } from '../../src/cli/runtime.js';
import type { CliIo } from '../../src/cli/output.js';
import type { ResearchProvider } from '../../src/providers/types.js';

class StringWriter {
  private readonly parts: string[] = [];
  write(chunk: unknown): boolean {
    this.parts.push(String(chunk));
    return true;
  }
  get value(): string {
    return this.parts.join('');
  }
}

let tempDir: string;
let dbPath: string;
let ctx: CommandContext;

function makeIo(json: boolean): { io: CliIo; out: StringWriter } {
  const out = new StringWriter();
  return { io: { out: out as unknown as NodeJS.WritableStream, err: out as unknown as NodeJS.WritableStream, json }, out };
}

function makeConfig(overrides?: Partial<TrellisConfig['searchProvider']>): TrellisConfig {
  return {
    storage: { dbPath },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'node', args: ['/fake/search-mcp.js'], ...overrides },
    piNorthstar: { autoDetect: false },
    logLevel: 'error',
  };
}

function healthyProvider(): ResearchProvider {
  return {
    name: 'search-mcp',
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
    async search() { return []; },
    async read() { throw new Error('unused'); },
    async crawl() { return []; },
    async academic() { return []; },
    close: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-doctor-'));
  dbPath = path.join(tempDir, 'trellis.db');
  const db = initDb(dbPath);
  if (db === null) throw new Error('initDb failed');
  // Same startup heal a writable runtime performs — otherwise the read model
  // sits at 'dirty' and every doctor run reports an unrelated error.
  const handlers = { ...graphEventHandlers, ...workspaceEventHandlers };
  rebuildProjection(handlers);
  rebuildKnowledgeReadModel(handlers);
  const rt: CliRuntime = {
    db,
    dbPath,
    query: createKnowledgeQueryService(db),
    curation: createCurationApplicationService({ handlers }),
    config: makeConfig(),
  };
  ctx = { io: makeIo(true).io, rt, values: {}, positionals: [] };
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

interface DoctorBody {
  ok: boolean;
  data: { overall: string; checks: { name: string; status: string; detail: string }[] };
}

function parseDoctor(out: string): DoctorBody {
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '') as DoctorBody;
}

describe('trellis doctor --provider', () => {
  it('reports ok with discovered capabilities when provider is healthy', async () => {
    ctx.values.provider = true;
    const provider = healthyProvider();
    const createProvider = vi.fn(async () => provider);
    const code = await runDoctor(ctx, { createProvider });

    expect(code).toBe(0);
    expect(createProvider).toHaveBeenCalledTimes(1);
    const body = parseDoctor((ctx.io.out as unknown as StringWriter).value);
    const check = body.data.checks.find((c) => c.name === 'provider');
    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('"search":true');
    // Probe connection must be closed — never left dangling.
    expect(provider.close).toHaveBeenCalled();
  });

  it('reports warning when the provider is not configured (and never constructs one)', async () => {
    ctx.rt.config = makeConfig({ args: [] });
    ctx.values.provider = true;
    const createProvider = vi.fn(async () => healthyProvider());
    const code = await runDoctor(ctx, { createProvider });

    expect(code).toBe(0); // warning, not error
    expect(createProvider).not.toHaveBeenCalled();
    const body = parseDoctor((ctx.io.out as unknown as StringWriter).value);
    const check = body.data.checks.find((c) => c.name === 'provider');
    expect(check?.status).toBe('warning');
    expect(check?.detail).toContain('not configured');
  });

  it('reports error when configured but unreachable', async () => {
    ctx.values.provider = true;
    const createProvider = vi.fn(async () => {
      throw new Error('Failed to connect to search-mcp provider: spawn failed');
    });
    const code = await runDoctor(ctx, { createProvider });

    expect(code).toBe(3); // EXIT_CODES.INTEGRITY
    const body = parseDoctor((ctx.io.out as unknown as StringWriter).value);
    const check = body.data.checks.find((c) => c.name === 'provider');
    expect(check?.status).toBe('error');
    expect(check?.detail).toContain('Failed to connect');
  });

  it('reports error when required tools are missing at handshake', async () => {
    ctx.values.provider = true;
    const createProvider = vi.fn(async () => {
      throw new Error('search-mcp server is missing required tool(s): web_search, web_crawl.');
    });
    await runDoctor(ctx, { createProvider });

    const body = parseDoctor((ctx.io.out as unknown as StringWriter).value);
    const check = body.data.checks.find((c) => c.name === 'provider');
    expect(check?.status).toBe('error');
    expect(check?.detail).toContain('missing required tool(s)');
  });

  it('bounds the probe with a timeout instead of hanging', async () => {
    ctx.values.provider = true;
    const createProvider = vi.fn(
      () => new Promise<ResearchProvider>(() => {}), // never settles
    );
    const started = Date.now();
    const code = await runDoctor(ctx, { createProvider, timeoutMs: 50 });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(code).toBe(3);
    const body = parseDoctor((ctx.io.out as unknown as StringWriter).value);
    const check = body.data.checks.find((c) => c.name === 'provider');
    expect(check?.detail).toContain('timed out');
  });

  it('closes the late-created provider when the handshake times out (no child-process leak)', async () => {
    ctx.values.provider = true;
    const provider = healthyProvider();
    let release: ((p: ResearchProvider) => void) | undefined;
    const createProvider = vi.fn(
      () => new Promise<ResearchProvider>((resolve) => { release = resolve; }),
    );
    const code = await runDoctor(ctx, { createProvider, timeoutMs: 30 });
    expect(code).toBe(3);

    // Creation resolves AFTER the reported timeout — must still be closed.
    release!(provider);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.close).toHaveBeenCalledTimes(1);
  });

  it('logs but does not crash when the late provider close fails', async () => {
    ctx.values.provider = true;
    const provider = healthyProvider();
    (provider.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('close blew up'));
    let release: ((p: ResearchProvider) => void) | undefined;
    const createProvider = vi.fn(
      () => new Promise<ResearchProvider>((resolve) => { release = resolve; }),
    );
    await runDoctor(ctx, { createProvider, timeoutMs: 30 });

    release!(provider);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(provider.close).toHaveBeenCalledTimes(1); // attempted, failure swallowed
  });

  it('default doctor (no --provider) never attempts a provider connection', async () => {
    const createProvider = vi.fn(async () => healthyProvider());
    const deps: DoctorProviderDeps = { createProvider };
    const code = await runDoctor(ctx, deps);

    expect(code).toBe(0);
    expect(getLatestEventCursor()).toBeNull(); // empty DB still fine
    expect(createProvider).not.toHaveBeenCalled();
    const body = parseDoctor((ctx.io.out as unknown as StringWriter).value);
    expect(body.data.checks.find((c) => c.name === 'provider')).toBeUndefined();
  });
});
