/**
 * HTTP serve entrypoint (tsx). Bootstraps through the SAME CLI runtime as
 * `trellis serve` — one implementation of boot/shutdown ordering
 * (scheduler → provider → transport → DB last), never a second one.
 */
import { initCliRuntime, shutdownCliRuntime } from '../cli/runtime.js';
import { logger } from '../logger.js';
import { createHttpServer } from './server.js';

const rt = initCliRuntime();
const app = rt.app;
const runService = rt.runService;
if (app === undefined || runService === undefined) throw new Error('HTTP server requires a writable runtime');

const server = createHttpServer({ app, query: rt.query, port: Number(process.env.TRELLIS_HTTP_PORT ?? 0) });
const address = await server.start();
runService.startScheduler();
logger.info({ port: address.port }, 'Trellis HTTP server started on loopback');

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await shutdownCliRuntime(rt, { beforeDbClose: () => server.stop() });
  } catch (err) {
    logger.error({ err }, 'HTTP shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
