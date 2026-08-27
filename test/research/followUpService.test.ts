import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb, queryEvents, appendEvents, rebuildProjection } from '../../src/store/index.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import { createRunService } from '../../src/research/runService.js';
import { foldRunLedger } from '../../src/research/runLedger.js';
import type { NewEventInput } from '../../src/store/events.js';
import type { TrellisConfig } from '../../src/config/index.js';
import type { ResearchProvider } from '../../src/providers/types.js';

const config: TrellisConfig = { storage: { dbPath: ':memory:' }, llm: { baseUrl: 'http://mock-llm', model: 'test-model' }, searchProvider: { command: 'echo', args: [] }, logLevel: 'silent' };

// Mock LlmClient so agent strategy doesn't need real LLM config
vi.mock('../../src/research/llm/client.js', () => {
  const mockResponse = { success: true, content: 'THOUGHT: done\nANSWER: Done.', model: 'test', tokensUsed: 15, tokensSource: 'provider_usage', promptTokens: 10, completionTokens: 5, attempts: 1, durationMs: 100 };
  return {
    LlmClient: class { callOrchestrator = async () => mockResponse; callWorker = async () => ({ success: false, content: '', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0 }); },
    parseJsonFromText: (s: string) => { try { return JSON.parse(s); } catch { return undefined; } },
  };
});
const handlers = { ...graphEventHandlers, ...workspaceEventHandlers };
const provider: ResearchProvider = {
  name: 'follow-up-test', capabilities: { search: true, read: true, academic: false, code: false, community: { reddit: false, hackernews: false, stackoverflow: false }, media: false, reference: false, browser: false },
  search: async () => [], read: async (_ctx, url) => ({ url, title: url, content: '' }), crawl: async () => [], academic: async () => [],
};
let tmpDir: string;

