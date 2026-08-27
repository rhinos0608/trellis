import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';
import { initDb, closeDb, queryEvents, appendEvents } from '../../src/store/index.js';
import { createRunService } from '../../src/research/runService.js';
import { rebuildProjection } from '../../src/store/projectionBuilder.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import { handleKnowledgeTool, type KnowledgeToolDeps } from '../../src/mcp/knowledgeTool.js';
import { createKnowledgeQueryService } from '../../src/query/service.js';
import { getDb } from '../../src/store/db.js';
import type { ProjectionState } from '../../src/store/projectionState.js';

const handlers = { ...graphEventHandlers, ...workspaceEventHandlers };
const provider: ResearchProvider = {
  name: 'thread-test',
  capabilities: { search: true, read: true, academic: false, code: false, community: { reddit: false, hackernews: false, stackoverflow: false }, media: false, reference: false, browser: false },
  search: async () => [{ url: 'https://example.com/thread', title: 'Thread source', snippet: 'Thread source' }],
  read: async (_ctx, url) => ({ url, title: 'Thread source', content: 'This source contains enough detailed content to produce a durable claim for replay verification.', contentHash: 'thread-test' }),
  crawl: async () => [], academic: async () => [],
};

function config(dbPath: string): TrellisConfig {
  return { storage: { dbPath }, llm: { baseUrl: 'http://mock-llm', model: 'test-model', apiKey: undefined }, searchProvider: { command: 'echo', args: [] }, logLevel: 'silent' };
}

// Mock LlmClient so agent strategy doesn't need real LLM config
vi.mock('../../src/research/llm/client.js', () => {
  const mockResponse = { success: true, content: 'THOUGHT: done\nANSWER: Done.', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  return {
    LlmClient: class { callOrchestrator = async () => mockResponse; callWorker = async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0 }); },
    parseJsonFromText: (s: string) => { try { return JSON.parse(s); } catch { return undefined; } },
  };
});

