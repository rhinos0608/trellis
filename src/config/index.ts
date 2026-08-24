/**
 * Trellis configuration loader.
 *
 * Resolution: .env file (via dotenv) → env vars → defaults.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import 'dotenv/config';
import { logger } from '../logger.js';

export interface TrellisConfig {
  storage: { dbPath: string };
  llm: { apiKey: string | undefined; baseUrl: string | undefined; model: string | undefined };
  searchProvider: { command: string; args: string[] };
  logLevel: string;
}

function envOrFallback(trellisKey: string, fallbackKey: string): string | undefined {
  return process.env[trellisKey] ?? process.env[fallbackKey];
}

function homedirPath(...segments: string[]): string {
  return join(homedir(), ...segments);
}

export function loadConfig(): TrellisConfig {
  // Resolve default DB directory, create if missing
  const defaultDbDir = homedirPath('.cache', 'trellis');
  if (!existsSync(defaultDbDir)) {
    mkdirSync(defaultDbDir, { recursive: true });
  }

  const storage: TrellisConfig['storage'] = {
    dbPath: process.env.TRELLIS_DB_PATH ?? homedirPath('.cache', 'trellis', 'trellis.db'),
  };

  const llm: TrellisConfig['llm'] = {
    apiKey: envOrFallback('TRELLIS_LLM_API_KEY', 'OPENAI_API_KEY'),
    baseUrl: envOrFallback('TRELLIS_LLM_BASE_URL', 'OPENAI_BASE_URL'),
    model: envOrFallback('TRELLIS_LLM_MODEL', 'OPENAI_MODEL'),
  };

  // search-mcp adapter: spawn as child process via stdio
  const searchMcpPath = process.env.TRELLIS_SEARCH_MCP_PATH ?? '';
  const searchProvider: TrellisConfig['searchProvider'] = {
    command: process.env.TRELLIS_SEARCH_MCP_COMMAND ?? 'node',
    args: searchMcpPath
      ? [searchMcpPath]
      : process.env.TRELLIS_SEARCH_MCP_ARGS?.split(' ').filter(Boolean) ?? [],
  };

  const logLevel: string = process.env.LOG_LEVEL ?? 'info';

  const config: TrellisConfig = { storage, llm, searchProvider, logLevel };

  logger.debug({ storage: storage.dbPath, logLevel }, 'Config loaded');
  return config;
}
