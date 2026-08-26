import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluatePairCase,
  runPairCorpus,
  validatePairCorpus,
} from '../../src/evaluation/reconciliation.js';
import { loadPairCorpus } from '../../src/evaluation/fixtures.js';

const corpusDir = path.join(fileURLToPath(import.meta.url), '..', '..', '..', 'test', 'fixtures', 'reconciliation', 'v1');
const corpusFiles = loadPairCorpus(path.join(corpusDir, 'cases'));
const cases = corpusFiles.flatMap((f) => f.file.cases);

/**
 * Hard-blocking regression gate: EVERY corpus case must match the CURRENT
 * reconciler's actual output exactly (classification + matchedClaimId).
 * A failure here means reconciler behavior drifted from the versioned gold
 * labels — re-adjudicate labels deliberately or fix the reconciler; never
 * weaken either silently.
 */
describe('reconciler pair corpus gate (v1, 43 cases)', () => {
  it('corpus passes self-validation', () => {
    expect(() => validatePairCorpus(corpusFiles)).not.toThrow();
    expect(cases).toHaveLength(43);
  });

  it('every case matches planClaimObservation output exactly', () => {
    const mismatches = cases
      .map((c) => evaluatePairCase(c).result)
      .filter((r) => !r.match);
    expect(mismatches).toEqual([]);
  });

  it('all seven classifications are represented with adequate support', () => {
    const counts = new Map<string, number>();
    for (const c of cases) counts.set(c.expected.classification, (counts.get(c.expected.classification) ?? 0) + 1);
    for (const count of counts.values()) expect(count).toBeGreaterThanOrEqual(6);
    expect([...counts.keys()].sort()).toEqual([
      'contradiction', 'elaboration', 'near_duplicate', 'new_claim',
      'qualification', 'same_claim', 'supersedes',
    ]);
  });

  it('pair metrics stay at ceiling on the versioned corpus', () => {
    const result = runPairCorpus(cases);
    expect(result.accuracy).toBe(1);
    expect(result.macroF1).toBe(1);
    expect(result.matchedTop1Accuracy).toBe(1);
    expect(result.canonicalReuseAccuracy).toBe(1);
    expect(result.relatedVsRejectAccuracy).toBe(1);
    expect(result.rejectPrecision).toBe(1);
    expect(result.rejectRecall).toBe(1);
    expect(result.falseLinkRate).toBe(0);
  });
});
