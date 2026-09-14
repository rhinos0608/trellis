import { describe, it, expect } from 'vitest';
import {
  classifyError,
  withRetry,
  CircuitBreaker,
  CircuitBreakerOpenError,
} from '../../src/research/retry.js';

describe('classifyError', () => {
  it('returns PERMANENT for non-Error', () => {
    expect(classifyError('string')).toBe('PERMANENT');
    expect(classifyError(42)).toBe('PERMANENT');
  });

  it('returns PERMANENT for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('returns TRANSIENT for 429 status', () => {
    const err = new Error('rate limited');
    (err as any).response = { status: 429 };
    expect(classifyError(err)).toBe('TRANSIENT');
  });

  it('returns TRANSIENT for 503 status', () => {
    const err = new Error('unavailable');
    (err as any).response = { status: 503 };
    expect(classifyError(err)).toBe('TRANSIENT');
  });

  it('returns PERMANENT for 400 status', () => {
    const err = new Error('bad request');
    (err as any).response = { status: 400 };
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('returns PERMANENT for 401 status', () => {
    const err = new Error('unauthorized');
    (err as any).response = { status: 401 };
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('returns PERMANENT for 403 status', () => {
    const err = new Error('forbidden');
    (err as any).response = { status: 403 };
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('returns TRANSIENT for ETIMEDOUT code', () => {
    const err = new Error('timed out') as NodeJS.ErrnoException;
    err.code = 'ETIMEDOUT';
    expect(classifyError(err)).toBe('TRANSIENT');
  });

  it('returns TRANSIENT for ECONNRESET code', () => {
    const err = new Error('reset') as NodeJS.ErrnoException;
    err.code = 'ECONNRESET';
    expect(classifyError(err)).toBe('TRANSIENT');
  });

  it('returns PERMANENT for ENOTFOUND code', () => {
    const err = new Error('not found') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('returns TRANSIENT for socket hang up message', () => {
    const err = new Error('socket hang up');
    expect(classifyError(err)).toBe('TRANSIENT');
  });

  it('classifies cause chain recursively', () => {
    const inner = new Error('inner') as NodeJS.ErrnoException;
    inner.code = 'ENOTFOUND';
    const outer = new Error('outer', { cause: inner });
    expect(classifyError(outer)).toBe('PERMANENT');
  });

  it('returns TRANSIENT for plain error with no signals', () => {
    const err = new Error('generic error');
    expect(classifyError(err)).toBe('TRANSIENT');
  });

  it('returns PERMANENT for MCP JSON-RPC Invalid params (-32602)', () => {
    const err = new Error('Invalid request parameters');
    (err as unknown as Record<string, unknown>).code = -32602;
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('returns PERMANENT for MCP JSON-RPC Invalid Request (-32600)', () => {
    const err = new Error('Invalid Request');
    (err as unknown as Record<string, unknown>).code = -32600;
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('returns PERMANENT for MCP JSON-RPC Parse error (-32700)', () => {
    const err = new Error('Parse error');
    (err as unknown as Record<string, unknown>).code = -32700;
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('JSON-RPC validation errors are not retried by withRetry', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          const err = new Error('Invalid params');
          (err as unknown as Record<string, unknown>).code = -32602;
          throw err;
        },
        { maxRetries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('Invalid params');
    expect(attempts).toBe(1);
  });

  it('honors classification carrier: PERMANENT short-circuits before status checks', () => {
    const err = new Error('rate limited') as Error & { response: { status: number } };
    err.response = { status: 429 };
    (err as unknown as Record<string, unknown>).classification = 'PERMANENT';
    expect(classifyError(err)).toBe('PERMANENT');
  });

  it('permanent envelope error does not feed the breaker window', async () => {
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5, minimumSamples: 1 });
    await expect(cb.execute(async () => {
      const err = new Error('pi-northstar call web_search failed: unknown_tool: nope');
      (err as unknown as Record<string, unknown>).classification = 'PERMANENT';
      (err as unknown as Record<string, unknown>).operation = 'callTool';
      throw err;
    })).rejects.toThrow(/unknown_tool/);
    expect((cb as unknown as { window: unknown[] }).window).toHaveLength(0);
    expect(cb.isOpen()).toBe(false);
  });

  it('circuit breaker ignores JSON-RPC validation errors', async () => {
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5, minimumSamples: 1 });
    await expect(cb.execute(async () => {
      const err = new Error('Invalid params');
      (err as unknown as Record<string, unknown>).code = -32602;
      throw err;
    })).rejects.toThrow('Invalid params');
    expect((cb as unknown as { window: unknown[] }).window).toHaveLength(0);
    expect(cb.isOpen()).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const result = await withRetry(async () => 42, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe(42);
  });

  it('retries on transient error then succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('rate limited');
          (err as any).response = { status: 429 };
          throw err;
        }
        return 'ok';
      },
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('throws after max retries exceeded', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('fail');
        },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('fail');
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('does not retry permanent errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          const err = new Error('bad request');
          (err as any).response = { status: 400 };
          throw err;
        },
        { maxRetries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('respects custom shouldRetry', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('custom');
        },
        {
          maxRetries: 3,
          baseDelayMs: 1,
          shouldRetry: () => false,
        },
      ),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it('respects AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withRetry(
        async () => {
          throw new Error('fail');
        },
        { maxRetries: 3, baseDelayMs: 1, signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
});

describe('CircuitBreaker', () => {
  it('starts closed (not open)', () => {
    const cb = new CircuitBreaker({ windowSize: 5, failureThreshold: 0.5 });
    expect(cb.isOpen()).toBe(false);
  });

  it('opens when failure threshold exceeded', () => {
    const cb = new CircuitBreaker({ windowSize: 4, failureThreshold: 0.5, minimumSamples: 1 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
  });

  it('stays closed when failures below threshold', () => {
    const cb = new CircuitBreaker({ windowSize: 10, failureThreshold: 0.5 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordSuccess();
    expect(cb.isOpen()).toBe(false);
  });

  it('execute rejects with CircuitBreakerOpenError when open', async () => {
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5, minimumSamples: 1 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    await expect(cb.execute(async () => 'ok')).rejects.toThrow(CircuitBreakerOpenError);
  });

  it('execute calls function and records success', async () => {
    const cb = new CircuitBreaker();
    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
    expect(cb.isOpen()).toBe(false);
  });

  it('execute records failure on throw', async () => {
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5 });
    try {
      await cb.execute(async () => { throw new Error('boom'); });
    } catch {
      // expected
    }
    // Should have recorded a failure
    const window = (cb as any).window as { success: boolean }[];
    expect(window.some((e) => !e.success)).toBe(true);
  });

  it('reset clears window', () => {
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5, minimumSamples: 1 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    cb.reset();
    expect(cb.isOpen()).toBe(false);
  });

  it('recovers after cooldown period', () => {
    const cb = new CircuitBreaker({
      windowSize: 3,
      failureThreshold: 0.5,
      cooldownMs: 1, // 1ms cooldown
      minimumSamples: 1,
    });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen()).toBe(true);
    // Wait for cooldown
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy wait */ }
    expect(cb.isOpen()).toBe(false);
  });

  it('does not open on a single failure below the minimum sample count', async () => {
    const cb = new CircuitBreaker({ windowSize: 10, failureThreshold: 0.8 }); // default minimumSamples 5
    await expect(cb.execute(async () => { throw new Error('transient'); })).rejects.toThrow('transient');
    expect(cb.isOpen()).toBe(false); // 100% of a 1-entry window must NOT trip it
    await expect(cb.execute(async () => 'ok')).resolves.toBe('ok');
  });

  it('opens once the failure rate exceeds threshold after minimum samples', async () => {
    const cb = new CircuitBreaker({ windowSize: 5, failureThreshold: 0.5, minimumSamples: 4 });
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure(); // 3/4 > 0.5 and window.length === minimumSamples
    expect(cb.isOpen()).toBe(true);
  });

  it('execute ignores permanent errors in the window', async () => {
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5, minimumSamples: 1 });
    const permanent = new Error('bad request');
    (permanent as unknown as Record<string, unknown>).response = { status: 400 };
    await expect(cb.execute(async () => { throw permanent; })).rejects.toThrow('bad request');
    expect((cb as unknown as { window: unknown[] }).window).toHaveLength(0);
    expect(cb.isOpen()).toBe(false);
  });

  it('execute ignores abort/cancellation errors in the window', async () => {
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5, minimumSamples: 1 });
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    await expect(cb.execute(async () => { throw abort; })).rejects.toThrow();
    expect((cb as unknown as { window: unknown[] }).window).toHaveLength(0);
    expect(cb.isOpen()).toBe(false);
  });

  it('window never exceeds windowSize entries', () => {
    const cb = new CircuitBreaker({ windowSize: 4, failureThreshold: 0.9, minimumSamples: 1 });
    for (let i = 0; i < 20; i++) {
      i % 2 === 0 ? cb.recordSuccess() : cb.recordFailure();
    }
    expect((cb as unknown as { window: unknown[] }).window).toHaveLength(4);
  });
});