function event(eventType: NewEventInput['eventType'], runId: string, payload: unknown): NewEventInput {
  return { eventType, runId, payload, timestamp: new Date().toISOString(), eventVersion: 1, batchId: null, actor: 'system', entityId: null, entityType: null };
}
function seedFamily(familyId: string, gaps: Array<{ id: string; question: string; threadId?: string }>): void {
  appendEvents([
    event('FAMILY_CREATED', 'seed', { family_id: familyId, label: familyId }),
    ...(gaps.some((gap) => gap.threadId) ? [event('THREAD_CREATED', 'seed', { threadId: gaps.find((gap) => gap.threadId)?.threadId, familyId, label: 'thread' })] : []),
    ...gaps.map((gap) => event('GAP_OPENED', 'seed', { id: gap.id, familyId, question: gap.question, category: 'low_confidence', status: 'open', priority: 1, firstSeenRunId: 'seed', ...(gap.threadId ? { threadId: gap.threadId } : {}) })),
  ], { projection: rebuildProjection(handlers), handlers });
}
function runsFor(familyId: string) { return [...foldRunLedger(queryEvents({})).values()].filter((run) => run.familyId === familyId); }
function markFailed(runId: string): void {
  appendEvents([{ ...event('RUN_FAILED', runId, { runId, error: { code: 'transient', classification: 'transient', message: 'provider failed', retryable: true, occurredAt: new Date().toISOString() } }), eventVersion: 2 }], { projection: rebuildProjection(handlers), handlers });
}
async function waitFor(runId: string, service: ReturnType<typeof createRunService>, status: string): Promise<void> {
  for (let i = 0; i < 100; i++) { if (service.getStatus(runId)?.status === status) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`run did not reach ${status}`);
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-follow-up-')); initDb(path.join(tmpDir, 'test.db')); });
afterEach(async () => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('research.continue service', () => {
  it('queues eligible gap question exactly once and defaults depth to quick', async () => {
    seedFamily('fam', [{ id: 'gap1', question: 'How does this work?' }]);
    const service = createRunService();
    const result = await service.continueResearch({ familyId: 'fam', config });
  });

  it('reuses gap threadId', async () => {
    seedFamily('fam', [{ id: 'gap1', question: 'Thread question', threadId: 'thread1' }]);
    const service = createRunService(); const result = await service.continueResearch({ familyId: 'fam', config });
  });

  it('enforces three attempts and rejects fourth without enqueueing', async () => {
    seedFamily('fam', [{ id: 'g1', question: 'one' }, { id: 'g2', question: 'two' }, { id: 'g3', question: 'three' }, { id: 'g4', question: 'four' }]);
    const service = createRunService();
    for (let i = 0; i < 3; i++) expect((await service.continueResearch({ familyId: 'fam', config })).status).toBe('queued');
    const before = runsFor('fam').length; const fourth = await service.continueResearch({ familyId: 'fam', config });
    expect(fourth).toEqual({ status: 'cap_reached', familyId: 'fam', followUpsUsed: 3, followUpCap: 3 }); expect(runsFor('fam')).toHaveLength(before); await service.shutdownScheduler();
  });

  it('serializes concurrent calls and selects different targets', async () => {
    seedFamily('fam', [{ id: 'g1', question: 'one' }, { id: 'g2', question: 'two' }]);
    const service = createRunService(); const [first, second] = await Promise.all([service.continueResearch({ familyId: 'fam', config }), service.continueResearch({ familyId: 'fam', config })]);
    expect(first.status).toBe('queued'); expect(second.status).toBe('queued');
    expect((first as { target: { id: string } }).target.id).not.toBe((second as { target: { id: string } }).target.id); await service.shutdownScheduler();
  });

  it('counts failed follow-up and retry provenance as cap attempts', async () => {
    seedFamily('fam', [{ id: 'g1', question: 'one' }, { id: 'g2', question: 'two' }, { id: 'g3', question: 'three' }]);
    const service = createRunService(); const normal = await service.startRun({ query: 'seed', explicitFamilyId: 'fam', provider, config }); await waitFor(normal.runId, service, 'completed');
    const queued = await service.continueResearch({ familyId: 'fam', config });
    const runId = (queued as { runId: string }).runId;
    expect(runsFor('fam').find((run) => run.runId === runId)?.followUp?.sourceRunId).toBe(normal.runId);
    markFailed(runId);
    expect((await service.continueResearch({ familyId: 'fam', config })).followUpsUsed).toBe(2);
    const retry = await service.retryRun({ runId });
    const folded = foldRunLedger(queryEvents({})); expect(folded.get(retry.runId)?.followUp?.targetId).toBe(folded.get(runId)?.followUp?.targetId);
    const afterRetry = await service.continueResearch({ familyId: 'fam', config }); expect(afterRetry).toMatchObject({ status: 'cap_reached', followUpsUsed: 3 }); await service.shutdownScheduler();
  });

  it('normal completed runs do not autonomously consume follow-up slots', async () => {
    const service = createRunService(); const started = await service.startRun({ query: 'normal', explicitFamilyId: 'fam', provider, config }); await waitFor(started.runId, service, 'completed');
    await service.shutdownScheduler(); expect(runsFor('fam').filter((run) => run.followUp)).toHaveLength(0);
  });

  it('returns no_work with no eligible targets', async () => {
    seedFamily('fam', []); const service = createRunService(); expect(await service.continueResearch({ familyId: 'fam', config })).toEqual({ status: 'no_work', familyId: 'fam', followUpsUsed: 0, followUpCap: 3 }); await service.shutdownScheduler();
  });

  it('failed provider run remains failed and counts', async () => {
    seedFamily('fam', [{ id: 'g1', question: 'one' }, { id: 'g2', question: 'two' }]);
    const service = createRunService(); const result = await service.continueResearch({ familyId: 'fam', config }); const followUpId = (result as { runId: string }).runId; await waitFor(followUpId, service, 'failed');
    expect((await service.continueResearch({ familyId: 'fam', config })).followUpsUsed).toBe(2); await service.shutdownScheduler();
  });
});
