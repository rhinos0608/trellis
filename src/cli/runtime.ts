/**
 * CLI runtime bootstrap — opens the DB, rebuilds the canonical projection,
 * and wires all application/query/curation services. No side effects at
 * import time; call `initCliRuntime` after argument parsing.
 */

import { graphEventHandlers } from '../graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../workspace/projectionHandlers.js';
import type { EventHandlerRegistry } from '../store/projectionState.js';
import { closeDb, getDb, initDb } from '../store/db.js';
import { rebuildProjection } from '../store/projectionBuilder.js';
import { getLatestEventCursor } from '../store/events.js';
import { getKnowledgeReadModelStatus, rebuildKnowledgeReadModel } from '../store/readModel/index.js';
import { loadConfig } from '../config/index.js';
import type { TrellisConfig } from '../config/index.js';
import type { Database } from 'better-sqlite3';
import { createRunService } from '../research/runService.js';
import type { RunService } from '../research/runService.js';
import { createResearchApplicationService } from '../app/researchService.js';
import type { ResearchApplicationService } from '../app/researchService.js';
import { createKnowledgeQueryService } from '../query/service.js';
import type { KnowledgeQueryService } from '../query/service.js';
import { createCurationApplicationService } from '../app/curationService.js';
import type { CurationApplicationService } from '../app/curationService.js';
import { getProvider as getSharedProvider, closeProvider } from '../providers/searchMcp/owner.js';
import type { CliIo } from './output.js';

/** Parsed flag values from node:util.parseArgs. */
export type CliValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

/** Everything a command handler needs to run. */
export interface CommandContext {
  io: CliIo;
  rt?: CliRuntime;
  values: CliValues;
  positionals: string[];
}

/** Merged domain handler registry — same composition as runService. */
export function requireCliRuntime(ctx: CommandContext): CliRuntime {
  if (ctx.rt === undefined) throw new Error('Command requires initialized runtime');
  return ctx.rt;
}

export const ALL_HANDLERS: EventHandlerRegistry = {
  ...graphEventHandlers,
  ...workspaceEventHandlers,
};

export interface CliRuntime {
  db: Database;
  /** Effective DB path actually opened (CLI --db flag or config default). */
  dbPath: string;
  /** Undefined in read-only runtimes (`doctor`/`verify`) — never constructed there. */
  app?: ResearchApplicationService;
  query: KnowledgeQueryService;
  curation: CurationApplicationService;
  /** Undefined in read-only runtimes — RunService can reconcile stale runs (a write). */
  runService?: RunService;
  config: TrellisConfig;
  /** Set when the canonical projection failed to rebuild (corrupt event log). */
  bootstrapError?: Error;
}

export interface CliRuntimeOptions {
  dbPath?: string | undefined;
  /** Open the DB read-only and skip every write path: no migrations, no
   *  checkpoint writes, no read-model self-heal, no RunService. Required for
   *  `doctor`/`verify` so inspection cannot self-heal corruption it should
   *  be reporting. */
  readOnly?: boolean | undefined;
}

/**
 * Initialize DB + services. Rebuilds the projection (forceGenesis) so read
 * models and checkpoints are consistent before any command runs.
 */
export function initCliRuntime(opts: CliRuntimeOptions = {}): CliRuntime {
  const config = loadConfig();
  const dbPath = opts.dbPath ?? config.storage.dbPath;

  // Read-only mode: raw connection, zero writes. The replay below uses
  // writeCheckpoint:false — its ProjectionState exists only in memory for
  // comparison against stored read-model rows.
  if (opts.readOnly === true) {
    const roDb = initDb(dbPath, { readonly: true });
    if (roDb === null) {
      throw new Error(`Failed to open database (read-only) at ${dbPath}`);
    }
    let bootstrapError: Error | undefined;
    try {
      rebuildProjection(ALL_HANDLERS, { forceGenesis: true, writeCheckpoint: false });
    } catch (err) {
      bootstrapError = err instanceof Error ? err : new Error(String(err));
    }
    return {
      db: roDb,
      dbPath,
      query: createKnowledgeQueryService(roDb),
      curation: createCurationApplicationService({ handlers: ALL_HANDLERS }),
      config,
      ...(bootstrapError !== undefined ? { bootstrapError } : {}),
    };
  }

  const db = initDb(dbPath);
  if (db === null) {
    throw new Error(`Failed to open database at ${dbPath}`);
  }
  let bootstrapError: Error | undefined;
  try {
    rebuildProjection(ALL_HANDLERS);
  } catch (err) {
    // Corrupt event log — `verify`/`doctor` must still run over raw rows.
    bootstrapError = err instanceof Error ? err : new Error(String(err));
  }
  // Self-heal the knowledge read model: it starts 'dirty' at migration time
  // and incremental syncs preserve that flag, so bring it to ready/caught-up.
  const latestSeq = getLatestEventCursor();
  if (bootstrapError === undefined) {
    try {
      const rm = getKnowledgeReadModelStatus();
      if (rm.status !== 'ready' || (latestSeq !== null && rm.lastAppliedSeq !== latestSeq)) {
        rebuildKnowledgeReadModel(ALL_HANDLERS);
      }
    } catch {
      try {
        rebuildKnowledgeReadModel(ALL_HANDLERS);
      } catch (rebuildErr) {
        bootstrapError = rebuildErr instanceof Error ? rebuildErr : new Error(String(rebuildErr));
      }
    }
  }
  const runService = createRunService();
  const app = createResearchApplicationService({
    runService,
    config,
    getProvider: () => getSharedProvider(config),
  });
  const query = createKnowledgeQueryService(getDb() ?? db);
  const curation = createCurationApplicationService({ handlers: ALL_HANDLERS });
  return { db, dbPath, app, query, curation, runService, config, ...(bootstrapError !== undefined ? { bootstrapError } : {}) };
}

export interface ShutdownCliRuntimeOptions {
  /** Invoked AFTER provider close and BEFORE the DB closes — e.g. HTTP
   *  transport drain. Keeps the canonical ordering: scheduler → provider →
   *  transport → DB last. */
  beforeDbClose?: () => Promise<void>;
}

/**
 * Ordered teardown: scheduler shutdown (aborts active runs, appends final
 * RUN_INTERRUPTED events — these writes NEED the DB open) → provider close →
 * optional transport drain → DB close LAST. Safe to call multiple times.
 */
export async function shutdownCliRuntime(rt?: CliRuntime, opts: ShutdownCliRuntimeOptions = {}): Promise<void> {
  let firstError: unknown;
  const attempt = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (err) {
      firstError ??= err;
    }
  };

  const runService = rt?.runService;
  if (runService !== undefined) await attempt(() => runService.shutdownScheduler());
  await attempt(() => closeProvider());
  await attempt(async () => { await opts.beforeDbClose?.(); });
  await attempt(async () => { closeDb(); });
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (firstError !== undefined) throw firstError;
}
