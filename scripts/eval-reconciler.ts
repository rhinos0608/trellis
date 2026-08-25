#!/usr/bin/env tsx
/**
 * Reconciliation evaluation runner — Phase 12 Stage B.
 *
 * Runs the versioned gold-label corpus, the sequence scenarios (B³), and the
 * golden-projection replays against the CURRENT claim reconciler. Not part of
 * CI; run manually:
 *   npm run eval:reconciler           # human-readable scorecard
 *   npm run eval:reconciler -- --json # machine-readable output
 *
 * Exit codes: 0 all pass · 1 behavioral/golden mismatch · 2 invalid corpus.
 *
 * There is deliberately no --update-golden flag: golden changes are manual,
 * reviewed fixture edits only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLASSIFICATIONS,
  EvaluationCorpusError,
  compareGoldenProjection,
  runClusterScenario,
  runPairCorpus,
  validatePairCorpus,
} from '../src/evaluation/reconciliation.js';
import { loadPairCorpus, loadScenarios } from '../src/evaluation/fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(here, '..', 'test', 'fixtures', 'reconciliation', 'v1');
const jsonMode = process.argv.includes('--json');

function fmt(value: number): string {
  return value.toFixed(3);
}

async function main(): Promise<void> {
  // ── Load + validate ──
  const corpusFiles = loadPairCorpus(path.join(corpusDir, 'cases'));
  const scenarios = loadScenarios(path.join(corpusDir, 'scenarios'));
  validatePairCorpus(corpusFiles);
  const cases = corpusFiles.flatMap((f) => f.file.cases);

  // ── Pair corpus ──
  const pair = runPairCorpus(cases);

  // ── Scenarios + golden projections ──
  const scenarioResults = scenarios.map(({ name, scenario, golden }) => ({
    name,
    orderInvariant: scenario.orderInvariant,
    b3: runClusterScenario(scenario),
    golden: compareGoldenProjection(scenario, golden),
  }));

  // ── Determinism self-check: rerun everything, results must be identical ──
  const firstPass = JSON.stringify({ pair, scenarioResults });
  const pair2 = runPairCorpus(cases);
  const scenarioResults2 = scenarios.map(({ name, scenario, golden }) => ({
    name,
    orderInvariant: scenario.orderInvariant,
    b3: runClusterScenario(scenario),
    golden: compareGoldenProjection(scenario, golden),
  }));
  const deterministic = firstPass === JSON.stringify({ pair: pair2, scenarioResults: scenarioResults2 });

  const behavioralFailures =
    pair.mismatches.length +
    scenarioResults.reduce((sum, s) => sum + s.b3.stepMismatches.length, 0) +
    scenarioResults.filter((s) => !s.golden.matches).length;

  if (jsonMode) {
    console.log(JSON.stringify({
      corpusVersion: 1,
      reconcilerVersion: 2,
      deterministic,
      pair,
      scenarios: scenarioResults,
      exitCode: behavioralFailures > 0 ? 1 : 0,
    }, null, 2));
  } else {
    console.log('\n🧪 Trellis Reconciliation Evaluation — reconcilerVersion 2\n');
    console.log(`Pair corpus: ${String(pair.correct)}/${String(pair.total)} exact `
      + `(accuracy ${fmt(pair.accuracy)}, macro-F1 ${fmt(pair.macroF1)})`);
    console.log(`Matched-candidate top-1: ${String(pair.matchedTop1Correct)}/${String(pair.matchedTop1Total)} (${fmt(pair.matchedTop1Accuracy)})`);
    console.log(`Canonical-reuse accuracy: ${fmt(pair.canonicalReuseAccuracy)}  related-vs-reject: ${fmt(pair.relatedVsRejectAccuracy)}`);
    console.log(`Reject option (new_claim positive): precision ${fmt(pair.rejectPrecision)} `
      + `recall ${fmt(pair.rejectRecall)} false-link rate ${fmt(pair.falseLinkRate)}`);

    console.log('\nPer-class P/R/F1:');
    for (const classification of CLASSIFICATIONS) {
      const m = pair.perClass[classification]!;
      console.log(`  ${classification.padEnd(14)} P=${fmt(m.precision)} R=${fmt(m.recall)} F1=${fmt(m.f1)} support=${String(m.support)}`);
    }

    console.log('\nConfusion matrix (rows=gold, cols=predicted):');
    const header = ''.padEnd(14) + CLASSIFICATIONS.map((c) => c.slice(0, 6).padStart(8)).join('');
    console.log(header);
    for (const expected of CLASSIFICATIONS) {
      const row = expected.padEnd(14)
        + CLASSIFICATIONS.map((actual) => String(pair.confusion[expected]?.[actual] ?? 0).padStart(8)).join('');
      console.log(row);
    }

    for (const mismatch of pair.mismatches) {
      console.log(`  MISMATCH ${mismatch.caseId}: expected ${mismatch.expected}`
        + `${mismatch.expectedMatchedClaimId ? `/${mismatch.expectedMatchedClaimId}` : ''}, got ${mismatch.actual}`
        + `${mismatch.actualMatchedClaimId ? `/${mismatch.actualMatchedClaimId}` : ''}`);
    }

    console.log('\nSequence scenarios (B³):');
    for (const s of scenarioResults) {
      console.log(`  ${s.name.padEnd(28)} orderInvariant=${String(s.orderInvariant).padEnd(5)} `
        + `P=${fmt(s.b3.precision)} R=${fmt(s.b3.recall)} F1=${fmt(s.b3.f1)} `
        + `golden=${s.golden.matches ? 'MATCH' : 'DIFF'}`);
      for (const mismatch of s.b3.stepMismatches) {
        console.log(`    STEP MISMATCH ${s.name}/${mismatch.observationId}: expected `
          + `${mismatch.expectedClassification}${mismatch.expectedMatchedClaimId ? `/${mismatch.expectedMatchedClaimId}` : ''}`
          + `, got ${mismatch.actualClassification}${mismatch.actualMatchedClaimId ? `/${mismatch.actualMatchedClaimId}` : ''}`);
      }
      for (const diffLine of s.golden.diffs.slice(0, 10)) {
        console.log(`    GOLDEN DIFF ${s.name}: ${diffLine}`);
      }
    }

    console.log(`\nDeterminism (double-run identical): ${deterministic ? 'yes' : 'NO'}`);
    console.log(behavioralFailures === 0 && deterministic ? '\n✓ All gates pass.' : `\n✗ ${String(behavioralFailures)} failure(s).`);
  }

  process.exitCode = behavioralFailures > 0 || !deterministic ? 1 : 0;
}

try {
  await main();
} catch (err) {
  if (err instanceof EvaluationCorpusError) {
    console.error(`Invalid corpus: ${err.message}`);
    process.exit(2);
  }
  console.error('Eval failed:', err);
  process.exit(2);
}
