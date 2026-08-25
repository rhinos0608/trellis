/**
 * CLI output rendering — JSON envelope / human text + exit codes.
 *
 * Envelope shapes:
 *   success: { version: 1, ok: true, command, data }
 *   failure: { version: 1, ok: false, command, error: { code, message, retryable } }
 *
 * Exit codes: 0 success, 1 internal error, 2 usage error,
 *             3 integrity failure, 4 domain conflict, 130 interrupted.
 */

import { ApplicationError } from '../app/errors.js';
import { InvalidCursorError, InvalidQueryError, ReadModelUnavailableError } from '../query/errors.js';

export const EXIT_CODES = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  INTEGRITY: 3,
  CONFLICT: 4,
  INTERRUPTED: 130,
} as const;

/** Application-error codes that represent domain conflicts (exit 4). */
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  'CURATION_CONFLICT',
  'INVALID_TRANSITION',
  'STALE_PROJECTION',
  'IDEMPOTENCY_CONFLICT',
]);

export interface CliIo {
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  json: boolean;
}

/** Malformed invocation — always exit code 2. */
export class UsageError extends Error {
  readonly code = 'USAGE_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function errorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = err.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function isRetryable(err: unknown): boolean {
  return err !== null && typeof err === 'object' && 'retryable' in err && err.retryable === true;
}

function messageOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const message = err.message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

/**
 * Errors whose `message` is designed for external consumption (stable typed
 * application/query errors). Anything else is treated as an internal error:
 * its message may contain file paths or SQLite diagnostics and must not be
 * echoed into the machine-readable stdout envelope.
 */
function isSafeError(err: unknown): boolean {
  return (
    err instanceof UsageError ||
    err instanceof ApplicationError ||
    err instanceof ReadModelUnavailableError ||
    err instanceof InvalidCursorError ||
    err instanceof InvalidQueryError
  );
}

function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) return EXIT_CODES.USAGE;
  if (
    err instanceof Error &&
    (err.name === 'RunHistoryCorruptionError' ||
      err.name === 'EventReferenceInvalidError' ||
      err.name === 'EventTypeUnknownError' ||
      err.name === 'EventVersionUnsupportedError' ||
      err.name === 'EventPayloadInvalidError' ||
      /hash mismatch/i.test(err.message))
  ) {
    return EXIT_CODES.INTEGRITY;
  }
  const code = errorCode(err);
  if (code !== undefined && CONFLICT_CODES.has(code)) return EXIT_CODES.CONFLICT;
  return EXIT_CODES.INTERNAL;
}

function errorShape(err: unknown): { code: string; message: string; retryable: boolean } {
  return {
    code: errorCode(err) ?? 'INTERNAL',
    message: messageOf(err),
    retryable: isRetryable(err),
  };
}

/** One-line human rendering for common result shapes; falls back to pretty JSON. */
export function renderHuman(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return '(no results)';
    return data
      .map((item) => {
        if (item !== null && typeof item === 'object') {
          const rec = item as Record<string, unknown>;
          const asText = (value: unknown): string =>
            typeof value === 'string' || typeof value === 'number' ? String(value) : '';
          const id = asText(rec.id) || asText(rec.runId) || asText(rec.eventType);
          const label =
            asText(rec.query) || asText(rec.title) || asText(rec.url) || asText(rec.subjectText) || asText(rec.status);
          return `${id}\t${label}`.trim();
        }
        return JSON.stringify(item);
      })
      .join('\n');
  }
  return JSON.stringify(data, null, 2);
}

export function printResult(io: CliIo, data: unknown, command: string): void {
  if (io.json) {
    io.out.write(`${JSON.stringify({ version: 1, ok: true, command, data })}\n`);
    return;
  }
  io.out.write(`${renderHuman(data)}\n`);
}

export function printError(io: CliIo, err: unknown, command: string): number {
  const safe = isSafeError(err);
  const shape = safe
    ? errorShape(err)
    : // Internal/unexpected errors get a generic safe message; the real
      // diagnostics go to stderr only, never into the JSON stdout response.
      { code: 'INTERNAL_ERROR', message: 'An internal error occurred', retryable: false };
  if (!safe) {
    const stack = err instanceof Error && err.stack !== undefined ? `\n${err.stack}` : '';
    io.err.write(`internal error details: ${messageOf(err)}${stack}\n`);
  }
  if (io.json) {
    io.out.write(
      `${JSON.stringify({ version: 1, ok: false, command, error: shape })}\n`,
    );
  } else {
    io.err.write(`error [${shape.code}]: ${shape.message}\n`);
  }
  return exitCodeFor(err);
}
