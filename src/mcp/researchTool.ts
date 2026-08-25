/**
 * Research tool handler — thin MCP adapter over the transport-independent
 * ResearchApplicationService (src/app). All run-lifecycle, listing, and
 * history logic lives there; this module only maps DTOs to the MCP wire
 * format and converts typed application errors to the existing
 * `{ error: message }` response shape.
 *
 * Provider initialization is lazy: the server boots without a provider;
 * only `start` actually needs it and fails with an actionable error if
 * the search-mcp backend isn't configured or reachable.
 */

import type { RunService } from '../research/runService.js';
import type { ResearchProvider } from '../providers/types.js';
import type { TrellisConfig } from '../config/index.js';
import type { ResearchToolInput } from './schemas.js';
import { createResearchApplicationService } from '../app/index.js';
import { logger } from '../logger.js';

export interface ResearchToolDeps {
  runService: RunService;
  config: TrellisConfig;
  /** Resolved lazily — only needed for `start`. */
  getProvider(): Promise<ResearchProvider>;
}

export async function handleResearchTool(
  input: ResearchToolInput,
  deps: ResearchToolDeps,
): Promise<Record<string, unknown>> {
  const app = createResearchApplicationService(deps);
  try {
    switch (input.action) {
      case 'start': {
        return await app.startRun({
          query: input.query,
          ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.familyId !== undefined ? { familyId: input.familyId } : {}),
        });
      }

      case 'status': {
        const run = app.getRun(input.runId);
        if (!run) return { found: false, error: `Run not found: ${input.runId}` };
        return { found: true, ...run };
      }

      case 'cancel': {
        return await app.cancelRun(input.runId);
      }

      case 'list': {
        return { runs: app.listRuns({
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.familyId !== undefined ? { familyId: input.familyId } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
        }) };
      }

      case 'history': {
        return { ...app.getRunHistory(input.runId, {
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }) };
      }

      case 'continue': {
        return await app.continueResearch({
          familyId: input.familyId,
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        });
      }

      case 'retry': {
        const result = await app.retryRun({
          runId: input.runId,
          ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.deadlineMs !== undefined ? { deadlineMs: input.deadlineMs } : {}),
        });
        return { runId: result.runId, familyId: result.familyId, deduplicated: result.deduplicated };
      }

      case 'rollback': {
        return { ...app.rollbackRun(input.runId) };
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ action: input.action, err: msg }, 'research tool: action failed');
    return { error: msg };
  }
}
