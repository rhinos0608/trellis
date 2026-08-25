#!/usr/bin/env tsx
/**
 * Standalone benchmark for Trellis event-log / projection performance at scale.
 *
 * NOT part of CI or the default vitest test suite. Run manually:
 *   npm run bench:projection          # fast tiers only (1k, 10k)
 *   npm run bench:projection -- --full # all tiers including 100k, 1M
 *
 * Uses vitest's built-in bench() via `vitest bench` is NOT used here —
 * this is a plain tsx script for full control over DB lifecycle and GC.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, appendEvents, queryEvents, rebuildProjection } from '../src/store/index.js';
import type { NewEventInput } from '../src/store/index.js';
import { graphEventHandlers } from '../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../src/workspace/projectionHandlers.js';
import { createEmptyProjectionState } from '../src/store/projectionState.js';
import type { EventHandlerRegistry } from '../src/store/projectionState.js';

// ── CLI flags ──────────────────────────────────────────────────────

const fullRun = process.argv.includes('--full') || process.env.BENCH_FULL === '1';
const SCALES = fullRun
  ? [1_000, 10_000, 100_000, 1_000_000]
  : [1_000, 10_000];
const BATCH_SIZE = 1_000;
const DELTA_COUNT = 100;

// ── Merged handler registry ────────────────────────────────────────

const handlers: EventHandlerRegistry = {
  ...graphEventHandlers,
  ...workspaceEventHandlers,
};

// ── Synthetic event generator ──────────────────────────────────────

type WeightedType = { type: string; weight: number };

const EVENT_WEIGHTS: WeightedType[] = [
  { type: 'NODE_ADDED', weight: 40 },
  { type: 'CLAIM_ACCEPTED', weight: 15 },
  { type: 'EDGE_ADDED', weight: 10 },
  { type: 'EVIDENCE_LINKED', weight: 10 },
  { type: 'SOURCE_ADDED', weight: 5 },
  { type: 'FAMILY_CREATED', weight: 5 },
  { type: 'FAMILY_CLASSIFIED', weight: 5 },
  { type: 'RUN_STARTED', weight: 5 },
  { type: 'RUN_COMPLETED', weight: 5 },
];

const SECONDARY_WEIGHTS = EVENT_WEIGHTS.filter(({ type }) =>
  !['NODE_ADDED', 'CLAIM_ACCEPTED', 'SOURCE_ADDED', 'FAMILY_CREATED'].includes(type),
);

function pickWeighted(rand: number, weights = EVENT_WEIGHTS): string {
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);
  let acc = 0;
  for (const w of weights) {
    acc += w.weight;
    if (rand < acc / totalWeight) return w.type;
  }
  return weights[0]!.type;
}

// Simple seeded PRNG (xorshift32) for deterministic-ish IDs without crypto overhead
let _seed = 123456789;
function rand(): number {
  _seed ^= _seed << 13;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;
  return ((_seed >>> 0) / 4294967296);
}

function id(prefix: string, idx: number): string {
  return `${prefix}-${idx}`;
}

/**
 * Generate `count` synthetic events with realistic payloads matching
 * the actual handler shapes. Events reference pre-built pools for
 * referential integrity (edges reference claims, evidence references
 * claims+sources, etc.).
 */
