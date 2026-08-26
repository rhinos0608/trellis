#!/usr/bin/env tsx
/**
 * Performance gate script — Phase 14.
 *
 * Four gated workload families measuring latency budgets for Trellis's
 * critical paths. Produces a human-readable scorecard (default) or
 * machine-readable JSON (--json). Budget enforcement via --gate flag.
 *
 * Run manually:
 *   npm run bench:performance           # informational scorecard (exit 0)
 *   npm run perf:check                  # budget gate (exit 1 on failure)
 *   npm run perf:check -- --json        # machine-readable gate output
 *
 * Exit codes: 0 pass/informational · 1 budget failure (only with --gate) · 2 setup/arg error
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, appendEvents, queryEvents, rebuildProjection } from '../src/store/index.js';
import { rebuildKnowledgeReadModel } from '../src/store/readModel/index.js';
import { createKnowledgeQueryService } from '../src/query/service.js';
import {
  serializeClaim,
  serializeSource,
} from '../src/store/readModel/serializers.js';
import { createEmptyProjectionState } from '../src/store/projectionState.js';
import type { ProjectionState } from '../src/store/projectionState.js';
import { planClaimObservation } from '../src/graph/claimReconciler.js';
import type { Claim, ClaimObservation, Source } from '../src/graph/types.js';
import {
  generateEvents,
  handlers,
  BATCH_SIZE,
  tryGC,
} from './bench-shared.js';

// ── Constants ──────────────────────────────────────────────────────

const PERF_VERSION = 1;
const SAMPLES = 3;
const EVENT_COUNT = 10_000;
const DELTA_COUNT = 100;

// ── CLI ────────────────────────────────────────────────────────────

const jsonMode = process.argv.includes('--json');
const gateMode = process.argv.includes('--gate');

// ── Types ──────────────────────────────────────────────────────────

interface StatResult {
  median: number;
  p95: number;
  samples: number;
}

interface BenchmarkResult {
  name: string;
  medianMs: number;
  p95Ms: number | null;
  budgetMs: number | null;
  pass: boolean | null;
  details?: Record<string, unknown>;
}

interface Metadata {
  perfVersion: number;
  nodeVersion: string;
  os: string;
  cpuModel: string;
  totalMemGB: number;
  arch: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)]!;
}

function stat(values: number[]): StatResult {
  return { median: median(values), p95: p95(values), samples: values.length };
}

function getMetadata(): Metadata {
  return {
    perfVersion: PERF_VERSION,
    nodeVersion: process.version,
    os: `${os.type()} ${os.release()}`,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    arch: os.arch(),
  };
}

function fmt(v: number): string {
  return v < 1 ? v.toFixed(3) : v < 100 ? v.toFixed(1) : Math.round(v).toString();
}

// ── Workload 1: Store replay and append ────────────────────────────

interface StoreResult {
  append: StatResult;
  deltaAppend: StatResult;
  genesisRebuild: StatResult;
  incrementalRebuild: StatResult;
  queryEventsAll: StatResult;
}

async function benchStore(): Promise<StoreResult> {
  const appendResults: number[] = [];
  const deltaAppendResults: number[] = [];
  const genesisResults: number[] = [];
  const incrResults: number[] = [];
  const queryResults: number[] = [];

  for (let sample = 0; sample < SAMPLES; sample++) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-perf-store-'));
    const dbPath = path.join(tmpDir, 'store.db');
    const db = initDb(dbPath);
    if (!db) throw new Error('Failed to open DB for store benchmark');

    try {
      const allEvents = generateEvents(EVENT_COUNT, 0);
      const appendContext = { projection: createEmptyProjectionState(), handlers };

      // Measure append (1k batches)
      const appendStart = performance.now();
      for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
        appendEvents(allEvents.slice(i, i + BATCH_SIZE), appendContext);
      }
      appendResults.push(performance.now() - appendStart);

      // Genesis rebuild
      tryGC();
      const genesisStart = performance.now();
      rebuildProjection(handlers);
      genesisResults.push(performance.now() - genesisStart);

      // Delta append + incremental rebuild
      const deltaEvents = generateEvents(DELTA_COUNT, EVENT_COUNT);
      const deltaAppendStart = performance.now();
      appendEvents(deltaEvents, appendContext);
      deltaAppendResults.push(performance.now() - deltaAppendStart);

      tryGC();
      const incrStart = performance.now();
      rebuildProjection(handlers);
      incrResults.push(performance.now() - incrStart);

      // queryEvents({}) informational
      const qStart = performance.now();
      queryEvents({});
      queryResults.push(performance.now() - qStart);
    } finally {
      closeDb();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  return {
    append: stat(appendResults),
    deltaAppend: stat(deltaAppendResults),
    genesisRebuild: stat(genesisResults),
    incrementalRebuild: stat(incrResults),
    queryEventsAll: stat(queryResults),
  };
}

// ── Workload 2: Read-model rebuild ─────────────────────────────────

async function benchReadModelRebuild(): Promise<StatResult> {
  const results: number[] = [];

  for (let sample = 0; sample < SAMPLES; sample++) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-perf-rm-'));
    const dbPath = path.join(tmpDir, 'rm.db');
    const db = initDb(dbPath);
    if (!db) throw new Error('Failed to open DB for read-model benchmark');

    try {
      // Seed 10k events
      const allEvents = generateEvents(EVENT_COUNT, 0);
      const appendContext = { projection: createEmptyProjectionState(), handlers };
      for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
        appendEvents(allEvents.slice(i, i + BATCH_SIZE), appendContext);
      }

      // Force-genesus replay + rm_* writes + FTS rebuild
      const start = performance.now();
      rebuildKnowledgeReadModel(handlers);
      results.push(performance.now() - start);
    } finally {
      closeDb();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  return stat(results);
}

// ── Workload 3: Claim-reconciliation growth ────────────────────────

function buildClaimFixture(id: string, familyId: string, idx: number): Claim {
  return {
    id,
    familyId,
    subjectText: `Subject ${idx}`,
    predicate: 'is_compatible_with',
    objectText: `Object ${idx}`,
    polarity: 'asserted',
    hedge: 'likely',
    evidenceType: 'study',
    confidence: 0.7,
    canonicalKey: { subject: `s-${idx}`, predicate: 'compatible' },
    contradictionState: 'none',
    firstSeenRunId: 'run-bench',
    lastSeenRunId: 'run-bench',
  };
}

function buildObservation(familyId: string, idx: number): ClaimObservation {
  return {
    id: `obs-${idx}`,
    familyId,
    subjectText: `Query subject ${idx}`,
    predicate: 'is_compatible_with',
    objectText: `Query object ${idx} with extra detail`,
    polarity: 'asserted',
    hedge: 'likely',
    evidenceType: 'study',
    confidence: 0.7,
    canonicalKey: { subject: `qs-${idx}`, predicate: 'query_pred' },
    runId: 'run-bench',
    observedAt: new Date().toISOString(),
    sourceIds: [],
    extractionVersion: '1.0',
  };
}

function benchReconcilerAtSize(
  claimCount: number,
  iterations: number,
): StatResult {
  const familyId = 'fam-bench';
  const state = createEmptyProjectionState();
  const claimIds = new Set<string>();

  for (let i = 0; i < claimCount; i++) {
    const claim = buildClaimFixture(`claim-${i}`, familyId, i);
    state.claims.set(claim.id, claim);
    claimIds.add(claim.id);
  }
  state.claimsByFamilyId.set(familyId, claimIds);

  const results: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const obs = buildObservation(familyId, i);
    const start = performance.now();
    planClaimObservation(obs, state);
    results.push(performance.now() - start);
  }

  return stat(results);
}

async function benchReconciliation(): Promise<{
  small: StatResult;
  large: StatResult;
  growthRatio: number;
}> {
  const ITERATIONS = 500;
  const small = benchReconcilerAtSize(500, ITERATIONS);
  const large = benchReconcilerAtSize(2_000, ITERATIONS);
  return {
    small,
    large,
    growthRatio: small.median > 0 ? large.median / small.median : 0,
  };
}

// ── Workload 4: Query-service reads ────────────────────────────────

function buildSourceFixture(id: string, idx: number): Source {
  return {
    id,
    url: `https://bench.example.com/doc/${idx}`,
    canonicalUrl: `https://bench.example.com/doc/${idx}`,
    title: `Source Document ${idx} about benchmarking and performance`,
    domain: 'bench.example.com',
    sourceType: 'web',
    isPrimary: idx % 3 === 0,
    extractionStatus: 'extracted',
    firstSeenRunId: 'run-bench',
    lastSeenRunId: 'run-bench',
    lastSeenAt: new Date().toISOString(),
    runCount: 1,
    retrievedAt: new Date().toISOString(),
  };
}

function seedDirectly(
  db: ReturnType<typeof initDb> & object,
  claimCount: number,
  sourceCount: number,
): void {
  const claimInsert = db.prepare(
    `INSERT INTO rm_claims (id,curation_status,merged_into_claim_id,family_id,thread_id,subject_entity_id,subject_text,predicate,object_entity_id,object_text,canonical_subject,canonical_predicate,quantifier_canonical,polarity,hedge,evidence_type,confidence,epistemic_status,contradiction_state,current_observation_id,first_seen_run_id,first_seen_at,last_seen_run_id,last_seen_at,observation_count,supporting_evidence_count,opposing_evidence_count,payload_json) VALUES (@id,@curation_status,@merged_into_claim_id,@family_id,@thread_id,@subject_entity_id,@subject_text,@predicate,@object_entity_id,@object_text,@canonical_subject,@canonical_predicate,@quantifier_canonical,@polarity,@hedge,@evidence_type,@confidence,@epistemic_status,@contradiction_state,@current_observation_id,@first_seen_run_id,@first_seen_at,@last_seen_run_id,@last_seen_at,@observation_count,@supporting_evidence_count,@opposing_evidence_count,@payload_json)`,
  );
  const sourceInsert = db.prepare(
    `INSERT INTO rm_sources (id,canonical_url,url,title,domain,source_type,authority_class,quality_score,is_primary,extraction_status,usage_status,content_hash,retrieved_at,published_at,first_seen_run_id,last_seen_run_id,last_seen_at,run_count,payload_json) VALUES (@id,@canonical_url,@url,@title,@domain,@source_type,@authority_class,@quality_score,@is_primary,@extraction_status,@usage_status,@content_hash,@retrieved_at,@published_at,@first_seen_run_id,@last_seen_run_id,@last_seen_at,@run_count,@payload_json)`,
  );

  // Families for claims: spread across 50 families
  const FAMILY_COUNT = 50;

  const txn = db.transaction(() => {
    for (let i = 0; i < claimCount; i++) {
      const claim: Claim = {
        id: `claim-${i}`,
        familyId: `fam-${i % FAMILY_COUNT}`,
        subjectText: `Subject ${i}`,
        predicate: 'is_compatible_with',
        objectText: `Object ${i} performance measurement analysis`,
        polarity: 'asserted',
        hedge: 'likely',
        evidenceType: 'study',
        confidence: 0.7,
        canonicalKey: { subject: `s-${i}`, predicate: 'compatible' },
        contradictionState: 'none',
        firstSeenRunId: 'run-bench',
        lastSeenRunId: 'run-bench',
      };
      claimInsert.run(serializeClaim(claim));
    }

    for (let i = 0; i < sourceCount; i++) {
      const source = buildSourceFixture(`src-${i}`, i);
      sourceInsert.run(serializeSource(source));
    }

    // FTS rebuild
    db.prepare("INSERT INTO rm_claims_fts(rm_claims_fts) VALUES ('rebuild')").run();
    db.prepare("INSERT INTO rm_sources_fts(rm_sources_fts) VALUES ('rebuild')").run();

    // Mark read model ready
    db.prepare("UPDATE rm_state SET status='ready', last_applied_seq=10000, updated_at=? WHERE model_name='knowledge'").run(new Date().toISOString());
  });
  txn.immediate();
}

async function benchQueryService(): Promise<{
  pointLookup: StatResult;
  familyFilter: StatResult;
  claimsFts: StatResult;
  sourcesFts: StatResult;
  unfilteredClaims: StatResult;
  unfilteredSources: StatResult;
}> {
  const CLAIM_COUNT = 10_000;
  const SOURCE_COUNT = 2_000;
  const WARMUP = 10;
  const ITERATIONS = 100;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-perf-qry-'));
  const dbPath = path.join(tmpDir, 'qry.db');
  const db = initDb(dbPath);
  if (!db) throw new Error('Failed to open DB for query benchmark');

  try {
    seedDirectly(db, CLAIM_COUNT, SOURCE_COUNT);
    const qs = createKnowledgeQueryService(db);

    function benchQuery(fn: () => unknown): StatResult {
      // Warmup
      for (let i = 0; i < WARMUP; i++) fn();
      // Measured
      const results: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const start = performance.now();
        fn();
        results.push(performance.now() - start);
      }
      return stat(results);
    }

    const pointLookup = benchQuery(() => qs.getClaim('claim-4242'));
    const familyFilter = benchQuery(() => qs.listClaims({ familyId: 'fam-7' }));
    const claimsFts = benchQuery(() => qs.listClaims({ q: 'performance' }));
    const sourcesFts = benchQuery(() => qs.listSources({ q: 'benchmarking' }));
    const unfilteredClaims = benchQuery(() => qs.listClaims({}));
    const unfilteredSources = benchQuery(() => qs.listSources({}));

    return { pointLookup, familyFilter, claimsFts, sourcesFts, unfilteredClaims, unfilteredSources };
  } finally {
    closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ── Scorecard output ───────────────────────────────────────────────

function printScorecard(
  results: BenchmarkResult[],
  metadata: Metadata,
): void {
  console.log('\n🚀 Trellis Performance Gate — v' + String(PERF_VERSION) + '\n');
  console.log(`  Node ${metadata.nodeVersion} · ${metadata.cpuModel} · ${String(metadata.totalMemGB)}GB · ${metadata.os} (${metadata.arch})\n`);

  const nameWidth = Math.max(30, ...results.map((r) => r.name.length));
  const header = [
    'Workload'.padEnd(nameWidth),
    'Median (ms)',
    'P95 (ms)',
    'Budget (ms)',
    'Status',
  ].join('  ');
  console.log(header);
  console.log('─'.repeat(header.length));

  let allPass = true;
  for (const r of results) {
    const budgetStr = r.budgetMs !== null ? fmt(r.budgetMs) : '—';
    const p95Str = r.p95Ms !== null ? fmt(r.p95Ms) : '—';
    const status = r.pass === null ? 'INFO' : r.pass ? 'PASS' : 'FAIL';
    if (r.pass === false) allPass = false;
    console.log(
      r.name.padEnd(nameWidth)
      + fmt(r.medianMs).padStart(10)
      + p95Str.padStart(10)
      + budgetStr.padStart(12)
      + ('  ' + status),
    );
  }

  console.log('─'.repeat(header.length));

  // Informational metrics (no budget)
  const infoResults = results.filter((r) => r.budgetMs === null);
  if (infoResults.length > 0) {
    console.log('\n  Informational metrics (no budget):');
    for (const r of infoResults) {
      console.log(`    ${r.name}: median ${fmt(r.medianMs)}ms, p95 ${r.p95Ms !== null ? fmt(r.p95Ms) : '—'}ms`);
    }
  }

  console.log(allPass ? '\n✓ All gates pass.\n' : '\n✗ Budget failure(s).\n');
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const metadata = getMetadata();

  // ── Workload 1: Store replay and append ──
  process.stderr.write('  [1/4] Store replay and append...\n');
  const store = await benchStore();

  // ── Workload 2: Read-model rebuild ──
  process.stderr.write('  [2/4] Read-model rebuild...\n');
  const rmRebuild = await benchReadModelRebuild();

  // ── Workload 3: Claim-reconciliation growth ──
  process.stderr.write('  [3/4] Claim-reconciliation growth...\n');
  const recon = await benchReconciliation();

  // ── Workload 4: Query-service reads ──
  process.stderr.write('  [4/4] Query-service reads...\n');
  const query = await benchQueryService();

  // ── Build results ──
  const results: BenchmarkResult[] = [
    {
      name: 'Store append (10k)',
      medianMs: store.append.median,
      p95Ms: store.append.p95,
      budgetMs: 3_000,
      pass: store.append.median <= 3_000,
    },
    {
      name: 'Delta append (+100)',
      medianMs: store.deltaAppend.median,
      p95Ms: store.deltaAppend.p95,
      budgetMs: null,
      pass: null,
    },
    {
      name: 'Genesis rebuild (10k)',
      medianMs: store.genesisRebuild.median,
      p95Ms: store.genesisRebuild.p95,
      budgetMs: 1_500,
      pass: store.genesisRebuild.median <= 1_500,
    },
    {
      name: 'Incremental rebuild (+100)',
      medianMs: store.incrementalRebuild.median,
      p95Ms: store.incrementalRebuild.p95,
      budgetMs: 1_000,
      pass: store.incrementalRebuild.median <= 1_000,
    },
    {
      name: 'queryEvents({}) full scan',
      medianMs: store.queryEventsAll.median,
      p95Ms: store.queryEventsAll.p95,
      budgetMs: null,
      pass: null,
    },
    {
      name: 'Read-model rebuild (10k)',
      medianMs: rmRebuild.median,
      p95Ms: rmRebuild.p95,
      budgetMs: 2_500,
      pass: rmRebuild.median <= 2_500,
    },
    {
      name: 'Reconcile median @ 500 claims',
      medianMs: recon.small.median,
      p95Ms: recon.small.p95,
      budgetMs: null,
      pass: null,
    },
    {
      name: 'Reconcile median @ 2000 claims',
      medianMs: recon.large.median,
      p95Ms: recon.large.p95,
      budgetMs: 50,
      pass: recon.large.median <= 50,
    },
    {
      name: 'Reconcile growth ratio',
      medianMs: recon.growthRatio,
      p95Ms: null,
      budgetMs: 8,
      pass: recon.growthRatio <= 8,
      details: { smallMedian: recon.small.median, largeMedian: recon.large.median },
    },
    {
      name: 'Query: point lookup (p95)',
      medianMs: query.pointLookup.median,
      p95Ms: query.pointLookup.p95,
      budgetMs: 25,
      pass: query.pointLookup.p95 <= 25,
    },
    {
      name: 'Query: family filter (p95)',
      medianMs: query.familyFilter.median,
      p95Ms: query.familyFilter.p95,
      budgetMs: 50,
      pass: query.familyFilter.p95 <= 50,
    },
    {
      name: 'Query: claims FTS (p95)',
      medianMs: query.claimsFts.median,
      p95Ms: query.claimsFts.p95,
      budgetMs: 50,
      pass: query.claimsFts.p95 <= 50,
    },
    {
      name: 'Query: sources FTS (p95)',
      medianMs: query.sourcesFts.median,
      p95Ms: query.sourcesFts.p95,
      budgetMs: 50,
      pass: query.sourcesFts.p95 <= 50,
    },
    {
      name: 'Query: unfiltered claims (p95)',
      medianMs: query.unfilteredClaims.median,
      p95Ms: query.unfilteredClaims.p95,
      budgetMs: 150,
      pass: query.unfilteredClaims.p95 <= 150,
    },
    {
      name: 'Query: unfiltered sources (p95)',
      medianMs: query.unfilteredSources.median,
      p95Ms: query.unfilteredSources.p95,
      budgetMs: 150,
      pass: query.unfilteredSources.p95 <= 150,
    },
  ];

  // ── Output ──
  if (jsonMode) {
    const budgetFailures = results.filter((r) => r.pass === false).length;
    console.log(JSON.stringify({
      perfVersion: PERF_VERSION,
      metadata,
      results,
      budgetFailures,
      gateMode,
      exitCode: gateMode && budgetFailures > 0 ? 1 : 0,
    }, null, 2));
  } else {
    printScorecard(results, metadata);
  }

  // ── Exit code ──
  const anyFailure = results.some((r) => r.pass === false);
  if (gateMode && anyFailure) {
    process.exit(1);
  }
}

try {
  await main();
} catch (err) {
  console.error('Performance benchmark failed:', err);
  process.exit(2);
}
