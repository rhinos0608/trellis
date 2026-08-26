/**
 * Read-only CLI commands: search, claim, source, runs, run, watch.
 */

import { EntityNotFoundError, RunNotFoundError } from '../../app/errors.js';
import { requireCliRuntime, type CommandContext } from '../runtime.js';
import { UsageError, EXIT_CODES, printResult } from '../output.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rolled_back']);
const TERMINAL_EVENT_TYPES = new Set([
  'RUN_COMPLETED',
  'RUN_FAILED',
  'RUN_CANCELLED',
  'RUN_INTERRUPTED',
  'RUN_ROLLED_BACK',
]);

function requirePositional(ctx: CommandContext, index: number, name: string): string {
  const value = ctx.positionals[index];
  if (value === undefined) throw new UsageError(`Missing required argument: ${name}`);
  return value;
}

function parseLimit(raw: unknown, fallback = 20): number {
  if (raw === undefined || raw === false) return fallback;
  const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    const shown = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : 'invalid';
    throw new UsageError(`--limit must be an integer between 1 and 100, got: ${shown}`);
  }
  return n;
}

export async function runSearch(ctx: CommandContext): Promise<number> {
  const q = requirePositional(ctx, 0, '<query>');
  const kind = (ctx.values.kind as string | undefined) ?? 'claims';
  if (kind !== 'claims' && kind !== 'sources' && kind !== 'all') {
    throw new UsageError(`--kind must be claims|sources|all, got: ${kind}`);
  }
  const limit = parseLimit(ctx.values.limit);
  const { query } = requireCliRuntime(ctx);
  let data: unknown;
  if (kind === 'claims') data = query.listClaims({ q, limit });
  else if (kind === 'sources') data = query.listSources({ q, limit });
  else
    data = {
      claims: query.listClaims({ q, limit }),
      sources: query.listSources({ q, limit }),
    };
  printResult(ctx.io, data, 'search');
  return EXIT_CODES.OK;
}

export async function runClaim(ctx: CommandContext): Promise<number> {
  const id = requirePositional(ctx, 0, '<id>');
  const { query } = requireCliRuntime(ctx);
  const detail = query.getClaim(id);
  const claim = detail.data;
  if (claim === null) throw new EntityNotFoundError('claim', id);
  const data: Record<string, unknown> = { claim, readModel: detail.readModel };
  if (ctx.values.observations === true) {
    data.observations = query.listClaimObservationsForClaim({ claimId: id }).items;
  }
  if (ctx.values.evidence === true) {
    data.evidence = query.listEvidenceForClaim({ claimId: id }).items;
  }
  if (ctx.values.relations === true) {
    data.relations = query.listClaimRelations({ claimId: id }).items;
  }
  printResult(ctx.io, data, 'claim');
  return EXIT_CODES.OK;
}

export async function runSource(ctx: CommandContext): Promise<number> {
  const id = requirePositional(ctx, 0, '<id>');
  const detail = requireCliRuntime(ctx).query.getSource(id);
  if (detail.data === null) throw new EntityNotFoundError('source', id);
  printResult(ctx.io, { source: detail.data, readModel: detail.readModel }, 'source');
  return EXIT_CODES.OK;
}

export async function runRuns(ctx: CommandContext): Promise<number> {
  const app = requireCliRuntime(ctx).app;
  if (app === undefined) throw new UsageError('runs requires a writable runtime');
  const status = ctx.values.status as string | undefined;
  const familyId = ctx.values.family as string | undefined;
  const limit = parseLimit(ctx.values.limit, 50);
  const runs = app.listRuns({
    ...(status !== undefined ? { status } : {}),
    ...(familyId !== undefined ? { familyId } : {}),
    limit,
  });
  printResult(ctx.io, runs, 'runs');
  return EXIT_CODES.OK;
}

/** Emit a progress line for `run` — JSON-lines or short text on stderr. */
interface ProgressLike {
  event?: string;
  runId?: string;
  status?: string;
}
function emitRunProgress(io: CommandContext['io'], status: ProgressLike): void {
  if (io.json) {
    io.err.write(`${JSON.stringify(status)}\n`);
  } else {
    io.err.write(`run ${status.runId ?? ''}: ${status.status ?? ''}\n`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runStartRun(ctx: CommandContext): Promise<number> {
  const q = requirePositional(ctx, 0, '<query>');
  const app = requireCliRuntime(ctx).app;
  if (app === undefined) throw new UsageError('run requires a writable runtime');
  const started = await app.startRun({ query: q });
  emitRunProgress(ctx.io, { event: 'started', ...started });
  let final: Awaited<ReturnType<typeof app.getRun>> = null;
  while (final === null || !TERMINAL_RUN_STATUSES.has(final.status)) {
    await sleep(500);
    final = app.getRun(started.runId);
    if (final === null) throw new RunNotFoundError(started.runId);
    if (!TERMINAL_RUN_STATUSES.has(final.status)) emitRunProgress(ctx.io, final);
  }
  emitRunProgress(ctx.io, { event: 'finished', ...final });
  printResult(ctx.io, final, 'run');
  return final.status === 'completed' ? EXIT_CODES.OK : EXIT_CODES.INTERNAL;
}

/**
 * Follow a run's lifecycle events until a terminal event arrives.
 *
 * No --timeout by default is intentional: a run's lifecycle is naturally
 * bounded — it always ends in a terminal event (completed/failed/cancelled/
 * interrupted/rolled_back), so the loop terminates on its own. --timeout
 * exists purely as an operator escape hatch for wedged runs.
 */
export async function runWatch(ctx: CommandContext): Promise<number> {
  const runId = requirePositional(ctx, 0, '<run-id>');
  const app = requireCliRuntime(ctx).app;
  if (app === undefined) throw new UsageError('watch requires a writable runtime');
  if (app.getRun(runId) === null) throw new RunNotFoundError(runId);
  const timeoutRaw = ctx.values.timeout;
  let deadline: number | undefined;
  if (timeoutRaw !== undefined && timeoutRaw !== false) {
    const ms = Number(timeoutRaw);
    if (!Number.isInteger(ms) || ms <= 0) {
      throw new UsageError(`--timeout must be a positive integer (milliseconds), got: ${String(timeoutRaw)}`);
    }
    deadline = Date.now() + ms;
  }
  let afterSeq = 0;
  for (;;) {
    const events = app.listRunEvents({ runId, afterSeq });
    for (const event of events) {
      afterSeq = Math.max(afterSeq, event.seq);
      ctx.io.out.write(
        `${ctx.io.json ? JSON.stringify(event) : `${String(event.seq)}\t${event.eventType}\t${JSON.stringify(event.payload)}`}\n`,
      );
      if (TERMINAL_EVENT_TYPES.has(event.eventType)) return EXIT_CODES.OK;
    }
    if (deadline !== undefined) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new UsageError(`watch timed out after ${String(timeoutRaw)}ms without a terminal event`);
      await sleep(Math.min(500, remaining));
    } else {
      await sleep(500);
    }
  }
}
