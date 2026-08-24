/**
 * Trellis MCP server entrypoint.
 *
 * Boots the db, creates a RunService, registers exactly 2 tools:
 *   - `research` (start/status/cancel/rollback)
 *   - `knowledge` (families/threads/claims/evidence/contradictions/gaps/entity)
 *
 * Provider initialization is lazy: the server boots and exposes all
 * knowledge.* tools even without search-mcp configured. Only `research start`
 * actually needs the provider and fails with an actionable error at that point.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from '../logger.js';
import { loadConfig } from '../config/index.js';
import { initDb, closeDb } from '../store/db.js';
import { rebuildProjection } from '../store/projectionBuilder.js';
import { createRunService } from '../research/runService.js';
import { ResearchToolSchema, KnowledgeToolSchema } from './schemas.js';
import { handleResearchTool, type ResearchToolDeps } from './researchTool.js';
import { handleKnowledgeTool } from './knowledgeTool.js';
import type { ResearchProvider } from '../providers/types.js';
import type { ProjectionState } from '../store/projectionState.js';
import { graphEventHandlers } from '../graph/index.js';
import { workspaceEventHandlers } from '../workspace/index.js';

// ── Merged handler registry for projection rebuilds ────────────────
const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

function rebuildState(): ProjectionState {
  return rebuildProjection(ALL_HANDLERS);
}

// ── Init config + db (sync, always succeeds) ──────────────────────
const config = loadConfig();
const dbPath = config.storage.dbPath;
logger.info({ dbPath }, 'Initializing database');
const db = initDb(dbPath);
if (!db) {
  logger.fatal({ dbPath }, 'Failed to initialize database');
  process.exit(1);
}

// ── RunService (owns in-flight bookkeeping, not a global singleton) ──
const runService = createRunService();

// ── Lazy provider init ─────────────────────────────────────────────
let providerInstance: ResearchProvider | null = null;

async function getProvider(): Promise<ResearchProvider> {
  if (providerInstance) return providerInstance;

  const { args } = config.searchProvider;
  if (args.length === 0) {
    throw new Error(
      'Search provider not configured. Set TRELLIS_SEARCH_MCP_PATH to point at the search-mcp entrypoint, then retry.',
    );
  }

  try {
    const { createSearchMcpProvider } = await import('../providers/searchMcp/index.js');
    providerInstance = await createSearchMcpProvider(config);
    logger.info('Search provider initialized');
    return providerInstance;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to connect to search-mcp provider: ${msg}. Is search-mcp built and reachable?`,
    );
  }
}

// ── MCP Server ─────────────────────────────────────────────────────
const server = new McpServer({
  name: 'trellis',
  version: '0.1.0',
});

// ── research tool ──────────────────────────────────────────────────
const researchDeps: ResearchToolDeps = {
  runService,
  config,
  getProvider,
};

server.registerTool('research', {
  title: 'Research',
  description: 'Deep research actions: start, status, cancel, rollback.',
  inputSchema: ResearchToolSchema,
}, async (input) => {
  const result = await handleResearchTool(input, researchDeps);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
});

// ── knowledge tool ─────────────────────────────────────────────────
server.registerTool('knowledge', {
  title: 'Knowledge',
  description: 'Knowledge graph queries: families, threads, claims, evidence, contradictions, gaps, entity.',
  inputSchema: KnowledgeToolSchema,
}, async (input) => {
  let state: ProjectionState;
  try {
    state = rebuildState();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'knowledge tool: projection rebuild failed');
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Projection rebuild failed: ${msg}` }, null, 2) }] };
  }
  const result = handleKnowledgeTool(input, state);
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
});

// ── Bootstrap ──────────────────────────────────────────────────────
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Trellis MCP server started (2 tools: research, knowledge)');
}

// Shutdown handler
function shutdown(exitCode = 0): void {
  logger.info('Shutting down Trellis MCP server');
  closeDb();
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
