import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResearchApplicationService } from '../app/researchService.js';
import type { KnowledgeQueryService } from '../query/service.js';
import { handleRequest } from './handler.js';

const MAX_BODY = 64 * 1024; const MAX_URL = 8 * 1024; const MAX_SSE = 50;
export interface HttpServerDeps { app: ResearchApplicationService; query: KnowledgeQueryService; port?: number }
export function createHttpServer(deps: HttpServerDeps) {
  let sseCount = 0;
  const server = http.createServer((req, res) => { void dispatch(req, res); });
  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawHost = req.headers.host?.toLowerCase();
    const host = rawHost?.startsWith('[') ? rawHost.slice(0, rawHost.indexOf(']') + 1) : rawHost?.split(':')[0];
    if (!host || !new Set(['127.0.0.1', 'localhost', '[::1]']).has(host)) { reject(res, 400, 'INVALID_HOST', 'Loopback Host header required'); return; }
    const origin = req.headers.origin;
    if (origin) { try { const originHost = new URL(origin).hostname.toLowerCase(); if (!new Set(['127.0.0.1', 'localhost', '::1']).has(originHost)) { reject(res, 400, 'INVALID_ORIGIN', 'Loopback Origin required'); return; } } catch { reject(res, 400, 'INVALID_ORIGIN', 'Invalid Origin header'); return; } }
    if ((req.url ?? '').length > MAX_URL) { reject(res, 414, 'URI_TOO_LONG', 'Request URL too long'); return; }
    if (req.method === 'POST' && !((req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))) { reject(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json'); return; }
    let body: unknown = undefined;
    if (req.method === 'POST') { try { body = JSON.parse(await readBody(req)); } catch (error) { reject(res, error instanceof BodyLimitError ? 413 : 400, error instanceof BodyLimitError ? 'BODY_TOO_LARGE' : 'INVALID_JSON', error instanceof BodyLimitError ? 'Request body exceeds 64 KiB' : 'Invalid JSON'); return; } }
    const isSse = req.method === 'GET' && (req.url ?? '').split('?')[0]?.endsWith('/events');
    await handleRequest(req, res, body, { app: deps.app, query: deps.query, onSseStart: isSse ? () => { if (sseCount >= MAX_SSE) return false; sseCount++; return true; } : undefined, onSseEnd: isSse ? () => { sseCount = Math.max(0, sseCount - 1); } : undefined });
  }
  return { server, start: (port = deps.port ?? 0) => new Promise<AddressInfo>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { resolve(server.address() as AddressInfo); }); }), stop: () => new Promise<void>((resolve, reject) => { if (!server.listening) { resolve(); return; } server.close(error => { if (error) reject(error); else resolve(); }); }) };
}
class BodyLimitError extends Error {}
function readBody(req: IncomingMessage): Promise<string> { return new Promise((resolve, reject) => { let size = 0; const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_BODY) { req.resume(); reject(new BodyLimitError()); } else chunks.push(chunk); }); req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); }); req.on('error', reject); }); }
function reject(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) { res.end(); return; }
  const body = { error: { code, message, retryable: status >= 500 } }; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
}
