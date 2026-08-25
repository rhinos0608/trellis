/* eslint-disable @typescript-eslint/no-unnecessary-condition -- closure state changes across timer and request callbacks */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResearchApplicationService } from '../app/researchService.js';
import { mapError } from './errors.js';

const TERMINAL = new Set(['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED', 'RUN_INTERRUPTED', 'RUN_ROLLED_BACK']);
export function streamRunEvents(req: IncomingMessage, res: ServerResponse, app: ResearchApplicationService, runId: string, afterSeq = 0, onDone?: () => void): void {
  let stopped = false;
  let paused = false;
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let lifetime: NodeJS.Timeout | undefined;
  let last = afterSeq;
  let terminal = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    if (lifetime) clearTimeout(lifetime);
    res.removeListener('drain', onDrain);
    req.removeListener('close', stop);
    onDone?.();
  };
  let poll: () => void = () => undefined;
  const onDrain = (): void => {
    paused = false;
    res.removeListener('drain', onDrain);
    poll();
  };
  req.on('close', stop);

  try {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const writeEvents = (): boolean => {
      const events = app.listRunEvents({ runId, afterSeq: last, limit: 100 });
      for (const event of events) {
        if (event.seq <= last) continue;
        last = event.seq;
        if (TERMINAL.has(event.eventType)) terminal = true;
        if (!res.write(`id: ${String(event.seq)}\ndata: ${JSON.stringify(event)}\n\n`)) {
          paused = true;
          res.once('drain', onDrain);
          break;
        }
      }
      return events.length > 0;
    };
    poll = (): void => {
      if (stopped || paused) return;
      try {
        const had = writeEvents();
        if (paused) return;
        if (terminal && !had) { stop(); res.end(); return; }
        timer = setTimeout(poll, 300);
      } catch (error) {
        const mapped = mapError(error);
        if (!stopped) res.write(`event: error\ndata: ${JSON.stringify(mapped.body)}\n\n`);
        stop();
        res.end();
      }
    };
    let had = true;
    while (had && !stopped && !paused) had = writeEvents();
    if (paused) return;
    if (terminal) { stop(); res.end(); return; }
    heartbeat = setInterval(() => { if (!stopped) res.write(':heartbeat\n\n'); }, 15_000);
    lifetime = setTimeout(() => { if (!stopped) { stop(); res.end(); } }, 10 * 60_000);
    timer = setTimeout(poll, 300);
  } catch (error) {
    stop();
    if (!res.headersSent) { const mapped = mapError(error); res.writeHead(mapped.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(mapped.body)); } else res.end();
  }
}
