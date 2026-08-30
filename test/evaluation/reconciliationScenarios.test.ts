import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareGoldenProjection,
  CORPUS_SCHEMA_VERSION,
  runClusterScenario,
  runScenario,
} from '../../src/evaluation/reconciliation.js';
import type { BCubedResult, ScenarioStep } from '../../src/evaluation/reconciliation.js';
import { CURRENT_PROJECTION_VERSION } from '../../src/store/checkpoints.js';
import { loadScenarios } from '../../src/evaluation/fixtures.js';

const scenariosDir = path.join(
  fileURLToPath(import.meta.url), '..', '..', '..', 'test', 'fixtures', 'reconciliation', 'v1', 'scenarios',
);
const scenarios = loadScenarios(scenariosDir);
const names = scenarios.map((s) => s.name);

/**
 * Hard-blocking regression gate for sequence scenarios: every ordered step
 * must reconcile exactly as labeled, B³ clustering against gold partitions
 * must stay perfect, and each scenario's full projection replay (fixed
 * ids/timestamps through the graph handler registry) must reproduce its
 * golden fixture at the checksum level.
 */
describe('reconciliation scenario gates (v1)', () => {
  it('loads all 6 scenarios with golden projections', () => {
    expect(names).toEqual([
      'ambiguity-rejection',
      'longitudinal-paraphrases',
      'mixed-candidate-ranking',
      'negation-and-qualification',
      'numeric-disagreement',
      'temporal-revisions',
    ]);
  });

  it.each(names)('%s: every step matches expected classification + matched candidate', (name) => {
    const loaded = scenarios.find((s) => s.name === name)!;
    const { steps } = runScenario(loaded.scenario);
    expect(steps).toHaveLength(loaded.scenario.observations.length);
    for (const step of steps) {
      expect(step.reconciliation.classification, `${name}/${step.observationId} classification`)
        .toBe(step.expectedClassification);
      if (step.expectedClassification !== 'new_claim') {
        expect(step.reconciliation.matchedClaimId, `${name}/${step.observationId} matched claim`)
          .toBe(step.expectedMatchedClaimId);
      } else {
        expect(step.reconciliation.matchedClaimId).toBeUndefined();
      }
      // Canonical reuse contract: same_claim joins the matched cluster.
      // Supersedes creates a NEW claim identity (distinct canonicalClaimId).
      if (step.reconciliation.classification === 'same_claim') {
        expect(step.reconciliation.canonicalClaimId).toBe(step.reconciliation.matchedClaimId);
      }
      if (step.reconciliation.classification === 'supersedes') {
        expect(step.reconciliation.canonicalClaimId).not.toBe(step.reconciliation.matchedClaimId);
      }
    }
  });

  it.each(names)('%s: B³ clustering is perfect against gold partitions', (name) => {
    const loaded = scenarios.find((s) => s.name === name)!;
    const b3: BCubedResult = runClusterScenario(loaded.scenario);
    expect(b3.stepMismatches).toEqual([]);
    expect(b3.precision).toBe(1);
    expect(b3.recall).toBe(1);
    expect(b3.f1).toBe(1);
  });

  it.each(names)('%s: golden projection replay matches fixture exactly', (name) => {
    const loaded = scenarios.find((s) => s.name === name)!;
    const comparison = compareGoldenProjection(loaded.scenario, loaded.golden);
    expect(comparison.checksumMatches, `diffs: ${comparison.diffs.join('; ')}`).toBe(true);
    expect(comparison.diffs).toEqual([]);

    // Spot-check specific state fields beyond the checksum.
    const { state, steps }: { state: ReturnType<typeof runScenario>['state']; steps: ScenarioStep[] } =
      runScenario(loaded.scenario);
    expect(state.claims.size).toBeGreaterThan(0);
    for (const step of steps) {
      const canonicalId = step.reconciliation.canonicalClaimId;
      expect(state.observationToClaimId.get(step.observationId), `${name}/${step.observationId} cluster assignment`)
        .toBe(canonicalId);
      expect(state.claimObservations.has(step.observationId)).toBe(true);
      expect(state.claims.has(canonicalId)).toBe(true);
    }
    // Supersession creates a NEW claim identity — the old claim receives
    // a CLAIM_EXPIRED event (event-sourcing: domain code emits, never mutates
    // read model directly). The golden test verifies canonical cluster assignment above.
  });

  describe('golden projection metadata validation', () => {
    it('passes when metadata matches current versions', () => {
      const loaded = scenarios.find((s) => s.name === 'temporal-revisions')!;
      const comparison = compareGoldenProjection(loaded.scenario, loaded.golden);
      expect(comparison.metadataMatches).toBe(true);
    });

    it('reports stale corpusVersion', () => {
      const loaded = scenarios.find((s) => s.name === 'temporal-revisions')!;
      const tampered = { ...loaded.golden, corpusVersion: 99 };
      const comparison = compareGoldenProjection(loaded.scenario, tampered);
      expect(comparison.metadataMatches).toBe(false);
      expect(comparison.matches).toBe(false);
      expect(comparison.diffs.some((d) => d.includes('corpusVersion'))).toBe(true);
    });

    it('reports stale projectionVersion', () => {
      const loaded = scenarios.find((s) => s.name === 'temporal-revisions')!;
      const tampered = { ...loaded.golden, projectionVersion: CURRENT_PROJECTION_VERSION - 1 };
      const comparison = compareGoldenProjection(loaded.scenario, tampered);
      expect(comparison.metadataMatches).toBe(false);
      expect(comparison.matches).toBe(false);
      expect(comparison.diffs.some((d) => d.includes('projectionVersion'))).toBe(true);
    });

    it('reports stale reconcilerVersion', () => {
      const loaded = scenarios.find((s) => s.name === 'temporal-revisions')!;
      const tampered = { ...loaded.golden, reconcilerVersion: 1 };
      const comparison = compareGoldenProjection(loaded.scenario, tampered);
      expect(comparison.metadataMatches).toBe(false);
      expect(comparison.matches).toBe(false);
      expect(comparison.diffs.some((d) => d.includes('reconcilerVersion'))).toBe(true);
    });
  });
});
