import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ResearchApplicationService } from '../../src/app/researchService.js';
import { InvalidTransitionError } from '../../src/app/errors.js';
import type { RunEventDto, RunSummaryDto } from '../../src/app/types.js';
import { createHttpServer } from '../../src/http/server.js';
import { createKnowledgeQueryService } from '../../src/query/service.js';
import { appendEvents, closeDb, getDb, initDb } from '../../src/store/index.js';
import type { NewEventInput } from '../../src/store/events.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
const now = '2024-01-01T00:00:00.000Z';
const event = (eventType: NewEventInput['eventType'], runId: string, payload: unknown): NewEventInput => ({ eventType, eventVersion: 1, runId, batchId: null, actor: 'system', entityId: null, entityType: null, timestamp: now, payload });
const family = (id: string) => event('FAMILY_CREATED', 'seed', { family_id: id, label: id });
const claim = (id: string) => event('CLAIM_OBSERVED', 'seed', { observation: { id: `obs-${id}`, familyId: 'family-1', runId: 'seed', observedAt: now, subjectText: id, predicate: 'improves', objectText: 'research', polarity: 'asserted', hedge: 'certain', evidenceType: 'study', canonicalKey: { subject: id, predicate: 'improves' }, confidence: 0.9, sourceIds: [], extractionVersion: 'v1' }, reconciliation: { observationId: `obs-${id}`, classification: 'new_claim', canonicalClaimId: id, score: 1, method: 'canonical_key_exact', rationale: 'test', reconcilerVersion: 1, candidates: [] } });
const source = (id: string) => event('SOURCE_OBSERVED', 'seed', { sourceId: id, observedSourceId: id, canonicalUrl: `https://${id}.example.com`, url: `https://${id}.example.com`, title: id, domain: `${id}.example.com`, sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'seed', observedAt: now });