function generateEvents(count: number, offset: number): NewEventInput[] {
  // Pre-build pools so cross-references work
  const entityCount = Math.ceil(count * 0.4);
  const claimCount = Math.ceil(count * 0.15);
  const sourceCount = Math.ceil(count * 0.05);
  const familyCount = Math.ceil(count * 0.05);

  const runId = `run-bench-${offset}`;
  const prerequisiteTypes = [
    ...Array.from({ length: familyCount }, () => 'FAMILY_CREATED'),
    ...Array.from({ length: entityCount }, () => 'NODE_ADDED'),
    ...Array.from({ length: sourceCount }, () => 'SOURCE_ADDED'),
    ...Array.from({ length: claimCount }, () => 'CLAIM_ACCEPTED'),
  ];
  const remainingCount = count - prerequisiteTypes.length;
  const eventTypes = [
    ...prerequisiteTypes,
    ...Array.from({ length: remainingCount }, () => pickWeighted(rand(), SECONDARY_WEIGHTS)),
  ];

  const events: NewEventInput[] = [];
  for (let i = 0; i < eventTypes.length; i++) {
    const idx = offset + i;
    const ts = new Date(Date.now() + idx).toISOString();
    const evType = eventTypes[i]!;

    let payload: unknown;
    let entityId: string | null = null;
    let entityType: string | null = null;

    switch (evType) {
      case 'NODE_ADDED': {
        const eid = id('ent', idx % entityCount);
        entityId = eid;
        entityType = 'entity';
        payload = {
          id: eid,
          label: `Entity ${idx % entityCount}`,
          canonicalLabel: null,
          entityType: 'protocol',
          aliases: [],
          extractionConfidence: 0.8,
          firstSeenRunId: runId,
          lastUpdatedRunId: runId,
          metadata: { source: 'bench' },
        };
        break;
      }
      case 'CLAIM_ACCEPTED': {
        const cid = id('claim', idx % claimCount);
        const fid = id('fam', idx % familyCount);
        entityId = cid;
        entityType = 'claim';
        payload = {
          id: cid,
          familyId: fid,
          subjectText: `Subject ${idx % claimCount}`,
          predicate: 'is_compatible_with',
          objectText: `Object ${idx}`,
          polarity: 'asserted',
          hedge: 'likely',
          evidenceType: 'study',
          confidence: 0.7,
          canonicalKey: { subject: `s-${idx % claimCount}`, predicate: 'compatible' },
          contradictionState: 'none',
          firstSeenRunId: runId,
          lastSeenRunId: runId,
        };
        break;
      }
      case 'EDGE_ADDED': {
        const fromId = id('claim', idx % claimCount);
        const toId = id('claim', (idx + 1) % claimCount);
        const eid = id('edge', idx);
        payload = {
          id: eid,
          fromClaimId: fromId,
          toClaimId: toId,
          relation: 'supports',
          strength: 'strong',
          score: 0.85,
          runId,
        };
        break;
      }
      case 'EVIDENCE_LINKED': {
        const claimId = id('claim', idx % claimCount);
        const sourceId = id('src', idx % sourceCount);
        payload = {
          id: id('ev', idx),
          claimId,
          sourceId,
          excerpt: `Evidence excerpt ${idx}`,
          runId,
        };
        break;
      }
      case 'SOURCE_ADDED': {
        const sid = id('src', idx % sourceCount);
        entityId = sid;
        entityType = 'source';
        payload = {
          id: sid,
          url: `https://example.com/doc/${idx % sourceCount}`,
          domain: 'example.com',
          sourceType: 'web',
          isPrimary: true,
          extractionStatus: 'extracted',
          contentHash: `hash-${idx % sourceCount}`,
          retrievedAt: ts,
          firstSeenRunId: runId,
        };
        break;
      }
      case 'FAMILY_CREATED': {
        const fid = id('fam', idx % familyCount);
        entityId = fid;
        entityType = 'family';
        payload = {
          family_id: fid,
          label: `Family ${idx % familyCount}`,
          description: `Bench family ${idx % familyCount}`,
        };
        break;
      }
      case 'FAMILY_CLASSIFIED': {
        const eid = id('ent', idx % entityCount);
        const fid = id('fam', idx % familyCount);
        payload = {
          entity_id: eid,
          family_id: fid,
          confidence: 0.9,
        };
        break;
      }
      case 'RUN_STARTED': {
        payload = { runId, familyId: id('fam', 0), query: 'bench query', strategy: 'pipeline' };
        break;
      }
      case 'RUN_COMPLETED': {
        payload = { runId, entityCount: 10, claimCount: 5 };
        break;
      }
      default: {
        payload = {};
      }
    }

    events.push({
      timestamp: ts,
      eventType: evType as NewEventInput['eventType'],
      eventVersion: 1,
      runId,
      batchId: `batch-${Math.floor(idx / BATCH_SIZE)}`,
      actor: 'system',
      entityId,
      entityType,
      payload,
    });
  }
  return events;
}

// ── Helpers ────────────────────────────────────────────────────────

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

function tryGC(): boolean {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return true;
  }
  return false;
}

