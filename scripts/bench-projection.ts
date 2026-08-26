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
import { createEmptyProjectionState } from '../src/store/projectionState.js';
import { generateEvents, handlers, BATCH_SIZE, DELTA_COUNT, tryGC } from './bench-shared.js';

// ── CLI flags ──────────────────────────────────────────────────────

const fullRun = process.argv.includes('--full') || process.env.BENCH_FULL === '1';
const SCALES = fullRun
  ? [1_000, 10_000, 100_000, 1_000_000]
  : [1_000, 10_000];

// ── Helpers ────────────────────────────────────────────────────────

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
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
