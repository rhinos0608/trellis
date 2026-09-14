/**
 * Retry utilities — exponential backoff, error classification, circuit breaker.
 * Ported from search-mcp retry.ts.
 */

import { logger, safeErrorLog } from '../logger.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type ErrorClass = 'TRANSIENT' | 'PERMANENT';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal | undefined;
  shouldRetry?: ((err: unknown) => boolean) | undefined;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 16000;

// ── Custom Error ───────────────────────────────────────────────────────────

export class CircuitBreakerOpenError extends Error {
  constructor() {
    super('Circuit breaker is open');
    this.name = 'CircuitBreakerOpenError';
  }
}

// ── Error Classification ───────────────────────────────────────────────────

const TRANSIENT_STATUS_CODES = new Set([429, 503]);
const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404]);
const TRANSIENT_NODE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);
// JSON-RPC protocol errors carried by MCP McpError.code: parse/invalid
// request/invalid params are client-side validation failures — permanent.
const PERMANENT_JSONRPC_CODES = new Set([-32700, -32600, -32602]);

export function classifyError(err: unknown): ErrorClass {
  if (!(err instanceof Error)) return 'PERMANENT';
  // Carrier-field honor: callers attach `classification: 'PERMANENT'` to
  // deterministic failures (e.g. pi-northstar spawn ENOENT/EACCES, usage
  // envelopes). Must precede all other checks so these never retry or feed
  // the breaker window.
  if ((err as unknown as Record<string, unknown>).classification === 'PERMANENT') {
    return 'PERMANENT';
  }
  if (err.name === 'AbortError') return 'PERMANENT';

  const errRecord = err as unknown as Record<string, unknown>;
  // MCP JSON-RPC validation errors (e.g. malformed tool arguments arrive as
  // McpError with code -32602) must never be retried or fed to the breaker.
  const rpcCode = errRecord.code;
  if (typeof rpcCode === 'number' && PERMANENT_JSONRPC_CODES.has(rpcCode)) {
    return 'PERMANENT';
  }
  if (
    errRecord.response !== null &&
    errRecord.response !== undefined &&
    typeof errRecord.response === 'object'
  ) {
    const response = errRecord.response as Record<string, unknown>;
    const status =
      typeof response.status === 'number' ? response.status : undefined;
    if (status !== undefined) {
      if (TRANSIENT_STATUS_CODES.has(status)) return 'TRANSIENT';
      if (PERMANENT_STATUS_CODES.has(status)) return 'PERMANENT';
    }
  }

  const nodeErr = err as NodeJS.ErrnoException;
  if (nodeErr.code !== undefined) {
    if (TRANSIENT_NODE_CODES.has(nodeErr.code)) return 'TRANSIENT';
    if (nodeErr.code === 'ENOTFOUND') return 'PERMANENT';
  }

  const msg = err.message.toLowerCase();
  if (msg.includes('socket hang up') || msg.includes('econnreset'))
    return 'TRANSIENT';

  if (err.cause instanceof Error) return classifyError(err.cause);

  return 'TRANSIENT';
}

// ── Retry ──────────────────────────────────────────────────────────────────

function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const shouldRetry = options?.shouldRetry;
  const signal = options?.signal;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (err instanceof Error && err.name === 'AbortError') throw err;

      const retryable = shouldRetry
        ? shouldRetry(err)
        : classifyError(err) === 'TRANSIENT';
      if (!retryable || attempt >= maxRetries) throw err;

      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
      logger.warn(
        { ...safeErrorLog(err), attempt: attempt + 1, maxRetries, delayMs: delay, errorClassification: classifyError(err) },
        'Retrying after transient error',
      );
      await sleepWithSignal(delay, signal);
      if (signal?.aborted) throw signal.reason ?? err;
    }
  }
  throw lastError;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ── Circuit Breaker ────────────────────────────────────────────────────────

interface CircuitBreakerOptions {
  windowSize?: number;
  failureThreshold?: number;
  cooldownMs?: number;
  /** Minimum window entries before the failure rate may trip the breaker.
   *  Prevents a single failed call from opening it (100% of a 1-entry window). */
  minimumSamples?: number;
}

interface WindowEntry {
  success: boolean;
  timestamp: number;
}

export class CircuitBreaker {
  private readonly windowSize: number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly minimumSamples: number;
  private window: WindowEntry[] = [];
  private lastOpenAt: number | null = null;

  constructor(options?: CircuitBreakerOptions) {
    this.windowSize = options?.windowSize ?? 10;
    this.failureThreshold = options?.failureThreshold ?? 0.8;
    this.cooldownMs = options?.cooldownMs ?? 60000;
    this.minimumSamples = Math.min(options?.minimumSamples ?? 5, this.windowSize);
  }

  recordSuccess(): void {
    this.window.push({ success: true, timestamp: Date.now() });
    this.trimWindow();
  }

  recordFailure(): void {
    this.window.push({ success: false, timestamp: Date.now() });
    this.trimWindow();
  }

  isOpen(): boolean {
    this.trimWindow();
    if (this.window.length < this.minimumSamples) {
      this.lastOpenAt = null;
      return false;
    }
    const failureCount = this.window.filter((e) => !e.success).length;
    const failureRate = failureCount / this.window.length;
    if (failureRate > this.failureThreshold) {
      this.lastOpenAt ??= Date.now();
      if (Date.now() - this.lastOpenAt >= this.cooldownMs) {
        this.reset();
        return false;
      }
      return true;
    }
    this.lastOpenAt = null;
    return false;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isOpen()) throw new CircuitBreakerOpenError();
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      // Only transient dependency failures feed the window — permanent,
      // validation, and cancellation errors propagate untouched.
      if (classifyError(err) === 'TRANSIENT') this.recordFailure();
      throw err;
    }
  }

  reset(): void {
    this.window = [];
    this.lastOpenAt = null;
  }

  private trimWindow(): void {
    if (this.window.length > this.windowSize) {
      this.window = this.window.slice(-this.windowSize);
    }
  }
}
