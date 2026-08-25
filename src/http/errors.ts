import { logger } from '../logger.js';
import { ApplicationError, InvalidTransitionError, RunNotFoundError } from '../app/errors.js';
import { InvalidCursorError, InvalidQueryError, ReadModelUnavailableError } from '../query/errors.js';

export interface HttpErrorBody { error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> } }
export interface MappedError { status: number; body: HttpErrorBody }
export function mapError(error: unknown): MappedError {
  if (error instanceof Error && error.name === 'ZodError') return mapped(400, 'INVALID_REQUEST', error.message, false);
  if (error instanceof RunNotFoundError) return mapped(404, error.code, error.message, false, error.details);
  if (error instanceof InvalidTransitionError) return mapped(409, error.code, error.message, false, error.details);
  if (error instanceof ReadModelUnavailableError) {
    logger.error({ err: error }, 'HTTP request failed');
    return mapped(503, error.code, error.message, true, { readModel: error.readModel });
  }
  if (error instanceof InvalidCursorError || error instanceof InvalidQueryError) return mapped(400, error.code, error.message, false);
  if (error instanceof ApplicationError) {
    const status = error.code === 'NOT_FOUND' ? 404 : 500;
    if (status >= 500) logger.error({ err: error }, 'HTTP request failed');
    return mapped(status, error.code, error.message, error.retryable, error.details);
  }
  logger.error({ err: error }, 'HTTP request failed');
  return mapped(500, 'INTERNAL', 'Internal server error', false);
}
function mapped(status: number, code: string, message: string, retryable: boolean, details?: Record<string, unknown>): MappedError { return { status, body: { error: { code, message, retryable, ...(details ? { details } : {}) } } }; }
export function validationError(error: unknown): MappedError { const message = error instanceof Error ? error.message : 'Invalid request'; return mapped(400, 'INVALID_REQUEST', message, false); }
