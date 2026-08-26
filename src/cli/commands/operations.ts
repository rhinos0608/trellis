/**
 * Operations CLI commands: doctor, verify, migrate, rebuild read-model, serve.
 */

import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { hashPayload, queryStoredRows, getLatestEventCursor } from '../../store/events.js';
import { decodeEventPayload } from '../../store/eventValidation.js';
import { initializeSchema, MIGRATIONS, SCHEMA_VERSION } from '../../store/migrations/index.js';
import {
  getKnowledgeReadModelStatus,
  rebuildKnowledgeReadModel,
  verifyKnowledgeReadModel,
} from '../../store/readModel/index.js';
import { createHttpServer } from '../../http/server.js';
import { rebuildProjection } from '../../store/projectionBuilder.js';
import type { TrellisConfig } from '../../config/index.js';
import type { ResearchProvider } from '../../providers/types.js';
import { ALL_HANDLERS, requireCliRuntime } from '../runtime.js';
import { shutdownCliRuntime } from '../runtime.js';
import type { CommandContext } from '../runtime.js';
import { UsageError, EXIT_CODES, printResult } from '../output.js';
import { logger } from '../../logger.js';
import { verifyProjectionIntegrity } from '../../store/projectionIntegrity.js';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
}

function worstStatus(checks: DoctorCheck[]): 'ok' | 'warning' | 'error' {
  if (checks.some((c) => c.status === 'error')) return 'error';
  if (checks.some((c) => c.status === 'warning')) return 'warning';
  return 'ok';
}