let dir: string; let base: string; let server: ReturnType<typeof createHttpServer>; let run: RunSummaryDto; let events: RunEventDto[];
function makeApp(): ResearchApplicationService {
  run = { runId: 'run-http', familyId: 'family-1', status: 'completed', query: 'http test', progress: { phase: 'completed', percent: 100 }, completedAt: now };
  events = [{ seq: 4, eventType: 'RUN_QUEUED', timestamp: now, payload: { runId: run.runId, familyId: run.familyId } }, { seq: 5, eventType: 'RUN_COMPLETED', timestamp: now, payload: { runId: run.runId } }];
  return {
    startRun: async () => ({ runId: 'run-created', familyId: 'family-1' }), getRun: (id) => id === run.runId ? run : null,
    listRuns: () => [run], getRunHistory: (id) => ({ runId: id, events }), cancelRun: async () => ({ cancelled: true }),
    retryRun: async () => { throw new InvalidTransitionError('Cannot retry run in status: completed', { runId: run.runId }); },
    continueResearch: async () => ({ status: 'no_work', familyId: 'family-1', followUpsUsed: 0, followUpCap: 3 }), rollbackRun: () => ({ skipped: 0, executed: 0, blocked: [], readModelRebuilt: false }), listRunEvents: ({ afterSeq }) => events.filter((item) => item.seq > (afterSeq ?? 0)),
  };
}
async function request(pathname: string, init?: RequestInit): Promise<Response> { return fetch(`${base}${pathname}`, init); }
function rawRequest(pathname: string, headers: Record<string, string>): Promise<number> { return new Promise((resolve, reject) => { const target = new URL(`${base}${pathname}`); const req = http.request({ hostname: target.hostname, port: Number(target.port), path: target.pathname, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); }); req.on('error', reject); req.end(); }); }
const json = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-http-')); initDb(path.join(dir, 'test.db'));
  appendEvents([family('family-1'), claim('claim-1'), claim('claim-2'), source('source-1')], { projection: createEmptyProjectionState(), handlers }); getDb()!.prepare("UPDATE rm_state SET status='ready' WHERE model_name='knowledge'").run();
  const app = makeApp(); const query = createKnowledgeQueryService(getDb()!); server = createHttpServer({ app, query }); const address = await server.start(0); base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await server.stop(); closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('HTTP adapter routes', () => {
  it('serves mutation and read success paths', async () => {
    expect((await request('/v1/research/runs', json({ query: 'new research' }))).status).toBe(202);
    const runs = await request('/v1/research/runs'); expect(runs.status).toBe(200); expect((await runs.json()).items).toHaveLength(1);
    expect((await request('/v1/research/runs/run-http')).status).toBe(200);
    expect((await request('/v1/knowledge/status')).status).toBe(200);
    expect((await request('/v1/claims')).status).toBe(200);
    expect((await request('/v1/claims/claim-1')).status).toBe(200);
    expect((await request('/v1/sources')).status).toBe(200);
    const sourceResponse = await request('/v1/sources/source-1'); expect(sourceResponse.status).toBe(200); expect((await sourceResponse.json()).data.id).toBe('source-1');
    expect((await request('/healthz')).status).toBe(200);
  });
  it('serves history, cancellation, continuation, and child claim routes', async () => {
    expect((await request('/v1/research/runs/run-http/history')).status).toBe(200);
    expect((await request('/v1/research/runs/run-http/cancel', json({}))).status).toBe(202);
    expect((await request('/v1/research/families/family-1/continue', json({}))).status).toBe(200);
    for (const suffix of ['observations', 'evidence', 'relations']) expect((await request(`/v1/claims/claim-1/${suffix}`)).status).toBe(200);
  });
  it('maps missing resources, transition, validation, cursor, and dirty-model errors', async () => {
    expect((await request('/v1/research/runs/missing')).status).toBe(404);
    expect((await request('/v1/claims/missing')).status).toBe(404);
    expect((await request('/v1/sources/missing')).status).toBe(404);
    expect((await request('/v1/research/runs/run-http/retry', json({}))).status).toBe(409);
    expect((await request('/v1/research/runs', json({ nope: true }))).status).toBe(400);
    expect((await request('/v1/claims?cursor=bad')).status).toBe(400);
    getDb()!.prepare("UPDATE rm_state SET status='dirty' WHERE model_name='knowledge'").run();
    expect((await request('/v1/claims')).status).toBe(503);
  });
  it('round-trips pagination cursor and rejects malformed POSTs', async () => {
    const first = await request('/v1/claims?limit=1'); const page = await first.json(); expect(page.nextCursor).toEqual(expect.any(String));
    const second = await request(`/v1/claims?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`); expect(second.status).toBe(200); expect((await second.json()).items[0].id).toBe('claim-2');
    expect((await request('/v1/research/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect((await request('/v1/research/runs', json({ query: 'new research', depth: 'invalid' }))).status).toBe(400);
    expect((await request('/v1/research/runs', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });
  it('rejects oversized bodies, then remains responsive', async () => {
    const response = await request('/v1/research/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'x'.repeat(70_000) }) }); expect(response.status).toBe(413);
    expect((await request('/healthz')).status).toBe(200);
  });
  it('enforces loopback Host and Origin without CORS headers', async () => {
    const host = await rawRequest('/healthz', { Host: 'evil.example' }); expect(host).toBe(400);
    const origin = await request('/healthz', { headers: { Origin: 'https://evil.example' } }); expect(origin.status).toBe(400);
    const healthy = await request('/healthz'); expect(healthy.headers.get('access-control-allow-origin')).toBeNull();
  });
  it('stops safely more than once', async () => { await server.stop(); await server.stop(); });
  it('does not expose rollback route', async () => { const response = await request('/v1/research/runs/run-http/rollback', json({})); expect([404, 405]).toContain(response.status); });
  it('replays SSE backlog, resumes by Last-Event-ID, and closes terminal streams', async () => {
    const first = await request('/v1/research/runs/run-http/events'); const text = await first.text(); expect(first.status).toBe(200); expect([...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))).toEqual([4, 5]); expect(text).toContain('RUN_COMPLETED');
    const resumed = await request('/v1/research/runs/run-http/events', { headers: { 'Last-Event-ID': '4' } }); const resumedText = await resumed.text(); expect(resumedText).toContain('id: 5'); expect(resumedText).not.toContain('id: 4');
  });
  it('keeps MCP entrypoint independent from HTTP server', async () => {
    const mcp = fs.readFileSync(path.resolve('src/mcp/server.ts'), 'utf8'); expect(mcp).not.toContain("from '../http/server.js'"); expect(mcp).not.toContain('createHttpServer');
  });
});
