#!/usr/bin/env node
/**
 * Trellis operator CLI entry point.
 *
 * Usage: trellis [--db <path>] [--json] <command> [args]
 *
 * Exit codes: 0 success · 1 internal error · 2 usage error ·
 *             3 integrity failure · 4 domain conflict · 130 interrupted.
 *
 * No side effects at import time — `main()` runs only when this module is
 * the process entry point; tests import `runCli` directly.
 */

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { CliIo } from './output.js';
import { EXIT_CODES, UsageError, printError } from './output.js';
import { initCliRuntime, shutdownCliRuntime } from './runtime.js';
import type { CliValues, CommandContext } from './runtime.js';
import * as read from './commands/read.js';
import * as curation from './commands/curation.js';
import * as operations from './commands/operations.js';

interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
}

interface CommandSpec {
  description: string;
  usage: string;
  options?: Record<string, OptionSpec>;
  /** Run against a read-only runtime (no migrations/rebuild/self-heal). */
  readOnly?: boolean;
  run(ctx: CommandContext): Promise<number>;
}

/** Flags accepted by every subcommand. */
const BASE_OPTIONS: Record<string, OptionSpec> = {
  db: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const CURATION_FLAGS: Record<string, OptionSpec> = {
  reason: { type: 'string' },
  actor: { type: 'string' },
  seq: { type: 'string' },
  'command-id': { type: 'string' },
};

const COMMANDS: Record<string, CommandSpec> = {
  search: {
    description: 'Full-text search over claims/sources',
    usage: 'trellis search <query> [--kind claims|sources|all] [--limit N]',
    options: { kind: { type: 'string' }, limit: { type: 'string' } },
    run: read.runSearch,
  },
  claim: {
    description: 'Show a claim; optionally its children',
    usage: 'trellis claim <id> [--observations] [--evidence] [--relations]',
    options: { observations: { type: 'boolean' }, evidence: { type: 'boolean' }, relations: { type: 'boolean' } },
    run: read.runClaim,
  },
  source: {
    description: 'Show a source',
    usage: 'trellis source <id>',
    run: read.runSource,
  },
  runs: {
    description: 'List research runs',
    usage: 'trellis runs [--status <status>] [--family <id>] [--limit N]',
    options: { status: { type: 'string' }, family: { type: 'string' }, limit: { type: 'string' } },
    run: read.runRuns,
  },
  run: {
    description: 'Start a research run and wait until terminal',
    usage: 'trellis run <query>',
    run: read.runStartRun,
  },
  watch: {
    description: 'Follow a run\u2019s lifecycle events until terminal',
    usage: 'trellis watch <run-id> [--timeout ms]',
    options: { timeout: { type: 'string' } },
    run: read.runWatch,
  },
  merge: {
    description: 'Merge source claim into survivor claim',
    usage: 'trellis merge <source> <survivor> --reason R --actor A --seq N',
    options: CURATION_FLAGS,
    run: curation.runMerge,
  },
  split: {
    description: 'Split a claim per a partition plan JSON file',
    usage: 'trellis split <source> --input <file> --reason R --actor A --seq N',
    options: { input: { type: 'string' }, ...CURATION_FLAGS },
    run: curation.runSplit,
  },
  retract: {
    description: 'Retract/restore a claim or observation',
    usage: 'trellis retract <target-id> --kind claim|observation [--restore] --reason R --actor A --seq N',
    options: { kind: { type: 'string' }, restore: { type: 'boolean' }, ...CURATION_FLAGS },
    run: curation.runRetract,
  },
  'curate-relation': {
    description: 'Add or remove a curated claim relation',
    usage:
      'trellis curate-relation add --from C1 --to C2 --type supports|contradicts [--relation-id ID] [--strength strong|weak] | remove --relation-id ID (both: --reason R --actor A --seq N)',
    options: {
      'relation-id': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      type: { type: 'string' },
      strength: { type: 'string' },
      score: { type: 'string' },
      ...CURATION_FLAGS,
    },
    run: curation.runCurateRelation,
  },
  'override-stance': {
    description: 'Override an evidence record\u2019s stance',
    usage: 'trellis override-stance <evidence-id> supports|opposes --reason R --actor A --seq N',
    options: CURATION_FLAGS,
    run: curation.runOverrideStance,
  },
  doctor: {
    description: 'Read-only diagnostics over the database',
    usage: 'trellis doctor [--provider]',
    options: { provider: { type: 'boolean' } },
    readOnly: true,
    run: operations.runDoctor,
  },
  verify: {
    description: 'Strict full-scan event-store + read-model verification',
    usage: 'trellis verify',
    readOnly: true,
    run: operations.runVerify,
  },
  migrate: {
    description: 'Apply pending migrations (idempotent)',
    usage: 'trellis migrate',
    run: operations.runMigrate,
  },
  rebuild: {
    description: 'Rebuild derived state',
    usage: 'trellis rebuild read-model',
    run: operations.runRebuild,
  },
  serve: {
    description: 'Start the loopback HTTP server',
    usage: 'trellis serve [--port N]',
    options: { port: { type: 'string' } },
    run: operations.runServe,
  },
};

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function usageText(command: string | undefined): string {
  const lines = [
    'Trellis operator CLI',
    '',
    'Usage: trellis [--db <path>] [--json] <command> [args]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, spec]) => `  ${name.padEnd(16)} ${spec.description}`),
    '',
    'Global flags: --db <path>  --json  --help/-h  (--version)',
    `Exit codes: 0 ok · 1 internal · 2 usage · 3 integrity · 4 conflict · 130 interrupted`,
  ];
  const spec = command === undefined ? undefined : COMMANDS[command];
  if (spec !== undefined) {
    lines.push('', spec.usage);
  }
  return lines.join('\n');
}

/**
 * Run one CLI invocation. Returns the process exit code.
 * Never calls process.exit — callers assign `process.exitCode`.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // Pre-scan leading global flags so they work before the subcommand too.
  let index = 0;
  let globalDb: string | undefined;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--db') {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError('--db requires a path argument');
      globalDb = value;
      index += 2;
    } else if (arg === '--json' || arg === '--help' || arg === '-h') {
      index += 1; // handled again by per-command parsing
    } else {
      break;
    }
  }
  const [name, ...rest] = argv.slice(index);
  const command = name ?? '';

  if (command === '--version') {
    io.out.write(`${getVersion()}\n`);
    return EXIT_CODES.OK;
  }
  if (command === '' || command === 'help' || command === '--help' || command === '-h') {
    const target = command === 'help' ? rest[0] : undefined;
    (command === '' ? io.err : io.out).write(`${usageText(target)}\n`);
    return command === '' ? EXIT_CODES.USAGE : EXIT_CODES.OK;
  }

  const spec = COMMANDS[command];
  if (spec === undefined) {
    io.err.write(`${usageText(undefined)}\n`);
    return printError(io, new UsageError(`Unknown command: ${command}`), command);
  }

  let rt: ReturnType<typeof initCliRuntime> | null = null;
  try {
    let parsed: { values: CliValues; positionals: string[] };
    try {
      const result = parseArgs({
        args: rest,
        options: { ...BASE_OPTIONS, ...(spec.options ?? {}) },
        allowPositionals: true,
        strict: true,
      });
      parsed = { values: result.values, positionals: result.positionals };
    } catch (err) {
      throw new UsageError(err instanceof Error ? err.message : String(err));
    }
    const { values, positionals } = parsed;
    if (values.help === true) {
      io.out.write(`${usageText(command)}\n`);
      return EXIT_CODES.OK;
    }
    rt = initCliRuntime({
      dbPath: typeof values.db === 'string' ? values.db : globalDb,
      readOnly: spec.readOnly === true,
    });
    try {
      return await spec.run({ io, rt, values, positionals });
    } finally {
      await shutdownCliRuntime();
    }
  } catch (err) {
    if (rt !== null) await shutdownCliRuntime();
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'SIGINT')) {
      return EXIT_CODES.INTERRUPTED;
    }
    return printError(io, err, command);
  }
}

/** Process entry point — sets process.exitCode, never throws. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const io: CliIo = {
    out: process.stdout,
    err: process.stderr,
    json: argv.includes('--json'),
  };
  try {
    process.exitCode = await runCli(argv, io);
  } catch (err) {
    process.exitCode = printError(io, err, 'trellis');
  }
}

// Run only when executed directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
