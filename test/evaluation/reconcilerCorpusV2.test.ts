import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePairCorpus, runPairCorpus, evaluatePairCase } from '../../src/evaluation/reconciliation.js';
import { loadPairCorpus } from '../../src/evaluation/fixtures.js';

const casesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'reconciliation', 'v2', 'cases',
);
const corpusFiles = loadPairCorpus(casesDir);
const cases = corpusFiles.flatMap((f) => f.file.cases);

/**
 * v2 corpus gate: validates the stricter v4 supersession semantics
 * alongside the original v1 cases carried forward unchanged.
 */
describe('reconciler pair corpus gate (v2, 45 cases)', () => {
  it('corpus passes self-validation', () => {
    expect(() => validatePairCorpus(corpusFiles)).not.toThrow();
    expect(cases).toHaveLength(45);
  });


  it('all seven classifications are represented with adequate support', () => {
    const required = ['contradiction', 'supersedes', 'qualification', 'elaboration', 'same_claim', 'near_duplicate', 'new_claim'] as const;
    const counts = new Map<string, number>();
    for (const c of cases) counts.set(c.expected.classification, (counts.get(c.expected.classification) ?? 0) + 1);
    for (const cls of required) {
      const count = counts.get(cls) ?? 0;
      expect(count, `classification '${cls}' missing or below threshold`).toBeGreaterThanOrEqual(6);
    }
  });

  it('pair metrics stay at ceiling on the v2 corpus', () => {
    const result = runPairCorpus(cases);
    expect(result.accuracy).toBe(1);
    expect(result.macroF1).toBe(1);
    for (const entry of Object.values(result.perClass)) {
      expect(entry.precision).toBe(1);
      expect(entry.recall).toBe(1);
      expect(entry.f1).toBe(1);
    }
  });

  it('every case matches planClaimObservation output exactly', () => {
    for (const c of cases) {
      const { result } = evaluatePairCase(c);
      expect(result.actual, `case ${c.id}`).toBe(c.expected.classification);
    }
  });

  it('v2 adversarial case: unrelated-topic + replacement wording → new_claim', () => {
    const adversarial = cases.find((c) => c.id === 'polarity-adversarial-unrelated-replacement');
    expect(adversarial).toBeDefined();
    const { result } = evaluatePairCase(adversarial!);
    expect(result.actual).toBe('new_claim');
  });
});
