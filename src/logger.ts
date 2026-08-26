// Pino logger that always writes to stderr (fd 2).
// stdout is reserved for MCP JSON-RPC protocol messages.
//
// Production / CI: structured JSON output
// Development:     human-readable via pino-pretty
//
// Usage:
//   logger.info({ tool: 'web_search', query }, 'Tool invoked')
//   logger.error({ err, tool: 'web_read', url }, 'Tool failed')

import pino, { type DestinationStream } from 'pino';
import { TRELLIS_VERSION } from './version.js';

export const isJsonMode: boolean =
  process.env.NODE_ENV === 'production' ||
  process.env.CI === 'true';

/** Known sensitive key paths censored via Pino's built-in redact. */
export const REDACT_PATHS: readonly string[] = [
  'apiKey',
  'apiToken',
  'authorization',
  'Authorization',
  'headers.authorization',
  'headers.Authorization',
  'req.headers.authorization',
  'config.llm.apiKey',
  'config.llm.apiToken',
  'llm.apiKey',
  'llm.apiToken',
];

const dest: DestinationStream = isJsonMode
  ? pino.destination({ fd: 2, sync: false })
  : (pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        destination: 2, // stderr
      },
    }) as DestinationStream);

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'trellis', version: TRELLIS_VERSION },
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
  },
  dest,
);

/**
 * Extract safe fields from an error for logging — never includes raw
 * provider response bodies or full serialized error objects. Only safe
 * name/classification fields are kept; message content is omitted to
 * prevent leaking provider response bodies.
 */
export function safeErrorLog(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessageLength: err.message.length,
    };
  }
  return { errorName: 'Unknown', errorMessageLength: String(err).length };
}
