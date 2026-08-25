/**
 * Application-level typed errors — stable `code`, safe `message`,
 * `retryable` flag, optional safe `details`.
 *
 * Transport adapters (MCP, SSE, CLI) catch these and shape them for
 * their own wire format; the application layer throws typed errors
 * and never returns generic `{ error: message }` records itself.
 */

export interface ApplicationErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown> | undefined;
}

export class ApplicationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: ApplicationErrorOptions = {}) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ApplicationError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) this.details = options.details;
  }
}

/** Lookup found no run — safe to surface as "not found" to any consumer. */
export class RunNotFoundError extends ApplicationError {
  override readonly code = 'RUN_NOT_FOUND';
  constructor(runId: string) {
    super('RUN_NOT_FOUND', `Run not found: ${runId}`, { details: { runId } });
    this.name = 'RunNotFoundError';
  }
}

/** Lookup found no requested knowledge entity. */
export class EntityNotFoundError extends ApplicationError {
  override readonly code = 'ENTITY_NOT_FOUND';
  constructor(kind: 'claim' | 'source', id: string) {
    super('ENTITY_NOT_FOUND', `${kind.charAt(0).toUpperCase()}${kind.slice(1)} not found: ${id}`, { details: { kind, id } });
    this.name = 'EntityNotFoundError';
  }
}

/** Action requested on a run whose lifecycle state forbids it (e.g. retrying a completed run). */
export class InvalidTransitionError extends ApplicationError {
  override readonly code = 'INVALID_TRANSITION';
  constructor(message: string, details?: Record<string, unknown>) {
    super('INVALID_TRANSITION', message, { details });
    this.name = 'InvalidTransitionError';
  }
}

/** Optimistic-concurrency failure between the caller's expected cursor and
 * the rebuilt projection — re-exported from the store layer so application
 * consumers only import from `src/app`. */
export { StaleProjectionError } from '../store/eventErrors.js';
/** Idempotency-key reuse with a different request — re-exported from research. */
export { IdempotencyConflictError } from '../research/scheduler.js';

/** Domain conflict — e.g. merging a pair twice, cross-family merge, invalid split partition. */
export class CurationConflictError extends ApplicationError {
  override readonly code = 'CURATION_CONFLICT';
  constructor(message: string, details?: Record<string, unknown>) {
    super('CURATION_CONFLICT', message, { details });
    this.name = 'CurationConflictError';
  }
}

/** Precondition failure — target not found, not active, or not in a curatable lifecycle state. */
export class CurationPreconditionError extends ApplicationError {
  override readonly code = 'CURATION_PRECONDITION';
  constructor(message: string, details?: Record<string, unknown>) {
    super('CURATION_PRECONDITION', message, { details });
    this.name = 'CurationPreconditionError';
  }
}

/**
 * Wrap internal errors into the stable application-error shape so raw
 * internal error types never leak past the application boundary.
 */
export function toApplicationError(err: unknown): ApplicationError {
  if (err instanceof ApplicationError) return err;

  // Lazy import avoidance: compare by name to keep this module dependency-light
  // while still recognising known internal error types.
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'StaleProjectionError') {
    return new ApplicationError('STALE_PROJECTION', message, { retryable: true });
  }
  if (name === 'IdempotencyConflictError') {
    return new ApplicationError('IDEMPOTENCY_CONFLICT', message);
  }
  return new ApplicationError('INTERNAL', message);
}
