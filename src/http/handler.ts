/* eslint-disable @typescript-eslint/no-non-null-assertion -- regex capture groups are guarded by match checks; assertions preserve route narrowing */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResearchApplicationService } from '../app/researchService.js';
import type { RetryRunInput, ContinueResearchInput } from '../research/runService.js';
import type { ListClaimsInput, ListSourcesInput } from '../query/types.js';
import type { KnowledgeQueryService } from '../query/service.js';
import { RunNotFoundError } from '../app/errors.js';
import { mapError, validationError } from './errors.js';
import { claimsQuerySchema, continueSchema, eventQuerySchema, evidenceQuerySchema, observationsQuerySchema, relationsQuerySchema, retryRunSchema, runsQuerySchema, sourcesQuerySchema, startRunSchema } from './schemas.js';
import { streamRunEvents } from './sse.js';

export interface HandlerDeps { app: ResearchApplicationService; query: KnowledgeQueryService; onSseStart?: (() => boolean) | undefined; onSseEnd?: (() => void) | undefined }
function json(res: ServerResponse, status: number, value: unknown): void { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
function parsed<T>(schema: { parse(v: unknown): T }, value: unknown): T { return schema.parse(value); }
function params(url: URL): Record<string, string> { return Object.fromEntries(url.searchParams.entries()); }
export async function handleRequest(req: IncomingMessage, res: ServerResponse, body: unknown, deps: HandlerDeps): Promise<void> {
  const method = req.method ?? 'GET'; const url = new URL(req.url ?? '/', 'http://localhost'); const path = url.pathname;
  try {
    if (method === 'GET' && path === '/healthz') { json(res, 200, { status: 'ok' }); return; }
    if (method === 'POST' && path === '/v1/research/runs') { json(res, 202, { ...(await deps.app.startRun(parsed(startRunSchema, body))), status: 'queued' }); return; }
    let m: RegExpMatchArray | null;
    if (method === 'GET' && path === '/v1/research/runs') { json(res, 200, { items: deps.app.listRuns(parsed(runsQuerySchema, params(url))) }); return; }
    m = /^\/v1\/research\/runs\/([^/]+)\/events$/.exec(path); if (method === 'GET' && m) { if (deps.app.getRun(m[1]!) === null) throw new RunNotFoundError(m[1]!); const q = parsed(eventQuerySchema, params(url)); const header = req.headers['last-event-id']; const after = q.afterSeq ?? (typeof header === 'string' && /^\d+$/.test(header) ? Number(header) : 0); if (deps.onSseStart && !deps.onSseStart()) { json(res, 503, { error: { code: 'SSE_CAPACITY', message: 'Too many event streams', retryable: true } }); return; } streamRunEvents(req, res, deps.app, m[1]!, after, deps.onSseEnd); return; }
    m = /^\/v1\/research\/runs\/([^/]+)$/.exec(path); if (method === 'GET' && m) { const run = deps.app.getRun(m[1]!); if (!run) throw new RunNotFoundError(m[1]!); json(res, 200, run); return; }
    m = /^\/v1\/research\/runs\/([^/]+)\/history$/.exec(path); if (method === 'GET' && m) { if (!deps.app.getRun(m[1]!)) throw new RunNotFoundError(m[1]!); const q = parsed(observationsQuerySchema, params(url)); json(res, 200, deps.app.getRunHistory(m[1]!, q)); return; }
    m = /^\/v1\/research\/runs\/([^/]+)\/(cancel|retry)$/.exec(path); if (method === 'POST' && m) { if (!deps.app.getRun(m[1]!)) throw new RunNotFoundError(m[1]!); if (m[2] === 'cancel') { json(res, 202, await deps.app.cancelRun(m[1]!)); return; } json(res, 202, { ...(await deps.app.retryRun({ runId: m[1]!, ...parsed(retryRunSchema, body) } as RetryRunInput)), status: 'queued' }); return; }
    m = /^\/v1\/research\/families\/([^/]+)\/continue$/.exec(path); if (method === 'POST' && m) { const result = await deps.app.continueResearch({ familyId: m[1]!, ...parsed(continueSchema, body) } as ContinueResearchInput); json(res, result.status === 'queued' ? 202 : 200, result); return; }
    if (method === 'GET' && path === '/v1/knowledge/status') { json(res, 200, deps.query.status()); return; }
    if (method === 'GET' && path === '/v1/claims') { json(res, 200, deps.query.listClaims(parsed(claimsQuerySchema, params(url)) as ListClaimsInput)); return; }
    m = /^\/v1\/claims\/([^/]+)(?:\/(observations|evidence|relations))?$/.exec(path); if (method === 'GET' && m) { const id = m[1]!; if (!m[2]!) { const result = deps.query.getClaim(id); if (!result.data) { json(res, 404, { error: { code: 'CLAIM_NOT_FOUND', message: `Claim not found: ${id}`, retryable: false } }); return; } json(res, 200, result); return; } if (!deps.query.getClaim(id).data) { json(res, 404, { error: { code: 'CLAIM_NOT_FOUND', message: `Claim not found: ${id}`, retryable: false } }); return; } if (m[2] === 'observations') { json(res, 200, deps.query.listClaimObservationsForClaim({ claimId: id, ...parsed(observationsQuerySchema, params(url)) } as Parameters<KnowledgeQueryService['listClaimObservationsForClaim']>[0])); return; } if (m[2] === 'evidence') { json(res, 200, deps.query.listEvidenceForClaim({ claimId: id, ...parsed(evidenceQuerySchema, params(url)) } as Parameters<KnowledgeQueryService['listEvidenceForClaim']>[0])); return; } json(res, 200, deps.query.listClaimRelations({ claimId: id, ...parsed(relationsQuerySchema, params(url)) } as Parameters<KnowledgeQueryService['listClaimRelations']>[0])); return; }
    if (method === 'GET' && path === '/v1/sources') { json(res, 200, deps.query.listSources(parsed(sourcesQuerySchema, params(url)) as ListSourcesInput)); return; }
    m = /^\/v1\/sources\/([^/]+)$/.exec(path); if (method === 'GET' && m) { const result = deps.query.getSource(m[1]!); if (!result.data) { json(res, 404, { error: { code: 'SOURCE_NOT_FOUND', message: `Source not found: ${m[1]!}`, retryable: false } }); return; } json(res, 200, result); return; }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found', retryable: false } }); return;
  } catch (error) { const mapped = error instanceof SyntaxError ? validationError(error) : mapError(error); json(res, mapped.status, mapped.body); }
}
