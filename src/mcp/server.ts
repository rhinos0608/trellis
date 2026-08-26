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
import { initDb, closeDb, getDb } from '../store/db.js';
import { rebuildProjection } from '../store/projectionBuilder.js';
import { createRunService } from '../research/runService.js';
import { ResearchToolSchema, KnowledgeToolSchema } from './schemas.js';
import { handleResearchTool, type ResearchToolDeps } from './researchTool.js';
import { handleKnowledgeTool } from './knowledgeTool.js';
import type { ResearchProvider } from '../providers/types.js';
import { getProvider as getSharedProvider, closeProvider } from '../providers/searchMcp/owner.js';
import type { ProjectionState } from '../store/projectionState.js';
import { graphEventHandlers } from '../graph/index.js';
import { workspaceEventHandlers } from '../workspace/index.js';
import { TRELLIS_VERSION } from '../version.js';
import { getLatestEventCursor } from '../store/events.js';
import { createKnowledgeQueryService } from '../query/service.js';
import { queryEvents } from '../store/events.js';

// ── Merged handler registry for projection rebuilds ────────────────
const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

// ── Lazy cursor-invalidated projection cache ─────────────────────
let cachedState: ProjectionState | undefined;

function getState(): ProjectionState {
  const cursor = getLatestEventCursor() ?? 0;
  if (cachedState?.lastAppliedSeq !== cursor) {
    cachedState = rebuildProjection(ALL_HANDLERS);
  }
  return cachedState;
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

// ── Lazy provider init (process-wide shared owner) ────────────────
async function getProvider(): Promise<ResearchProvider> {
  return getSharedProvider(config);
}

// ── MCP Server ─────────────────────────────────────────────────────
const server = new McpServer({
  name: 'trellis',
  version: TRELLIS_VERSION,
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

function getQueryService() {
  const d = getDb();
  if (!d) throw new Error('Database not initialized');
  return createKnowledgeQueryService(d);
}

// ── knowledge tool ─────────────────────────────────────────────────
server.registerTool('knowledge', {
  title: 'Knowledge',
  description: 'Knowledge graph queries: families, threads, claims, evidence, contradictions, gaps, entity.',
  inputSchema: KnowledgeToolSchema,
}, async (input) => {
  const result = handleKnowledgeTool(input, { getState, get queryService() { return getQueryService(); }, queryEvents });
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
});

// ── Bootstrap ──────────────────────────────────────────────────────
let transport: StdioServerTransport | undefined;
async function main(): Promise<void> {
  transport = new StdioServerTransport();
  await server.connect(transport);
  runService.startScheduler();
  logger.info('Trellis MCP server started (2 tools: research, knowledge)');
}

// Shutdown handler — ordering: scheduler (aborts active runs, appends final
// RUN_INTERRUPTED events) → provider close → MCP transport close → DB LAST.
// Sets process.exitCode and lets the event loop drain; never process.exit().
let shuttingDown = false;
async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down Trellis MCP server');
  let firstError: unknown;
  const attempt = async (action: () => Promise<void>): Promise<void> => {
    try { await action(); } catch (err) { firstError ??= err; logger.warn({ err }, 'MCP teardown step failed'); }
  };
  await attempt(() => runService.shutdownScheduler());
  await attempt(() => closeProvider());
  await attempt(() => server.close());
  await attempt(async () => { await transport?.close(); });
  await attempt(async () => { closeDb(); });
  process.exitCode = firstError === undefined ? exitCode : 1;
}

process.once('SIGINT', () => {
  void shutdown(0);
});
process.once('SIGTERM', () => {
  void shutdown(0);
});
process.on('uncaughtException', (err: unknown) => {
  logger.fatal({ err }, 'Uncaught exception');
  void shutdown(1);
});
process.on('unhandledRejection', (err: unknown) => {
  logger.fatal({ err }, 'Unhandled rejection');
  void shutdown(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start Trellis MCP server');
  process.exit(1);
});
