/**
 * Unit tests for the pi-northstar CLI client. No binary required —
 * the process runner is injected.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPiNorthstarEnv,
  createPiNorthstarClient,
  parseCallOutput,
  type PiNorthstarExecResult,
  type PiNorthstarExecutor,
  type ResolvedPiNorthstar,
} from '../../../src/providers/piNorthstar/client.js';
import type { ProviderCallContext } from '../../../src/providers/types.js';

function ctx(overrides?: Partial<ProviderCallContext>): ProviderCallContext {
  return {
    signal: new AbortController().signal,
    runId: 'run-1',
    deadlineAt: Date.now() + 10_000,
    trace: { traceId: 't', spanId: 's' },
    ...overrides,
  };
}

function okExec(data: unknown): PiNorthstarExecResult {
  return { stdout: JSON.stringify({ ok: true, data }), stderr: '', exitCode: 0 };
}

function errExec(code: string, message: string): PiNorthstarExecResult {
  return {
    stdout: JSON.stringify({ ok: false, error: { code, message } }),
    stderr: '',
    exitCode: 0,
  };
}

const RESOLVED: ResolvedPiNorthstar = { command: 'pi-northstar', args: [], source: 'path' };

describe('parseCallOutput', () => {
  it('unwraps ok envelope', () => {
    const out = parseCallOutput('web_search', okExec({ content: [], details: { a: 1 } }));
    expect(out.data).toEqual({ content: [], details: { a: 1 } });
    expect(out.content).toEqual([]);
  });

  it('classifies usage errors PERMANENT (fail fast, no retry)', () => {
    for (const code of ['unknown_command', 'unknown_tool', 'invalid_request', 'validation_error']) {
      try {
        parseCallOutput('web_search', errExec(code, 'bad'));
        expect.unreachable();
      } catch (err: unknown) {
        expect((err as Record<string, unknown>).classification).toBe('PERMANENT');
      }
    }
  });

  it('leaves infra errors retryable', () => {
    try {
      parseCallOutput('web_search', errExec('backend_timeout', 'boom'));
      expect.unreachable();
    } catch (err: unknown) {
      expect((err as Record<string, unknown>).classification).not.toBe('PERMANENT');
      expect(err instanceof Error && err.message).toContain('backend_timeout');
    }
  });

  it('throws on non-JSON output', () => {
    expect(() => parseCallOutput('x', { stdout: 'not json', stderr: '', exitCode: 0 })).toThrow(
      /non-JSON/,
    );
    expect(() => parseCallOutput('x', { stdout: '', stderr: 'usage...', exitCode: 2 })).toThrow(
      /exit 2/,
    );
  });
});

describe('buildPiNorthstarEnv', () => {
  it('forwards only PI_SEARCH_* (no PATH, no secrets)', () => {
    const env = buildPiNorthstarEnv({
      PI_SEARCH_FOO: '1',
      TRELLIS_LLM_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret2',
      PATH: '/usr/bin',
      HOME: '/root',
    });
    expect(env).toEqual({ PI_SEARCH_FOO: '1' });
  });
});

describe('createPiNorthstarClient', () => {
  it('spawns `call TOOL JSON_ARGS` and unwraps', async () => {
    const seen: string[][] = [];
    const executor: PiNorthstarExecutor = (command, args) => {
      seen.push([command, ...args]);
      return Promise.resolve(okExec({ content: [], details: { results: [] } }));
    };
    const client = createPiNorthstarClient(RESOLVED, {
      executor,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
    });
    const out = await client.callTool('web_search', { query: 'q' }, ctx());
    expect(out.data).toEqual({ content: [], details: { results: [] } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(0, 3)).toEqual(['pi-northstar', 'call', 'web_search']);
    expect(JSON.parse(seen[0]?.[3] ?? '{}')).toEqual({ query: 'q' });
    await client.close();
  });

  it('does not retry PERMANENT errors (fail fast)', async () => {
    let calls = 0;
    const executor: PiNorthstarExecutor = () => {
      calls++;
      return Promise.resolve(errExec('unknown_tool', 'nope'));
    };
    const client = createPiNorthstarClient(RESOLVED, {
      executor,
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    await expect(client.callTool('nope', {}, ctx())).rejects.toThrow(/unknown_tool/);
    expect(calls).toBe(1);
  });

  it('retries transient errors', async () => {
    let calls = 0;
    const executor: PiNorthstarExecutor = () => {
      calls++;
      if (calls === 1) return Promise.resolve(errExec('backend_timeout', 'flake'));
      return Promise.resolve(okExec({ content: [], details: {} }));
    };
    const client = createPiNorthstarClient(RESOLVED, {
      executor,
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    await client.callTool('web_search', { query: 'q' }, ctx());
    expect(calls).toBe(2);
  });

  it('passes deadline-derived timeout to the executor', async () => {
    let timeoutMs = -1;
    const executor: PiNorthstarExecutor = (_c, _a, opts) => {
      timeoutMs = opts.timeoutMs;
      return Promise.resolve(okExec({ content: [], details: {} }));
    };
    const client = createPiNorthstarClient(RESOLVED, {
      executor,
      retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 2 },
    });
    await client.callTool('web_search', {}, ctx({ deadlineAt: Date.now() + 5000 }));
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(5000);
  });

  it('propagates abort without retry', async () => {
    const controller = new AbortController();
    let calls = 0;
    const executor: PiNorthstarExecutor = (_c, _a, opts) => {
      calls++;
      controller.abort(new Error('stop'));
      return Promise.reject(opts.signal.reason ?? new Error('Aborted'));
    };
    const client = createPiNorthstarClient(RESOLVED, {
      executor,
      retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    await expect(
      client.callTool('web_search', {}, ctx({ signal: controller.signal })),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
