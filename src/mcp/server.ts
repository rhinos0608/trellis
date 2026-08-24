/**
 * Trellis MCP server entrypoint.
 *
 * Boots with zero tools registered — tool registration is Worker 8's job.
 * Just proves the process starts, logs a startup message, and connects the
 * stdio transport without crashing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config/index.js';

void loadConfig(); // validate config on startup

const server = new McpServer({
  name: 'trellis',
  version: '0.1.0',
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Trellis MCP server started');
}

// Shutdown handler
function shutdown(exitCode = 0): void {
  logger.info('Shutting down Trellis MCP server');
  if (exitCode !== 0) process.exit(exitCode);
}

process.on('SIGINT', () => {
  shutdown(0);
});
process.on('SIGTERM', () => {
  shutdown(0);
});
process.on('uncaughtException', (err: unknown) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdown(1);
});
process.on('unhandledRejection', (err: unknown) => {
  logger.fatal({ err }, 'Unhandled rejection');
  shutdown(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start Trellis MCP server');
  process.exit(1);
});
