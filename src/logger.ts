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

export const isJsonMode: boolean =
  process.env.NODE_ENV === 'production' ||
  process.env.CI === 'true';

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
  },
  dest,
);