interface BenchRow {
  Scale: string;
  'Insert (ms)': number;
  'Genesis Rebuild (ms)': number;
  'Incremental Rebuild (ms)': number;
  'queryEvents({}) (ms)': number;
  'Heap Δ (MB)': string;
  'GC used': string;
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gcAvailable = tryGC();
  console.log(`\n🔬 Trellis Projection Benchmark`);
  console.log(`   Scales: ${SCALES.map((s) => s.toLocaleString()).join(', ')}`);
  console.log(`   Batch size: ${BATCH_SIZE.toLocaleString()}`);
  console.log(`   Delta events: ${DELTA_COUNT}`);
  console.log(`   GC available: ${gcAvailable}`);
  if (!gcAvailable) {
    console.log(`   💡 Run with --expose-gc for accurate heap measurements`);
  }
  console.log('');

  const rows: BenchRow[] = [];

  for (const scale of SCALES) {
    console.log(`\n── Scale: ${scale.toLocaleString()} events ──`);

    // Fresh DB
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-bench-'));
    const dbPath = path.join(tmpDir, 'bench.db');
    const db = initDb(dbPath);
    if (!db) {
      console.error(`  ✗ Failed to open DB at ${dbPath}`);
      continue;
    }

    try {
      // ── (a) Insert ──
      const allEvents = generateEvents(scale, 0);
      const appendContext = { projection: createEmptyProjectionState(), handlers };
      const insertStart = performance.now();
      for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
        appendEvents(allEvents.slice(i, i + BATCH_SIZE), appendContext);
      }
      const insertMs = Math.round(performance.now() - insertStart);
      console.log(`  Insert: ${insertMs}ms`);

      // ── (b) Genesis rebuild (first call = full replay) ──
      tryGC();
      const heapBefore = process.memoryUsage().heapUsed;
      const genesisStart = performance.now();
      rebuildProjection(handlers);
      const genesisMs = Math.round(performance.now() - genesisStart);
      tryGC();
      const heapAfter = process.memoryUsage().heapUsed;
      const heapDeltaMB = mb(heapAfter - heapBefore);
      console.log(`  Genesis rebuild: ${genesisMs}ms  (heap Δ: ${heapDeltaMB}MB)`);

      // ── (c) Append delta, then incremental rebuild ──
      const deltaEvents = generateEvents(DELTA_COUNT, scale);
      const deltaStart = performance.now();
      appendEvents(deltaEvents, appendContext);
      const deltaInsertMs = Math.round(performance.now() - deltaStart);
      console.log(`  Delta insert (${DELTA_COUNT} events): ${deltaInsertMs}ms`);

      const incrStart = performance.now();
      rebuildProjection(handlers);
      const incrMs = Math.round(performance.now() - incrStart);
      console.log(`  Incremental rebuild: ${incrMs}ms`);

      // ── (d) queryEvents({}) full scan ──
      const queryStart = performance.now();
      queryEvents({});
      const queryMs = Math.round(performance.now() - queryStart);
      console.log(`  queryEvents({}) full scan: ${queryMs}ms`);

      rows.push({
        Scale: scale.toLocaleString(),
        'Insert (ms)': insertMs,
        'Genesis Rebuild (ms)': genesisMs,
        'Incremental Rebuild (ms)': incrMs,
        'queryEvents({}) (ms)': queryMs,
        'Heap Δ (MB)': heapDeltaMB,
        'GC used': gcAvailable ? 'yes' : 'no (approx)',
      });
    } finally {
      closeDb();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ── Results table ──
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.table(rows);

  // Also print as aligned text for copy-paste
  if (rows.length > 0) {
    const keys = Object.keys(rows[0]!) as (keyof BenchRow)[];
    const widths = keys.map((k) =>
      Math.max(k.length, ...rows.map((r) => String(r[k]).length)),
    );
    const sep = widths.map((w) => '─'.repeat(w + 2)).join('┼');
    const hdr = keys.map((k, i) => k.padEnd(widths[i]!)).join(' │ ');
    console.log(hdr);
    console.log(sep);
    for (const row of rows) {
      const line = keys.map((k, i) => String(row[k]).padEnd(widths[i]!)).join(' │ ');
      console.log(line);
    }
  }

  console.log('\n✓ Benchmark complete.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
