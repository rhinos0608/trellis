/**
 * CLI integration tests — real temp-file SQLite DB, real CLI invocation via
 * runCli() with captured stdout/stderr (scenario 10 spawns the built binary).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import type { ClaimObservation } from '../../src/graph/types.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import type { TrellisEventType } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';
import { appendEvents, closeDb, getLatestEventCursor, initDb, rebuildProjection } from '../../src/store/index.js';
import { rebuildKnowledgeReadModel } from '../../src/store/readModel/index.js';
import { runCli } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };

// ── Capture streams ──────────────────────────────────────────────────

class StringWriter {
  private readonly parts: string[] = [];
  write(chunk: unknown): boolean {
    this.parts.push(String(chunk));
    return true;
  }
  get value(): string {
    return this.parts.join('');
  }
}

function makeIo(json: boolean): { io: CliIo; out: StringWriter; err: StringWriter } {
  const out = new StringWriter();
  const err = new StringWriter();
  return { io: { out: out as unknown as NodeJS.WritableStream, err: err as unknown as NodeJS.WritableStream, json }, out, err };
}

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const { io, out, err } = makeIo(args.includes('--json'));
  const code = await runCli(['--db', dbPath, ...args], io);
  return { code, out: out.value, err: err.value };
}

/** Parse the last JSON line written to stdout. */
function lastJson<T>(out: string): T & { ok: boolean; command: string } {
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '') as T & { ok: boolean; command: string };
}

// ── Seeding helpers (same shapes as test/app/curationService.test.ts) ──

let tempDir: string;
let dbPath: string;

function event(eventType: TrellisEventType, payload: unknown, timestamp = '2025-01-01T00:00:00.000Z'): NewEventInput {
  return { timestamp, eventType, eventVersion: eventType === 'EVIDENCE_LINKED' ? 2 : 1, runId: 'run-cli', batchId: null, actor: 'user', actorId: 'operator', entityId: null, entityType: null, payload } as NewEventInput;
}

function assertion(subjectText: string, predicate = 'improves') {
  return { subjectText, predicate, objectText: 'research', polarity: 'asserted' as const, hedge: 'certain' as const, evidenceType: 'study' as const, canonicalKey: { subject: subjectText.toLowerCase(), predicate } };
}

function observation(id: string, claimId: string, observedAt: string): ClaimObservation {
  return { ...assertion(claimId), id, familyId: 'family-1', runId: 'run-cli', observedAt, confidence: 0.7, sourceIds: ['source-1'], extractionVersion: 'v1' };
}

function claimSeed(id: string): NewEventInput {
  return event('CLAIM_ACCEPTED', { ...assertion(id), id, familyId: 'family-1', confidence: 0.5, contradictionState: 'none', firstSeenRunId: 'run-cli', lastSeenRunId: 'run-cli' });
}

function observed(o: ClaimObservation, claimId: string, first = false): NewEventInput {
  return event('CLAIM_OBSERVED', { observation: o, reconciliation: { observationId: o.id, classification: first ? 'new_claim' : 'same_claim', canonicalClaimId: claimId, ...(first ? {} : { matchedClaimId: claimId }), score: 1, method: 'canonical_key_exact', rationale: 'test', reconcilerVersion: 1, candidates: [] } }, o.observedAt);
}

function seed(inputs: readonly NewEventInput[]): void {
  appendEvents(inputs, { projection: rebuildProjection(handlers), handlers });
}

function currentSeq(): number {
  return getLatestEventCursor() ?? 0;
}