/** Confirm the opened DB is actually readable. */
function probeDatabase(ctx: CommandContext): { ok: true } | { ok: false; detail: string } {
  // Effective path (CLI --db flag or config default), never the static
  // config value — doctor must check the DB it actually opened.
  const dbPath = requireCliRuntime(ctx).dbPath;
  if (!existsSync(dbPath)) return { ok: false, detail: `Database file does not exist: ${dbPath}` };
  try {
    requireCliRuntime(ctx).db.prepare('SELECT 1').get();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `Database not readable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Injectable seams for the doctor provider probe (tests). */
export interface DoctorProviderDeps {
  /** Defaults to a FRESH search-mcp connection — never the shared owner singleton. */
  createProvider?: (cfg: TrellisConfig) => Promise<ResearchProvider>;
  timeoutMs?: number;
}

const PROVIDER_PROBE_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error(`${label} timed out after ${String(ms)}ms`)); }, ms);
    }),
  ]).finally(() => { clearTimeout(timer); });
}

/**
 * Probe the configured search-mcp provider over a dedicated diagnostic
 * connection (bounded handshake + listTools), then always close it.
 */
async function probeProvider(ctx: CommandContext, deps: DoctorProviderDeps): Promise<DoctorCheck> {
  const cfg = requireCliRuntime(ctx).config;
  if (cfg.searchProvider.args.length === 0) {
    return {
      name: 'provider',
      status: 'warning',
      detail: 'search-mcp not configured (set TRELLIS_SEARCH_MCP_PATH)',
    };
  }
  const create = deps.createProvider ??
    (async (c: TrellisConfig) => (await import('../../providers/searchMcp/index.js')).createSearchMcpProvider(c));
  let provider: ResearchProvider | undefined;
  const creation = create(cfg);
  try {
    provider = await withTimeout(creation, deps.timeoutMs ?? PROVIDER_PROBE_TIMEOUT_MS, 'search-mcp handshake');
    return {
      name: 'provider',
      status: 'ok',
      detail: `connected via ${cfg.searchProvider.command}; capabilities=${JSON.stringify(provider.capabilities)}`,
    };
  } catch (err) {
    // The timeout raced the handshake but couldn't cancel it: if creation
    // resolves late, close that provider in the background so its MCP child
    // process doesn't leak.
    void creation.then(
      async (late) => {
        try {
          await late.close?.();
        } catch (closeErr: unknown) {
          logger.warn({ err: closeErr }, 'Late doctor probe provider close failed');
        }
      },
      () => {
        /* creation failed on its own — nothing to clean up */
      },
    );
    return {
      name: 'provider',
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Always close the probe connection; best-effort only.
    try { await provider?.close?.(); } catch { /* probe cleanup */ }
  }
}

export async function runDoctor(ctx: CommandContext, providerDeps: DoctorProviderDeps = {}): Promise<number> {
  const checks: DoctorCheck[] = [];
  const dbPath = requireCliRuntime(ctx).dbPath;
  const open = probeDatabase(ctx);
  checks.push({ name: 'database', status: open.ok ? 'ok' : 'error', detail: open.ok ? dbPath : open.detail });

  if (open.ok) {
    // quick_check
    try {
      const result = requireCliRuntime(ctx).db.pragma('quick_check', { simple: true });
      checks.push({
        name: 'quick_check',
        status: result === 'ok' ? 'ok' : 'error',
        detail: String(result),
      });
    } catch (err) {
      checks.push({ name: 'quick_check', status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }

    // migration versions
    try {
      const applied = requireCliRuntime(ctx).db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as { version: number }[];
      const appliedVersions = applied.map((r) => r.version);
      const expectedVersions = MIGRATIONS.map((m) => m.version);
      const match =
        appliedVersions.length === expectedVersions.length &&
        appliedVersions.every((v, i) => v === expectedVersions[i]);
      checks.push({
        name: 'migrations',
        status: match ? 'ok' : 'error',
        detail: match
          ? `v${String(SCHEMA_VERSION)} (all ${String(expectedVersions.length)} applied)`
          : `applied=[${appliedVersions.join(',')}] registered=[${expectedVersions.join(',')}]`,
      });
    } catch (err) {
      checks.push({ name: 'migrations', status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }

    // latest event seq + read-model lag
    let latestSeq: number | null = null;
    try {
      latestSeq = getLatestEventCursor();
      checks.push({
        name: 'event_log',
        status: latestSeq === null ? 'warning' : 'ok',
        detail: latestSeq === null ? 'no events recorded yet' : `latest seq ${String(latestSeq)}`,
      });
    } catch (err) {
      checks.push({ name: 'event_log', status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
    try {
      const rm = getKnowledgeReadModelStatus();
      const lag = latestSeq === null ? 0 : Math.max(0, latestSeq - rm.lastAppliedSeq);
      checks.push({
        name: 'read_model',
        status: rm.status === 'ready' && lag === 0 ? 'ok' : rm.status === 'dirty' ? 'error' : 'warning',
        detail: `${rm.status} at seq ${String(rm.lastAppliedSeq)}${lag > 0 ? ` (lag ${String(lag)})` : ''}`,
      });
    } catch (err) {
      checks.push({ name: 'read_model', status: 'error', detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // config present
  checks.push({ name: 'config', status: 'ok', detail: `db=${dbPath}` });

  // Provider health check ONLY when explicitly requested (--provider);
  // default doctor stays DB-only and side-effect-free.
  if (ctx.values.provider === true) {
    checks.push(await probeProvider(ctx, providerDeps));
  }

  const overall = worstStatus(checks);
  printResult(ctx.io, { overall, checks }, 'doctor');
  return overall === 'error' ? EXIT_CODES.INTEGRITY : EXIT_CODES.OK;
}

export async function runVerify(ctx: CommandContext): Promise<number> {
  const mismatches: string[] = [];
  const rows = queryStoredRows();
  ctx.io.err.write(`verify: checking ${String(rows.length)} events\n`);
  // Read-only runtime: raw event rows are hashed/decoded here, and the
  // comparison state below comes from an in-memory force-genesis replay
  // (writeCheckpoint:false) — nothing in this command persists anything.
  for (const [i, row] of rows.entries()) {
    if ((i + 1) % 5000 === 0) ctx.io.err.write(`verify: ${String(i + 1)}/${String(rows.length)}\n`);
    if (hashPayload(row.payload) !== row.payload_hash) {
      mismatches.push(`seq ${String(row.seq)}: payload_hash mismatch`);
      continue;
    }
    try {
      decodeEventPayload(row.event_type, row.event_version, JSON.parse(row.payload));
    } catch (err) {
      mismatches.push(`seq ${String(row.seq)} (${row.event_type}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  ctx.io.err.write('verify: force-genesis replay\n');
  try {
    const state = rebuildProjection(ALL_HANDLERS, { forceGenesis: true, writeCheckpoint: false });
    ctx.io.err.write('verify: comparing read model\n');
    mismatches.push(...verifyKnowledgeReadModel(state).mismatches);
    ctx.io.err.write('verify: evidence-required projection invariant\n');
    mismatches.push(...verifyProjectionIntegrity(state).mismatches);
  } catch (err) {
    mismatches.push(`replay failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  ctx.io.err.write(
    `verify: ${mismatches.length === 0 ? 'PASS' : `FAIL (${String(mismatches.length)} mismatches)`}\n`,
  );
  printResult(ctx.io, { passed: mismatches.length === 0, eventsChecked: rows.length, mismatches }, 'verify');
  return mismatches.length === 0 ? EXIT_CODES.OK : EXIT_CODES.INTEGRITY;
}

export async function runMigrate(ctx: CommandContext): Promise<number> {
  initializeSchema(requireCliRuntime(ctx).db);
  const applied = requireCliRuntime(ctx).db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
  printResult(ctx.io, { currentVersion: applied.v, schemaVersion: SCHEMA_VERSION }, 'migrate');
  return EXIT_CODES.OK;
}

export async function runRebuild(ctx: CommandContext): Promise<number> {
  const target = ctx.positionals[0];
  if (target !== 'read-model') {
    throw new UsageError(`Usage: trellis rebuild read-model (got: ${target ?? '<missing>'})`);
  }
  let before: string;
  try {
    before = getKnowledgeReadModelStatus().status;
  } catch {
    before = 'missing';
  }
  const after = rebuildKnowledgeReadModel(ALL_HANDLERS);
  printResult(ctx.io, { before, after }, 'rebuild read-model');
  return EXIT_CODES.OK;
}

export async function runServe(ctx: CommandContext): Promise<number> {
  const portRaw = ctx.values.port as string | undefined;
  const port = portRaw === undefined ? 3000 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`--port must be an integer in [0, 65535], got: ${String(portRaw)}`);
  }
  const app = requireCliRuntime(ctx).app;
  const runService = requireCliRuntime(ctx).runService;
  if (app === undefined || runService === undefined) throw new UsageError('serve requires a writable runtime');
  const server = createHttpServer({ app, query: requireCliRuntime(ctx).query, port });
  const address: AddressInfo = await server.start();
  runService.startScheduler();
  ctx.io.err.write(`trellis serve: listening on 127.0.0.1:${String(address.port)}\n`);

  // Single idempotent shutdown latch: one signal triggers exactly one awaited
  // teardown (scheduler → provider → HTTP drain → DB last). SIGINT+SIGTERM or
  // repeated signals cannot double-stop.
  let triggered = false;
  let shutdownComplete!: () => void;
  let shutdownError: unknown;
  const done = new Promise<void>((resolve) => { shutdownComplete = resolve; });
  const requestShutdown = (): void => {
    if (triggered) return;
    triggered = true;
    ctx.io.err.write('trellis serve: shutting down\n');
    void (async () => {
      try {
        await shutdownCliRuntime(ctx.rt, { beforeDbClose: () => server.stop() });
      } catch (err) {
        logger.error({ err }, 'CLI serve shutdown failed');
        shutdownError = err;
      } finally {
        shutdownComplete();
      }
    })();
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);

  await done;
  process.removeListener('SIGINT', requestShutdown);
  process.removeListener('SIGTERM', requestShutdown);
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (shutdownError !== undefined) throw shutdownError;
  return EXIT_CODES.OK;
}
