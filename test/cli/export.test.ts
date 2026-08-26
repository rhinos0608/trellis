/**
 * Tests for `trellis export` CLI command.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import type { TrellisEventType } from '../../src/store/eventTypes.js';
import type { NewEventInput } from '../../src/store/events.js';
import { appendEvents, closeDb, getLatestEventCursor, initDb, rebuildProjection } from '../../src/store/index.js';
import { rebuildKnowledgeReadModel } from '../../src/store/readModel/index.js';
import { runCli } from '../../src/cli/main.js';
import type { CliIo } from '../../src/cli/output.js';
import { hashPayload } from '../../src/store/events.js';

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

function lastJson<T>(out: string): T & { ok: boolean; command: string } {
  const lines = out.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '') as T & { ok: boolean; command: string };
}

// ── Seeding helpers ──

let tempDir: string;
let dbPath: string;

function event(eventType: TrellisEventType, payload: unknown, timestamp = '2025-01-01T00:00:00.000Z'): NewEventInput {
  return { timestamp, eventType, eventVersion: eventType === 'EVIDENCE_LINKED' ? 2 : 1, runId: 'run-export', batchId: null, actor: 'user', actorId: 'operator', entityId: null, entityType: null, payload } as NewEventInput;
}

function seedBase(): void {
  appendEvents([
    event('FAMILY_CREATED', { family_id: 'family-1', label: 'Family' }),
    event('SOURCE_ADDED', { id: 'source-1', url: 'https://example.test/source', domain: 'example.test', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', contentHash: 'hash', retrievedAt: '2025-01-01T00:00:00.000Z', firstSeenRunId: 'run-export' }),
    event('NODE_ADDED', { id: 'entity-1', label: 'Test Entity', canonicalLabel: 'test entity', entityType: 'concept', aliases: [], extractionConfidence: 0.8, firstSeenRunId: 'run-export', lastUpdatedRunId: 'run-export', metadata: {} }),
    event('CLAIM_ACCEPTED', { id: 'claim-a', subjectText: 'A improves B', predicate: 'improves', objectText: 'research', polarity: 'asserted', hedge: 'certain', evidenceType: 'study', canonicalKey: { subject: 'a improves b', predicate: 'improves' }, familyId: 'family-1', confidence: 0.5, contradictionState: 'none', firstSeenRunId: 'run-export', lastSeenRunId: 'run-export' }),
  ], { projection: rebuildProjection(handlers), handlers });
  rebuildKnowledgeReadModel(handlers);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-export-'));
  dbPath = path.join(tempDir, 'trellis.db');
  expect(initDb(dbPath)).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('trellis export', () => {
  it('produces valid JSONL with correct footer digest', async () => {
    seedBase();
    const outputPath = path.join(tempDir, 'events.jsonl');
    const { code, out } = await run(['export', outputPath, '--json']);
    expect(code).toBe(0);
    const body = lastJson<{ data: { output: string; eventCount: number; latestSeq: number; archiveSha256: string } }>(out);
    expect(body.ok).toBe(true);
    expect(body.data.output).toBe(outputPath);
    expect(body.data.eventCount).toBeGreaterThanOrEqual(4);
    expect(body.data.latestSeq).toBeGreaterThanOrEqual(4);

    // Parse the JSONL file
    const content = fs.readFileSync(outputPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + events + footer

    // First line: header
    const header = JSON.parse(lines[0]!);
    expect(header.recordType).toBe('header');
    expect(header.format).toBe('trellis-event-log');
    expect(header.formatVersion).toBe(1);
    expect(header.schemaVersion).toBeGreaterThanOrEqual(4);

    // Last line: footer
    const footer = JSON.parse(lines[lines.length - 1]!);
    expect(footer.recordType).toBe('footer');
    expect(footer.eventCount).toBe(body.data.eventCount);
    expect(footer.latestSeq).toBe(body.data.latestSeq);
    expect(footer.archiveSha256).toBe(body.data.archiveSha256);

    // Verify footer digest: hash of header + all event lines
    const crypto = await import('node:crypto');
    const h = crypto.createHash('sha256');
    for (let i = 0; i < lines.length - 1; i++) {
      h.update(lines[i]!);
      h.update('\n');
    }
    expect(footer.archiveSha256).toBe(h.digest('hex'));
  });

  it('exports payloadJson byte-for-byte from stored payload', async () => {
    seedBase();
    const outputPath = path.join(tempDir, 'events.jsonl');
    await run(['export', outputPath, '--json']);

    const content = fs.readFileSync(outputPath, 'utf8');
    const lines = content.trim().split('\n');

    // Find event lines
    for (let i = 1; i < lines.length - 1; i++) {
      const event = JSON.parse(lines[i]!);
      if (event.recordType !== 'event') continue;

      // payloadHash must match the raw payloadJson
      expect(hashPayload(event.payloadJson)).toBe(event.payloadHash);

      // payloadJson must be valid JSON
      const parsed = JSON.parse(event.payloadJson);
      expect(parsed).toBeDefined();
    }
  });

  it('exports valid header+footer with zero events for empty log', async () => {
    // No seeding — empty event log
    const outputPath = path.join(tempDir, 'empty.jsonl');
    const { code, out } = await run(['export', outputPath, '--json']);
    expect(code).toBe(0);
    const body = lastJson<{ data: { eventCount: number } }>(out);
    expect(body.ok).toBe(true);
    expect(body.data.eventCount).toBe(0);

    const content = fs.readFileSync(outputPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2); // header + footer

    const header = JSON.parse(lines[0]!);
    expect(header.recordType).toBe('header');

    const footer = JSON.parse(lines[1]!);
    expect(footer.recordType).toBe('footer');
    expect(footer.eventCount).toBe(0);
    expect(footer.latestSeq).toBe(0);
  });

  it('fails with DESTINATION_EXISTS when file already exists', async () => {
    seedBase();
    const outputPath = path.join(tempDir, 'existing.jsonl');
    fs.writeFileSync(outputPath, 'existing content');
    const { code, out } = await run(['export', outputPath, '--json']);
    expect(code).toBe(4);
    const body = lastJson<{ ok: boolean; error: { code: string } }>(out);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('DESTINATION_EXISTS');
  });

  it('no partial file left on failure', async () => {
    seedBase();
    const outputPath = path.join(tempDir, 'fail-export.jsonl');
    // First run succeeds
    await run(['export', outputPath, '--json']);
    expect(fs.existsSync(outputPath)).toBe(true);

    // Second run fails (destination exists)
    const { code } = await run(['export', outputPath, '--json']);
    expect(code).toBe(4);

    // No temp files left behind
    const entries = fs.readdirSync(tempDir).filter((e) => e.startsWith('.trellis-export-'));
    expect(entries).toHaveLength(0);
  });

  it('usage error when no argument given', async () => {
    seedBase();
    const { code, out } = await run(['export', '--json']);
    expect(code).toBe(2);
    const body = lastJson<{ ok: boolean; error: { code: string } }>(out);
    expect(body.error.code).toBe('USAGE_ERROR');
  });

  it('JSON envelope shape matches existing CLI conventions', async () => {
    seedBase();
    const outputPath = path.join(tempDir, 'env.jsonl');
    const { code, out } = await run(['export', outputPath, '--json']);
    expect(code).toBe(0);
    const body = JSON.parse(out.trim()) as { version: number; ok: boolean; command: string; data: unknown };
    expect(body.version).toBe(1);
    expect(body.ok).toBe(true);
    expect(body.command).toBe('export');
    expect(body.data).toBeDefined();
  });
});
