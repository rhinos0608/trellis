import { describe, expect, it } from 'vitest';
import { InvalidCursorError, InvalidQueryError, ReadModelUnavailableError } from '../../src/query/errors.js';

describe('query error contracts', () => {
  it('ReadModelUnavailableError carries the read model status and is retryable', () => {
    const status = { version: 1, lastAppliedSeq: 42, status: 'dirty' as const };
    const err = new ReadModelUnavailableError(status);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReadModelUnavailableError');
    expect(err.code).toBe('READ_MODEL_UNAVAILABLE');
    expect(err.retryable).toBe(true);
    expect(err.readModel).toEqual(status);
    expect(err.message).toContain('rebuild');
  });

  it('InvalidCursorError is non-retryable with code INVALID_CURSOR', () => {
    const err = new InvalidCursorError('bad cursor');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidCursorError');
    expect(err.code).toBe('INVALID_CURSOR');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('bad cursor');
  });

  it('InvalidQueryError is non-retryable with code INVALID_QUERY', () => {
    const err = new InvalidQueryError('bad limit');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InvalidQueryError');
    expect(err.code).toBe('INVALID_QUERY');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('bad limit');
  });
});
