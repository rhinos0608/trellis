import { logger } from '../logger.js';
import { loadConfig } from '../config/index.js';
import { closeDb, getDb, initDb } from '../store/db.js';
import { createRunService } from '../research/runService.js';
import { createResearchApplicationService } from '../app/researchService.js';
import { createKnowledgeQueryService } from '../query/service.js';
import { createHttpServer } from './server.js';
import { getProvider as getSharedProvider, closeProvider } from '../providers/searchMcp/owner.js';

const config = loadConfig();
const db = initDb(config.storage.dbPath);
if (!db) throw new Error('Failed to initialize database');
const runService = createRunService();
const app = createResearchApplicationService({ runService, config, getProvider: () => getSharedProvider(config) });
const query = createKnowledgeQueryService(getDb() ?? db);
const server = createHttpServer({ app, query, port: Number(process.env.TRELLIS_HTTP_PORT ?? 0) });
const address = await server.start();
runService.startScheduler();
logger.info({ port: address.port }, 'Trellis HTTP server started on loopback');
let shuttingDown = false;
async function shutdown(): Promise<void> { if (shuttingDown) return; shuttingDown = true; await runService.shutdownScheduler(); await server.stop(); await closeProvider(); closeDb(); }
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
