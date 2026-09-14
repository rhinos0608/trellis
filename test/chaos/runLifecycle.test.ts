/**
 * Chaos tests: end-to-end run terminal consistency under a flaky provider.
 *
 * Recovery case: transient failures within retry budget → RUN_COMPLETED.
 * Exhaustion case: failures exceed budget → RUN_COMPLETED with empty findings
 *   (pipeline strategy is fault-tolerant, catches provider errors internally).
 *
 * Only the underlying client.callTool is faked; wrapClientWithRetry,
 * provider factory, and RunService are exercised for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearchMcpProviderFromClient } from '../../src/providers/searchMcp/index.js';
import {
  wrapClientWithRetry,
  type SearchMcpClient,
  type ToolCallResult,
} from '../../src/providers/searchMcp/client.js';
import { createRunService } from '../../src/research/runService.js';
import { initDb, closeDb, queryEvents, rebuildProjection, computeProjectionChecksum } from '../../src/store/index.js';
import { verifyProjectionIntegrity } from '../../src/store/projectionIntegrity.js';
import { verifyKnowledgeReadModel, rebuildKnowledgeReadModel } from '../../src/store/readModel/index.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';

// Mock LlmClient so agent strategy doesn't need real LLM config
vi.mock('../../src/research/llm/client.js', () => {
  const planResponse = { success: true, content: 'THOUGHT: planning\nPLAN: {"scope": "test", "perspectives": [{"name": "s", "question": "q"}]}', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  const searchResponse = { success: true, content: 'THOUGHT: search\nACTION: search_web\nARGUMENTS: {"query": "test"}', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  const answerResponse = { success: true, content: 'THOUGHT: done\nANSWER: Done.', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  let callCount = 0;
  return {
    LlmClient: class { _callCount = 0; callOrchestrator = async () => { this._callCount++; if (this._callCount === 1) return planResponse; return searchResponse; }; callWorker = async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0 }); reset() { this._callCount = 0; } },
    parseJsonFromText: (s) => { try { return JSON.parse(s); } catch { return undefined; } },
  };
});

// ── Shared constants ────────────────────────────────────────────────

const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

const FULL_TOOL_NAMES = [
  'web_search', 'web_crawl', 'research', 'github',
  'reddit', 'youtube', 'browser', 'semantic_crawl',
];

// ── Flaky client factory ────────────────────────────────────────────

function createFlakyClient(
  failCount: number,
): { client: SearchMcpClient; closeCount: { value: number } } {
  let callCount = 0;
  const closeCount = { value: 0 };
  const client: SearchMcpClient = {
    async callTool(_name: string, _args: Record<string, unknown>, _options: { signal: AbortSignal; deadlineAt: number }): Promise<ToolCallResult> {
      callCount++;
      if (callCount <= failCount) {
        throw new Error('ECONNRESET'); // transient → retried by withRetry
      }
      return { data: { results: [] }, content: [] };
    },
    async close() {
      closeCount.value++;
    },
  };
  return { client, closeCount };
}

// ── Config helper ───────────────────────────────────────────────────

function makeConfig(dbPath: string): TrellisConfig {
  return {
    storage: { dbPath },
    llm: { apiKey: undefined, baseUrl: 'http://mock-llm', model: 'test-model' },
    searchProvider: { command: 'echo', args: [] },
    piNorthstar: { autoDetect: false },
    logLevel: 'silent',
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('run lifecycle chaos: flaky provider', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-run-lifecycle-'));
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('recovery: transient failures within retry budget → RUN_COMPLETED', async () => {
    const dbPath = path.join(tmpDir, 'recovery.db');
    initDb(dbPath);
    const config = makeConfig(dbPath);

    // Fail 2 times then succeed (within default maxRetries=3)
    const { client, closeCount } = createFlakyClient(2);
    const wrapped = wrapClientWithRetry(client, {
      maxRetries: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const provider: ResearchProvider = createSearchMcpProviderFromClient(wrapped, FULL_TOOL_NAMES);

    let svc: ReturnType<typeof createRunService> | undefined;
    try {
      svc = createRunService();
    const { runId } = await svc.startRun({
      query: 'Flaky provider recovery test',
      provider,
      config,
      strategy: 'agent',
      explicitFamilyId: 'fam_flaky_recovery',
    });

    // Poll for completion with timeout
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const status = svc.getStatus(runId);
      if (status?.status === 'completed' || status?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const status = svc.getStatus(runId);
    expect(status).not.toBeNull();
    expect(status!.status).toBe('completed');

    // Exactly one RUN_COMPLETED
    const completedEvents = queryEvents({ eventType: 'RUN_COMPLETED' });
    expect(completedEvents).toHaveLength(1);

    // Zero RUN_FAILED events
    const failedEvents = queryEvents({ eventType: 'RUN_FAILED' });
    expect(failedEvents).toHaveLength(0);

    // No duplicate findings — force-genesis replay produces valid projection
    const projection = rebuildProjection(ALL_HANDLERS, { forceGenesis: true });
    const checksum = computeProjectionChecksum(projection);
    expect(checksum).toBeTruthy();

    // verifyProjectionIntegrity passes
    const integrity = verifyProjectionIntegrity(projection);
    expect(integrity.matches).toBe(true);
    expect(integrity.mismatches).toEqual([]);

    // verifyKnowledgeReadModel passes after rebuild
    rebuildKnowledgeReadModel(ALL_HANDLERS);
    const readModelCheck = verifyKnowledgeReadModel(projection);
    expect(readModelCheck.matches).toBe(true);
    expect(readModelCheck.mismatches).toEqual([]);

    // Event log fully replayable — second genesis replay matches
    const replay2 = rebuildProjection(ALL_HANDLERS, { forceGenesis: true });
    expect(computeProjectionChecksum(replay2)).toBe(checksum);

    } finally {
      await svc?.shutdownScheduler();
    }
  }, 15_000);

  it('exhaustion: failures exceed budget → run completes (pipeline is fault-tolerant), event log replayable, scheduler shuts down cleanly', async () => {
    const dbPath = path.join(tmpDir, 'exhaustion.db');
    initDb(dbPath);
    const config = makeConfig(dbPath);

    // Always fail — exceeds retry budget.
    // The pipeline strategy catches provider errors internally and returns
    // empty results, so the run completes with RUN_COMPLETED (zero findings)
    // rather than RUN_FAILED. This IS the correct existing behavior.
    const { client, closeCount } = createFlakyClient(Infinity);
    const wrapped = wrapClientWithRetry(client, {
      maxRetries: 1, // minimal retries for test speed
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const provider: ResearchProvider = createSearchMcpProviderFromClient(wrapped, FULL_TOOL_NAMES);

    let svc: ReturnType<typeof createRunService> | undefined;
    try {
      svc = createRunService();
    const { runId } = await svc.startRun({
      query: 'Flaky provider exhaustion test',
      provider,
      config,
      strategy: 'agent',
      explicitFamilyId: 'fam_flaky_exhaustion',
    });

    // Poll for terminal state with bounded timeout
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const status = svc.getStatus(runId);
      if (status?.status === 'completed' || status?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const status = svc.getStatus(runId);
    expect(status).not.toBeNull();
    // Pipeline catches provider errors → completes with empty findings
    expect(status!.status).toBe('completed');
    expect(status!.claimCount ?? 0).toBe(0);
    expect(status!.sourceCount ?? 0).toBe(0);

    // Zero RUN_FAILED events (pipeline swallowed all provider errors)
    const failedEvents = queryEvents({ eventType: 'RUN_FAILED' });
    expect(failedEvents).toHaveLength(0);

    // Exactly one RUN_COMPLETED
    const completedEvents = queryEvents({ eventType: 'RUN_COMPLETED' });
    expect(completedEvents).toHaveLength(1);

    // Event log fully replayable
    const projection = rebuildProjection(ALL_HANDLERS, { forceGenesis: true });
    const checksum = computeProjectionChecksum(projection);
    expect(checksum).toBeTruthy();

    } finally {
      await svc?.shutdownScheduler();
    }
  }, 15_000);
});
