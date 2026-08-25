/**
 * CircuitBreaker + retry composition tests (Phase 11B).
 * Contract: breaker OUTSIDE retry — an exhausted retry sequence counts as
 * exactly ONE breaker failure; an open breaker short-circuits before any
 * retry attempt.
 */

import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitBreakerOpenError } from '../../../src/research/retry.js';
import { wrapClientWithRetry } from '../../../src/providers/searchMcp/client.js';
import type { SearchMcpCallOptions, SearchMcpClient } from '../../../src/providers/searchMcp/client.js';

function callOptions(): SearchMcpCallOptions {
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 };
}

function failingClient(calls: { count: number }, err: () => Error): SearchMcpClient {
  return {
    async callTool() {
      calls.count += 1;
      throw err();
    },
    async close() {},
  };
}

describe('CircuitBreaker around wrapClientWithRetry', () => {
  it('counts an exhausted retry sequence as exactly ONE failure', async () => {
    const calls = { count: 0 };
    const client = failingClient(calls, () => new Error('socket hang up'));
    const retrying = wrapClientWithRetry(client, { maxRetries: 2, baseDelayMs: 1 });
    const breaker = new CircuitBreaker({ windowSize: 4, failureThreshold: 0.5, minimumSamples: 1 });

    await expect(
      breaker.execute(() => retrying.callTool('web_search', {}, callOptions())),
    ).rejects.toThrow('socket hang up');

    expect(calls.count).toBe(3); // initial + 2 retries all attempted
    expect((breaker as unknown as { window: unknown[] }).window).toHaveLength(1); // ONE failure recorded
  });

  it('short-circuits with CircuitBreakerOpenError once open, without calling the client', async () => {
    const calls = { count: 0 };
    const client = failingClient(calls, () => new Error('socket hang up'));
    const retrying = wrapClientWithRetry(client, { maxRetries: 2, baseDelayMs: 1 });
    const breaker = new CircuitBreaker({ windowSize: 2, failureThreshold: 0.5, minimumSamples: 1 });
    const guarded = (): Promise<unknown> =>
      breaker.execute(() => retrying.callTool('web_search', {}, callOptions()));

    await expect(guarded()).rejects.toThrow('socket hang up');
    await expect(guarded()).rejects.toThrow(CircuitBreakerOpenError);

    const callsAfterOpen = calls.count;
    expect(callsAfterOpen).toBe(3); // no further attempts once open
  });

  it('does not feed permanent errors into the breaker window', async () => {
    const calls = { count: 0 };
    const client = failingClient(calls, () => {
      const err = new Error('unauthorized');
      (err as unknown as Record<string, unknown>).response = { status: 401 };
      return err;
    });
    const retrying = wrapClientWithRetry(client, { maxRetries: 3, baseDelayMs: 1 });
    const breaker = new CircuitBreaker({ minimumSamples: 1 });

    await expect(
      breaker.execute(() => retrying.callTool('web_search', {}, callOptions())),
    ).rejects.toThrow('unauthorized');

    expect(calls.count).toBe(1); // permanent errors are not retried either
    expect((breaker as unknown as { window: unknown[] }).window).toHaveLength(0);
    expect(breaker.isOpen()).toBe(false);
  });

  it('records successes so isolated failures do not trip the breaker', async () => {
    let fail = true;
    const client: SearchMcpClient = {
      async callTool() {
        if (fail) throw new Error('socket hang up');
        return { data: {}, content: [] };
      },
      async close() {},
    };
    const retrying = wrapClientWithRetry(client, { maxRetries: 0, baseDelayMs: 1 });
    const breaker = new CircuitBreaker({ failureThreshold: 0.8 }); // default minimumSamples 5

    await expect(
      breaker.execute(() => retrying.callTool('web_search', {}, callOptions())),
    ).rejects.toThrow();
    fail = false;
    for (let i = 0; i < 6; i++) {
      await expect(
        breaker.execute(() => retrying.callTool('web_search', {}, callOptions())),
      ).resolves.toEqual({ data: {}, content: [] });
    }
    expect(breaker.isOpen()).toBe(false);
  });
});
