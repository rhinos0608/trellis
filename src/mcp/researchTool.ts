/**
 * Research tool handler — dispatches start/status/cancel/rollback actions.
 *
 * Provider initialization is lazy: the server boots without a provider;
 * only `start` actually needs it and fails with an actionable error if
 * the search-mcp backend isn't configured or reachable.
 */

import type { RunService, RunStatus } from '../research/runService.js';
import type { ResearchProvider } from '../providers/types.js';
import type { TrellisConfig } from '../config/index.js';
import type { ResearchToolInput } from './schemas.js';
import { rollbackRunById } from '../research/runService.js';
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
  try {
    switch (input.action) {
      case 'start': {
        const provider = await deps.getProvider();
        const result = await deps.runService.startRun({
          query: input.query,
          provider,
          config: deps.config,
          ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
          ...(input.depth !== undefined ? { depth: input.depth } : {}),
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.familyId !== undefined ? { explicitFamilyId: input.familyId } : {}),
        });
        return { runId: result.runId, familyId: result.familyId };
      }

      case 'status': {
        const status: RunStatus | null = deps.runService.getStatus(input.runId);
        if (!status) return { found: false, error: `Run not found: ${input.runId}` };
        return { found: true, ...status };
      }

      case 'cancel': {
        const cancelled = deps.runService.cancelRun(input.runId);
        return { cancelled };
      }

      case 'rollback': {
        const outcome = rollbackRunById(input.runId);
        return {
          skipped: outcome.skipped,
          executed: outcome.executed,
          blocked: outcome.blocked,
        };
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ action: input.action, err: msg }, 'research tool: action failed');
    return { error: msg };
  }
}