async function waitForRun(service: ReturnType<typeof createRunService>, runId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const status = service.getStatus(runId);
    if (status && ['completed', 'failed', 'cancelled'].includes(status.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run did not finish: ${runId}`);
}

function queuedThread(runId: string): string {
  const event = queryEvents({ runId, eventType: 'RUN_QUEUED' })[0];
  const threadId = (event?.payload as { threadId?: unknown } | undefined)?.threadId;
  if (typeof threadId !== 'string') throw new Error(`Missing threadId for ${runId}`);
  return threadId;
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-thread-')); });
afterEach(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('thread integration', () => {
  it('covers startup resolution, validation, replay linkage, and knowledge.threads', async () => {
    const dbPath = path.join(tmpDir, 'threads.db');
    const cfg = config(dbPath);
    initDb(dbPath);
    const service = createRunService();
    const familyId = 'thread-integration-family';

    // 1. New family/run creates one thread before RUN_QUEUED.
    const first = await service.startRun({ query: 'TypeScript configuration testing', explicitFamilyId: familyId, provider, config: cfg });
    await waitForRun(service, first.runId);
    const firstThreadId = queuedThread(first.runId);
    const firstEvents = queryEvents({ runId: first.runId });
    expect(firstEvents.filter((event) => event.eventType === 'THREAD_CREATED')).toHaveLength(1);
    expect(firstEvents.findIndex((event) => event.eventType === 'THREAD_CREATED')).toBeLessThan(firstEvents.findIndex((event) => event.eventType === 'RUN_QUEUED'));

    // 2. Similar query reuses open thread.
    const second = await service.startRun({ query: 'TypeScript configuration testing strategies', explicitFamilyId: familyId, provider, config: cfg });
    await waitForRun(service, second.runId);
    expect(queryEvents({ runId: second.runId, eventType: 'THREAD_CREATED' })).toHaveLength(0);
    expect(queuedThread(second.runId)).toBe(firstThreadId);

    // 3. Unrelated query creates separate thread.
    const third = await service.startRun({ query: 'Quantum cooking recipes', explicitFamilyId: familyId, provider, config: cfg });
    await waitForRun(service, third.runId);
    const thirdThreadId = queuedThread(third.runId);
    expect(thirdThreadId).not.toBe(firstThreadId);
    expect(queryEvents({ runId: third.runId, eventType: 'THREAD_CREATED' })).toHaveLength(1);

    // 4. Explicit valid thread is honored without creating another.
    const explicit = await service.startRun({ query: 'Different wording for testing', explicitFamilyId: familyId, threadId: firstThreadId, provider, config: cfg });
    await waitForRun(service, explicit.runId);
    expect(queuedThread(explicit.runId)).toBe(firstThreadId);
    expect(queryEvents({ runId: explicit.runId, eventType: 'THREAD_CREATED' })).toHaveLength(0);

    // 5. Cross-family thread rejected.
    const otherFamily = await service.startRun({ query: 'Other family', explicitFamilyId: 'other-family', provider, config: cfg });
    await waitForRun(service, otherFamily.runId);
    const otherThreadId = queuedThread(otherFamily.runId);
    await expect(service.startRun({ query: 'Cross family', explicitFamilyId: familyId, threadId: otherThreadId, provider, config: cfg })).rejects.toThrow(`does not belong to family ${familyId}`);

    // 6. Missing thread rejected.
    await expect(service.startRun({ query: 'Missing thread', explicitFamilyId: familyId, threadId: 'missing-thread', provider, config: cfg })).rejects.toThrow('Thread not found: missing-thread');

    // 7. Genesis replay preserves thread and claim linkage.
    const claimId = 'claim-thread-replay';
    const projection = rebuildProjection(handlers);
    appendEvents([{
      timestamp: new Date().toISOString(), eventType: 'CLAIM_OBSERVED', eventVersion: 1,
      runId: first.runId, batchId: null, actor: 'system', entityId: claimId, entityType: 'claim',
      payload: {
        observation: {
          id: 'observation-thread-replay', familyId, threadId: firstThreadId, runId: first.runId,
          observedAt: new Date().toISOString(), subjectText: 'Thread replay subject', predicate: 'supports',
          polarity: 'asserted', hedge: 'likely', evidenceType: 'claim', confidence: 0.9,
          sourceIds: [], extractionVersion: 'integration-test', canonicalKey: { subject: 'thread replay subject', predicate: 'supports' },
        },
        reconciliation: {
          observationId: 'observation-thread-replay', classification: 'new_claim', canonicalClaimId: claimId,
          score: 1, method: 'canonical_key_exact', rationale: 'integration test', reconcilerVersion: 1, candidates: [],
        },
      },
    }], { projection, handlers });
    const beforeReplay = rebuildProjection(handlers);
    const beforeThread = beforeReplay.threads.get(firstThreadId);
    const beforeClaims = [...beforeReplay.claims.values()].filter((claim) => claim.threadId === firstThreadId);
    expect(beforeThread).toBeDefined();
    expect(beforeClaims.length).toBeGreaterThan(0);
    closeDb();
    initDb(dbPath);
    const afterReplay = rebuildProjection(handlers);
    expect(afterReplay.threads.get(firstThreadId)).toEqual(beforeThread);
    expect([...afterReplay.claims.values()].filter((claim) => claim.threadId === firstThreadId)).toEqual(beforeClaims);

    // 8. Knowledge surface returns resulting thread structures.
    const knowledge = handleKnowledgeTool({ action: 'threads', familyId }, { getState: () => afterReplay, queryService: createKnowledgeQueryService(getDb()!), queryEvents });
    const threads = knowledge.threads as { id: string; familyId: string; status: string }[];
    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.id)).toEqual(expect.arrayContaining([firstThreadId, thirdThreadId]));
    expect(threads.every((thread) => thread.familyId === familyId && thread.status === 'open')).toBe(true);

    await service.shutdownScheduler();
  });
});