/** Seed two active claims (claim-a, claim-b) plus a searchable claim. */
function seedBase(): void {
  const a = observation('obs-a', 'claim-a', '2025-01-01T00:00:01.000Z');
  const b = observation('obs-b', 'claim-b', '2025-01-01T00:00:02.000Z');
  const t = observation('obs-t', 'test-claim', '2025-01-01T00:00:03.000Z');
  seed([
    event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }),
    event('SOURCE_ADDED', { id: 'source-1', url: 'https://example.test/source', domain: 'example.test', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', contentHash: 'hash', retrievedAt: '2025-01-01T00:00:00.000Z', firstSeenRunId: 'run-cli' }),
    claimSeed('claim-a'), claimSeed('claim-b'), claimSeed('test-claim'),
    observed(a, 'claim-a', true), observed(b, 'claim-b', true), observed(t, 'test-claim', true),
    event('EVIDENCE_LINKED', { id: 'evd-a-1', claimId: 'claim-a', sourceId: 'source-1', stance: 'supports', excerpt: 'evidence a', runId: 'run-cli', observationId: 'obs-a' }, '2025-01-01T00:00:01.000Z'),
    event('EVIDENCE_LINKED', { id: 'evd-b-1', claimId: 'claim-b', sourceId: 'source-1', stance: 'supports', excerpt: 'evidence b', runId: 'run-cli', observationId: 'obs-b' }, '2025-01-01T00:00:02.000Z'),
    event('EVIDENCE_LINKED', { id: 'evd-t-1', claimId: 'test-claim', sourceId: 'source-1', stance: 'supports', excerpt: 'evidence t', runId: 'run-cli', observationId: 'obs-t' }, '2025-01-01T00:00:03.000Z'),
  ]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-cli-'));
  dbPath = path.join(tempDir, 'trellis.db');
  expect(initDb(dbPath)).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('trellis CLI', () => {
  it('doctor exits 0 and reports check results', async () => {
    seedBase();
    // Emulate the writable-runtime startup self-heal: raw store seeding
    // leaves the knowledge read model flagged dirty.
    rebuildKnowledgeReadModel(handlers);
    const { code, out } = await run(['doctor', '--json']);
    expect(code).toBe(0);
    const body = lastJson<{ data: { overall: string; checks: { name: string; status: string }[] } }>(out);
    expect(body.ok).toBe(true);
    expect(body.data.overall).toBe('ok');
    const names = body.data.checks.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['database', 'quick_check', 'migrations', 'event_log', 'read_model']));
  });

  it('verify exits 0 on a clean DB and 3 on a corrupted payload', async () => {
    seedBase();
    const clean = await run(['verify', '--json']);
    expect(clean.code).toBe(0);
    const cleanBody = lastJson<{ data: { passed: boolean } }>(clean.out);
    expect(cleanBody.ok).toBe(true);
    expect(cleanBody.data.passed).toBe(true);

    // Corrupt the stored payload of one event, bypassing the app layer.
    closeDb();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE events SET payload = payload || ' ' WHERE seq = (SELECT MIN(seq) FROM events)").run();
    raw.close();

    const { io, out } = makeIo(true);
    const code = await runCli(['--db', dbPath, 'verify'], io);
    expect(code).toBe(3);
    const body = lastJson<{ data: { passed: boolean; mismatches: string[] } }>(out.value);
    expect(body.ok).toBe(true);
    expect(body.data.passed).toBe(false);
    expect(body.data.mismatches.length).toBeGreaterThan(0);

    // Reopen the singleton for afterEach cleanup.
    expect(initDb(dbPath)).not.toBeNull();
  });

  it('verify catches evidence-integrity violation for claim without evidence', async () => {
    seedBase();
    // Append a claim without any EVIDENCE_LINKED events
    seed([
      claimSeed('claim-no-evidence'),
    ]);
    const { code, out } = await run(['verify', '--json']);
    expect(code).toBe(3);
    const body = lastJson<{ data: { passed: boolean; mismatches: string[] } }>(out);
    expect(body.data.passed).toBe(false);
    expect(body.data.mismatches.some((m) => m.includes('claim-no-evidence') && m.includes('no valid evidence'))).toBe(true);
  });

  it('migrate exits 0 and reports the current schema version', async () => {
    const { code, out } = await run(['migrate', '--json']);
    expect(code).toBe(0);
    const body = lastJson<{ data: { currentVersion: number } }>(out);
    expect(body.ok).toBe(true);
    expect(body.data.currentVersion).toBeGreaterThanOrEqual(4);
  });

  it('search --json returns a JSON envelope with matching claims', async () => {
    seedBase();
    const { code, out } = await run(['search', 'test', '--json']);
    expect(code).toBe(0);
    const body = lastJson<{ data: { items: { id: string }[] } }>(out);
    expect(body.ok).toBe(true);
    expect(body.command).toBe('search');
    expect(body.data.items.map((c) => c.id)).toContain('test-claim');
  });

  it('runs --json returns a JSON envelope with the run list', async () => {
    seedBase();
    const { code, out } = await run(['runs', '--json']);
    expect(code).toBe(0);
    const body = lastJson<{ data: unknown[] }>(out);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('claim <id> --json returns the claim detail', async () => {
    seedBase();
    const { code, out } = await run(['claim', 'claim-a', '--observations', '--json']);
    expect(code).toBe(0);
    const body = lastJson<{ data: { claim: { id: string }; observations: unknown[] } }>(out);
    expect(body.ok).toBe(true);
    expect(body.data.claim.id).toBe('claim-a');
    // CLAIM_ACCEPTED seeds a legacy observation; CLAIM_OBSERVED adds one more.
    expect(body.data.observations.length).toBe(2);
    expect(body.data.observations.map((o) => (o as { id: string }).id)).toContain('obs-a');
  });

  it('claim/source missing entities return ENTITY_NOT_FOUND, not RUN_NOT_FOUND', async () => {
    seedBase();
    const claimResult = await run(['claim', 'missing-claim', '--json']);
    expect(claimResult.code).toBe(1);
    expect(lastJson<{ error: { code: string } }>(claimResult.out).error.code).toBe('ENTITY_NOT_FOUND');
    const sourceResult = await run(['source', 'missing-source', '--json']);
    expect(sourceResult.code).toBe(1);
    expect(lastJson<{ error: { code: string } }>(sourceResult.out).error.code).toBe('ENTITY_NOT_FOUND');
  });

  it('merge --json appends CLAIM_MERGED and returns the curation result', async () => {
    seedBase();
    const { code, out } = await run([
      'merge', 'claim-a', 'claim-b',
      '--reason', 'test', '--actor', 'test', '--seq', String(currentSeq()), '--command-id', 'cli-merge-1', '--json',
    ]);
    expect(code).toBe(0);
    const body = lastJson<{ data: { eventType: string; deduplicated: boolean; commandId: string } }>(out);
    expect(body.ok).toBe(true);
    expect(body.data.eventType).toBe('CLAIM_MERGED');
    expect(body.data.commandId).toBe('cli-merge-1');
    expect(body.data.deduplicated).toBe(false);
  });

  it('retract <claim-id> --kind claim --json returns the retraction result', async () => {
    seedBase();
    const { code, out } = await run([
      'retract', 'claim-a', '--kind', 'claim',
      '--reason', 'test', '--actor', 'test', '--seq', String(currentSeq()), '--json',
    ]);
    expect(code).toBe(0);
    const body = lastJson<{ data: { eventType: string } }>(out);
    expect(body.ok).toBe(true);
    expect(body.data.eventType).toBe('CLAIM_RETRACTION_SET');
  });

  it('rejects blank and non-numeric --seq with exit 2', async () => {
    seedBase();
    const blank = await run(['retract', 'claim-a', '--kind', 'claim', '--reason', 'r', '--actor', 'a', '--seq', '', '--json']);
    expect(blank.code).toBe(2);
    expect(lastJson<{ error: { code: string } }>(blank.out).error.code).toBe('USAGE_ERROR');

    const junk = await run(['merge', 'claim-a', 'claim-b', '--reason', 'r', '--actor', 'a', '--seq', '12abc', '--json']);
    expect(junk.code).toBe(2);
  });

  it('rejects an unknown --type on curate-relation add with exit 2', async () => {
    seedBase();
    const { code, out } = await run([
      'curate-relation', 'add', '--from', 'claim-a', '--to', 'claim-b', '--type', 'bogus',
      '--reason', 'r', '--actor', 'a', '--seq', String(currentSeq()), '--json',
    ]);
    expect(code).toBe(2);
    expect(lastJson<{ error: { code: string } }>(out).error.code).toBe('USAGE_ERROR');
  });

  it('rejects an oversized split --input file with exit 2', async () => {
    seedBase();
    const bigPath = path.join(tempDir, 'big.json');
    fs.writeFileSync(bigPath, Buffer.alloc(10 * 1024 * 1024 + 1));
    const { code } = await run([
      'split', 'claim-a', '--input', bigPath,
      '--reason', 'r', '--actor', 'a', '--seq', '1', '--json',
    ]);
    expect(code).toBe(2);
  });

  it('doctor and verify perform zero writes (read-only runtime)', async () => {
    seedBase();
    rebuildKnowledgeReadModel(handlers); // same heal a writable runtime performs at startup
    closeDb(); // release the writable handle so the main DB file is stable
    const before = fs.readFileSync(dbPath);
    expect(before.length).toBeGreaterThan(0);

    const d = await run(['doctor', '--json']);
    expect(d.code).toBe(0);
    const v = await run(['verify', '--json']);
    expect(v.code).toBe(0);
    expect(lastJson<{ data: { passed: boolean } }>(v.out).data.passed).toBe(true);

    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('masks internal errors in JSON output and logs details to stderr', async () => {
    const missingPath = path.join(tempDir, 'missing', 'x.db');
    const { io, out, err } = makeIo(true);
    const code = await runCli(['--db', missingPath, 'doctor', '--json'], io);
    expect(code).toBe(1);
    const body = lastJson<{ ok: boolean; error: { code: string; message: string } }>(out.value);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('An internal error occurred');
    // The real diagnostics (including the raw path) stay on stderr only.
    expect(out.value).not.toContain(missingPath);
    expect(err.value).toContain(missingPath);
  });

  it('unknown command exits 2 with a usage error', async () => {
    const { code, out } = await run(['frobnicate', '--json']);
    expect(code).toBe(2);
    const body = lastJson<{ ok: boolean; error: { code: string } }>(out);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('USAGE_ERROR');
  });

  it('serve starts on loopback, answers /healthz, and shuts down on SIGTERM', { timeout: 20_000 }, async () => {
    seedBase();
    closeDb();
    const bin = path.join(import.meta.dirname ?? '.', '..', '..', 'dist', 'cli', 'main.js');
    const child = spawn(process.execPath, [bin, 'serve', '--db', dbPath, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk.toString()));

    try {
      // Wait for the listening banner on stderr.
      const deadline = Date.now() + 10_000;
      let banner = '';
      while (Date.now() < deadline) {
        banner = stderrChunks.join('');
        if (/listening on 127\.0\.0\.1:\d+/.test(banner)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(banner);
      expect(match).not.toBeNull();
      const port = Number(match?.[1]);

      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => resolve(res.statusCode ?? 0));
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('healthz timeout')); });
      });
      expect(status).toBe(200);

      child.kill('SIGTERM');
      const exitCode = await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
