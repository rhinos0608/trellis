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
    const cb = new CircuitBreaker({ windowSize: 4, failureThreshold: 0.5 });
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
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5 });
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
    const cb = new CircuitBreaker({ windowSize: 3, failureThreshold: 0.5 });
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
});
