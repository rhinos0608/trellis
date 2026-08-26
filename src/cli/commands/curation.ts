/**
 * Curation CLI commands: merge, split, retract, curate-relation,
 * override-stance. All wrap CurationApplicationService commands.
 *
 * Human output is deferred — these commands always emit the JSON envelope.
 */

import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { generateUlid } from '../../store/events.js';
import type { ClaimRelationType } from '../../graph/types.js';
import { requireCliRuntime, type CommandContext } from '../runtime.js';
import { UsageError, EXIT_CODES, printResult } from '../output.js';

/** Read a string flag value from parsed args. */
function flag(ctx: CommandContext, key: string): string | undefined {
  const value = ctx.values[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reject operator-provided split plans beyond this size (local file, generous bound). */
const MAX_SPLIT_INPUT_BYTES = 10 * 1024 * 1024;

/** Exact ClaimRelationType values (src/graph/types.ts) — validated before event append. */
const CLAIM_RELATION_TYPES: readonly ClaimRelationType[] = [
  'same_claim',
  'near_duplicate',
  'supports',
  'elaborates',
  'qualifies',
  'contradicts',
  'background',
];

function hasFlag(ctx: CommandContext, key: string): boolean {
  return ctx.values[key] === true;
}

/** Parse shared curation flags; command-id enables safe CLI retries. */
function parseCommandBase(ctx: CommandContext): {
  commandId: string;
  reason: string;
  actorId: string;
  expectedSeq: number;
} {
  const reason = flag(ctx, 'reason');
  const actor = flag(ctx, 'actor');
  const seq = flag(ctx, 'seq');
  const commandId = flag(ctx, 'command-id');
  if (reason === undefined || reason === '') throw new UsageError('--reason is required');
  if (actor === undefined || actor === '') throw new UsageError('--actor is required');
  // Validate the raw string BEFORE Number(): Number('') === 0 and would
  // silently target projection seq 0 — dangerous for destructive commands.
  if (seq === undefined || !/^\d+$/.test(seq)) {
    throw new UsageError(`--seq must be a non-negative integer (current projection lastAppliedSeq), got: ${String(seq)}`);
  }
  const expectedSeq = Number(seq);
  return { commandId: commandId === undefined || commandId === '' ? generateUlid() : commandId, reason, actorId: actor, expectedSeq };
}

function requirePositional(ctx: CommandContext, index: number, name: string): string {
  const value = ctx.positionals[index];
  if (value === undefined) throw new UsageError(`Missing required argument: ${name}`);
  return value;
}

export async function runMerge(ctx: CommandContext): Promise<number> {
  const sourceClaimId = requirePositional(ctx, 0, '<source>');
  const survivorClaimId = requirePositional(ctx, 1, '<survivor>');
  const result = requireCliRuntime(ctx).curation.mergeClaims({
    ...parseCommandBase(ctx),
    sourceClaimId,
    survivorClaimId,
  });
  printResult(ctx.io, result, 'merge');
  return EXIT_CODES.OK;
}

const splitResultSchema = z.object({
  claimId: z.string().min(1),
  currentObservationId: z.string().min(1),
  observationIds: z.array(z.string().min(1)).min(1),
  evidenceIds: z.array(z.string().min(1)),
});

export async function runSplit(ctx: CommandContext): Promise<number> {
  const sourceClaimId = requirePositional(ctx, 0, '<source>');
  const inputPath = flag(ctx, 'input');
  if (inputPath === undefined || inputPath === '') throw new UsageError('--input <file> is required');
  let fileSize: number;
  try {
    fileSize = statSync(inputPath).size;
  } catch (err) {
    throw new UsageError(`Cannot read partition plan from ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (fileSize > MAX_SPLIT_INPUT_BYTES) {
    throw new UsageError(
      `--input file exceeds the ${String(MAX_SPLIT_INPUT_BYTES)}-byte limit (${String(fileSize)} bytes): ${inputPath}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
  } catch (err) {
    throw new UsageError(`Cannot read partition plan from ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = z.object({ results: z.array(splitResultSchema).min(2) }).safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(`Partition plan invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const result = requireCliRuntime(ctx).curation.splitClaim({
    ...parseCommandBase(ctx),
    sourceClaimId,
    results: parsed.data.results,
  });
  printResult(ctx.io, result, 'split');
  return EXIT_CODES.OK;
}

export async function runRetract(ctx: CommandContext): Promise<number> {
  const targetId = requirePositional(ctx, 0, '<target-id>');
  const kind = flag(ctx, 'kind');
  if (kind !== 'claim' && kind !== 'observation') {
    throw new UsageError(`--kind must be claim|observation, got: ${String(kind)}`);
  }
  const retracted = !hasFlag(ctx, 'restore');
  const result = requireCliRuntime(ctx).curation.setRetraction({
    ...parseCommandBase(ctx),
    target: { kind, id: targetId },
    retracted,
  });
  printResult(ctx.io, result, 'retract');
  return EXIT_CODES.OK;
}

export async function runCurateRelation(ctx: CommandContext): Promise<number> {
  const action = requirePositional(ctx, 0, '<action>');
  const base = parseCommandBase(ctx);
  if (action === 'remove') {
    const relationId = flag(ctx, 'relation-id');
    if (relationId === undefined || relationId === '') throw new UsageError('--relation-id is required');
    const result = requireCliRuntime(ctx).curation.curateRelation({ ...base, action: 'remove', relationId });
    printResult(ctx.io, result, 'curate-relation');
    return EXIT_CODES.OK;
  }
  if (action === 'add') {
    const relationId = flag(ctx, 'relation-id') ?? generateUlid();
    const fromClaimId = flag(ctx, 'from');
    const toClaimId = flag(ctx, 'to');
    const relationTypeRaw = flag(ctx, 'type');
    const strengthRaw = flag(ctx, 'strength') ?? 'moderate';
    if (fromClaimId === undefined || toClaimId === undefined || relationTypeRaw === undefined) {
      throw new UsageError('add requires --from <claim> --to <claim> --type <supports|contradicts|...>');
    }
    if (!CLAIM_RELATION_TYPES.includes(relationTypeRaw as ClaimRelationType)) {
      throw new UsageError(
        `--type must be one of ${CLAIM_RELATION_TYPES.join('|')}, got: ${relationTypeRaw}`,
      );
    }
    const relationType = relationTypeRaw as ClaimRelationType;
    if (strengthRaw !== 'strong' && strengthRaw !== 'weak') {
      throw new UsageError(`--strength must be strong|weak, got: ${strengthRaw}`);
    }
    const scoreRaw = flag(ctx, 'score');
    const score = scoreRaw === undefined ? 1 : Number(scoreRaw);
    if (!Number.isFinite(score)) throw new UsageError(`--score must be a number, got: ${String(scoreRaw)}`);
    const result = requireCliRuntime(ctx).curation.curateRelation({
      ...base,
      action: 'upsert',
      relation: {
        id: relationId,
        fromClaimId,
        toClaimId,
        relation: relationType,
        strength: strengthRaw,
        score,
        rationale: base.reason,
        runId: `curation:${base.commandId}`,
      },
    });
    printResult(ctx.io, result, 'curate-relation');
    return EXIT_CODES.OK;
  }
  throw new UsageError(`<action> must be add|remove, got: ${action}`);
}

export async function runOverrideStance(ctx: CommandContext): Promise<number> {
  const evidenceId = requirePositional(ctx, 0, '<evidence-id>');
  const stance = requirePositional(ctx, 1, '<stance>');
  if (stance !== 'supports' && stance !== 'opposes') {
    throw new UsageError(`<stance> must be supports|opposes, got: ${stance}`);
  }
  const result = requireCliRuntime(ctx).curation.overrideEvidenceStance({
    ...parseCommandBase(ctx),
    evidenceId,
    stance,
  });
  printResult(ctx.io, result, 'override-stance');
  return EXIT_CODES.OK;
}
