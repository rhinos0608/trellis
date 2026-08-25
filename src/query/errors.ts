/**
 * Typed errors for the query service. Mirrors store/eventErrors.ts style:
 * each error carries a machine-readable `code` and a `retryable` flag.
 */
import type { KnowledgeReadModelStatus } from '../store/readModel/types.js';

/**
 * Thrown when the knowledge read model is not queryable (status 'dirty',
 * or state row missing). Callers should trigger/await a rebuild and retry.
 */
export class ReadModelUnavailableError extends Error {
  readonly code = 'READ_MODEL_UNAVAILABLE';
  readonly retryable = true;

  constructor(readonly readModel: KnowledgeReadModelStatus) {
    super('Knowledge read model is unavailable; rebuild required');
    this.name = 'ReadModelUnavailableError';
  }
}

/** Thrown when an opaque pagination cursor fails validation. */
export class InvalidCursorError extends Error {
  readonly code = 'INVALID_CURSOR';
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

/** Thrown for malformed query inputs (bad limit, oversized search text). */
export class InvalidQueryError extends Error {
  readonly code = 'INVALID_QUERY';
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidQueryError';
  }
}
