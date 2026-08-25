/**
 * Versioned reconciliation evaluation — pure metrics over the Phase 12
 * Stage B corpus (test/fixtures/reconciliation/v1/).
 *
 * All functions are deterministic and I/O-free: callers (the eval script
 * and the vitest gates) load fixtures and hand them in. The golden-
 * projection check replays scenario events through the merged projection
 * handler registry directly (NOT via rebuildProjection on a DB) because
 * appendEvents mints random ULIDs that handlers embed in derived ids
 * (rel_<eventId>, contra_<eventId>) — golden fixtures require byte-stable
 * state, so envelopes carry fixed ids/seqs/timestamps instead.
 */

import type {
  Claim,
  ClaimAssertion,
  ClaimObservation,
  ClaimReconciliation,
  ClaimReconciliationKind,
} from '../graph/types.js';
import { planClaimObservation } from '../graph/claimReconciler.js';
import {
  createEmptyProjectionState,
  canonicalSerializeProjectionState,
} from '../store/projectionState.js';
import type { ProjectionState } from '../store/projectionState.js';
import { computeProjectionChecksum, CURRENT_PROJECTION_VERSION } from '../store/checkpoints.js';
import { graphEventHandlers } from '../graph/projectionHandlers.js';

// ── Shared vocabulary ────────────────────────────────────────────────

export const CLASSIFICATIONS = [
  'contradiction',
  'supersedes',
  'qualification',
  'elaboration',
  'same_claim',
  'near_duplicate',
  'new_claim',
] as const satisfies readonly ClaimReconciliationKind[];

export type Classification = (typeof CLASSIFICATIONS)[number];

/** Canonical reuse = the observation joins the matched claim's cluster. */
export const REUSE_CLASSIFICATIONS: ReadonlySet<string> = new Set(['same_claim', 'supersedes']);

export const CORPUS_SCHEMA_VERSION = 1;
export const MIN_CASES_PER_CLASS = 6;

// ── Fixture shapes ───────────────────────────────────────────────────

type RequiredAssertion = Pick<
  ClaimAssertion,
  'subjectText' | 'predicate' | 'polarity' | 'hedge' | 'evidenceType' | 'canonicalKey'
>;
/** Fixture assertion: core fields required, everything else optional. */
export type FixtureAssertion = RequiredAssertion & Partial<Omit<ClaimAssertion, keyof RequiredAssertion>>;

export interface PairCaseFixture {
  id: string;
  category: string;
  rationale: string;
  existing: ({ id: string; confidence?: number } & FixtureAssertion)[];
  observation: FixtureAssertion;
  expected: { classification: Classification; matchedClaimId?: string };
}

export interface PairCorpusFile {
  schemaVersion: number;
  labelPolicyVersion: number;
  cases: PairCaseFixture[];
}

export interface ScenarioObservationFixture {
  id: string;
  assertion: FixtureAssertion;
  gold: { clusterId: string };
  expected: { classification: Classification; matchedClaimId?: string };
}

export interface ScenarioFixture {
  schemaVersion: number;
  name: string;
  orderInvariant: boolean;
  description?: string;
  seedClaims: ({ id: string; confidence?: number } & FixtureAssertion)[];
  observations: ScenarioObservationFixture[];
}

export interface GoldenProjectionFixture {
  corpusVersion: number;
  projectionVersion: number;
  reconcilerVersion: number;
  checksum: string;
  state: Record<string, unknown>;
}

// ── Corpus validation errors ─────────────────────────────────────────

/** Invalid corpus shape/content — eval runners must exit(2) on this. */
export class EvaluationCorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationCorpusError';
  }
}

/**
 * Validate a loaded pair corpus. Throws EvaluationCorpusError on any
 * structural problem: bad versions, duplicate IDs across files, missing
 * rationales, orphan/mismatched matchedClaimId, inadequate per-class
 * support. Used identically by the runner and the vitest gates.
 */
export function validatePairCorpus(files:  { filename: string; file: PairCorpusFile }[]): void {
  if (files.length === 0) throw new EvaluationCorpusError('pair corpus: no case files provided');
  const seenIds = new Map<string, string>();
  const classCounts = new Map<Classification, number>(CLASSIFICATIONS.map((c) => [c, 0]));

  for (const { filename, file } of files) {
    if (file.schemaVersion !== CORPUS_SCHEMA_VERSION) {
      throw new EvaluationCorpusError(`${filename}: schemaVersion must be ${String(CORPUS_SCHEMA_VERSION)}`);
    }
    if (file.labelPolicyVersion !== CORPUS_SCHEMA_VERSION) {
      throw new EvaluationCorpusError(`${filename}: labelPolicyVersion must be ${String(CORPUS_SCHEMA_VERSION)}`);
    }
    if (!Array.isArray(file.cases) || file.cases.length === 0) {
      throw new EvaluationCorpusError(`${filename}: cases array missing or empty`);
    }
    for (const c of file.cases) {
      if (typeof c.id !== 'string' || c.id === '') throw new EvaluationCorpusError(`${filename}: case missing id`);
      const owner = seenIds.get(c.id);
      if (owner !== undefined) {
        throw new EvaluationCorpusError(`duplicate case id "${c.id}" in ${filename} (first seen in ${owner})`);
      }
      seenIds.set(c.id, filename);
      if (typeof c.rationale !== 'string' || c.rationale.trim() === '') {
        throw new EvaluationCorpusError(`${filename}/${c.id}: missing rationale`);
      }
      if (!CLASSIFICATIONS.includes(c.expected.classification)) {
        throw new EvaluationCorpusError(`${filename}/${c.id}: invalid classification "${c.expected.classification}"`);
      }
      if (c.expected.classification === 'new_claim') {
        if (c.expected.matchedClaimId !== undefined) {
          throw new EvaluationCorpusError(`${filename}/${c.id}: new_claim must not declare matchedClaimId`);
        }
      } else {
        const matched = c.expected.matchedClaimId;
        if (matched === undefined) {
          throw new EvaluationCorpusError(`${filename}/${c.id}: non-new_claim requires matchedClaimId`);
        }
        if (!c.existing.some((claim) => claim.id === matched)) {
          throw new EvaluationCorpusError(`${filename}/${c.id}: matchedClaimId "${matched}" not among existing claims`);
        }
      }
      classCounts.set(c.expected.classification, (classCounts.get(c.expected.classification) ?? 0) + 1);
    }
  }

  for (const classification of CLASSIFICATIONS) {
    const count = classCounts.get(classification) ?? 0;
    if (count < MIN_CASES_PER_CLASS) {
      throw new EvaluationCorpusError(
        `class ${classification} has ${String(count)} cases, needs >= ${String(MIN_CASES_PER_CLASS)}`,
      );
    }
  }
}

// ── Fixture materialization ──────────────────────────────────────────

const EVAL_FAMILY_ID = 'eval-family';
const EVAL_RUN_ID = 'eval-run';

function materializeAssertion(assertion: FixtureAssertion): ClaimAssertion {
  return { ...assertion };
}

export function materializeExistingClaim(raw: { id: string; confidence?: number } & FixtureAssertion): Claim {
  return {
    ...materializeAssertion(raw),
    id: raw.id,
    familyId: EVAL_FAMILY_ID,
    confidence: raw.confidence ?? 0.8,
    contradictionState: 'none',
    firstSeenRunId: 'eval-seed-run',
    lastSeenRunId: 'eval-seed-run',
  };
}

export function materializeObservation(raw: FixtureAssertion, id: string): ClaimObservation {
  return {
    ...materializeAssertion(raw),
    id,
    familyId: EVAL_FAMILY_ID,
    runId: EVAL_RUN_ID,
    observedAt: '2025-01-01T00:00:00.000Z',
    confidence: 0.9,
    sourceIds: [],
    extractionVersion: 'eval-v1',
  };
}

/** ProjectionState containing exactly the given existing claims. */
export function stateWithClaims(claims: Claim[]): ProjectionState {
  const state = createEmptyProjectionState();
  for (const claim of claims) {
    state.claims.set(claim.id, claim);
    const ids = state.claimsByFamilyId.get(claim.familyId) ?? new Set<string>();
    ids.add(claim.id);
    state.claimsByFamilyId.set(claim.familyId, ids);
  }
  return state;
}

// ── Pair-corpus metrics ──────────────────────────────────────────────

export interface PairCaseResult {
  caseId: string;
  expected: Classification;
  actual: Classification;
  expectedMatchedClaimId?: string;
  actualMatchedClaimId?: string;
  match: boolean;
}

export interface ClassMetrics {
  support: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface PairCorpusResult {
  total: number;
  correct: number;
  accuracy: number;
  macroF1: number;
  confusion: Record<string, Record<string, number>>;
  perClass: Record<string, ClassMetrics>;
  mismatches: PairCaseResult[];
  /** Top-1 accuracy of matchedClaimId over cases expecting a match. */
  matchedTop1Correct: number;
  matchedTop1Total: number;
  matchedTop1Accuracy: number;
  /** Gold and predicted agree on reuse (same_claim/supersedes) vs separate. */
  canonicalReuseAccuracy: number;
  /** Gold and predicted agree on related (non-new_claim) vs reject. */
  relatedVsRejectAccuracy: number;
  /** new_claim-as-positive reject-option metrics. */
  rejectPrecision: number;
  rejectRecall: number;
  falseLinkRate: number;
}

export function evaluatePairCase(fixture: PairCaseFixture): { reconciliation: ClaimReconciliation; result: PairCaseResult } {
  const state = stateWithClaims(fixture.existing.map(materializeExistingClaim));
  const observation = materializeObservation(fixture.observation, `obs_${fixture.id}`);
  const { reconciliation } = planClaimObservation(observation, state);
  const expectedMatched = fixture.expected.matchedClaimId;
  const actualMatched = reconciliation.matchedClaimId;
  return {
    reconciliation,
    result: {
      caseId: fixture.id,
      expected: fixture.expected.classification,
      actual: reconciliation.classification,
      ...(expectedMatched !== undefined ? { expectedMatchedClaimId: expectedMatched } : {}),
      ...(actualMatched !== undefined ? { actualMatchedClaimId: actualMatched } : {}),
      match:
        reconciliation.classification === fixture.expected.classification &&
        (fixture.expected.classification === 'new_claim' || actualMatched === expectedMatched),
    },
  };
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function runPairCorpus(cases: PairCaseFixture[]): PairCorpusResult {
  const confusion: Record<string, Record<string, number>> = {};
  for (const expected of CLASSIFICATIONS) {
    confusion[expected] = Object.fromEntries(CLASSIFICATIONS.map((actual) => [actual, 0]));
  }

  const results: PairCaseResult[] = cases.map((c) => evaluatePairCase(c).result);
  let matchedTop1Correct = 0;
  let matchedTop1Total = 0;
  let reuseCorrect = 0;
  let relatedRejectCorrect = 0;

  for (const r of results) {
    const row = confusion[r.expected];
    if (row !== undefined) row[r.actual] = (row[r.actual] ?? 0) + 1;
    if (r.expected !== 'new_claim') {
      matchedTop1Total += 1;
      if (r.actualMatchedClaimId === r.expectedMatchedClaimId) matchedTop1Correct += 1;
    }
    const expectedReuse = REUSE_CLASSIFICATIONS.has(r.expected);
    const actualReuse = REUSE_CLASSIFICATIONS.has(r.actual);
    if (expectedReuse === actualReuse) reuseCorrect += 1;
    const expectedRelated = r.expected !== 'new_claim';
    const actualRelated = r.actual !== 'new_claim';
    if (expectedRelated === actualRelated) relatedRejectCorrect += 1;
  }

  const perClass: Record<string, ClassMetrics> = {};
  let macroF1Sum = 0;
  for (const classification of CLASSIFICATIONS) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const expected of CLASSIFICATIONS) {
      for (const actual of CLASSIFICATIONS) {
        const cell = confusion[expected]?.[actual] ?? 0;
        if (expected === classification && actual === classification) tp += cell;
        else if (actual === classification) fp += cell;
        else if (expected === classification) fn += cell;
      }
    }
    const precision = divide(tp, tp + fp);
    const recall = divide(tp, tp + fn);
    const f1 = divide(2 * precision * recall, precision + recall);
    perClass[classification] = {
      support: tp + fn,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      precision,
      recall,
      f1,
    };
    macroF1Sum += f1;
  }

  const total = results.length;
  const correct = results.filter((r) => r.match).length;
  const goldNewClaim = results.filter((r) => r.expected === 'new_claim');
  const rejectTruePositives = goldNewClaim.filter((r) => r.actual === 'new_claim').length;
  const predictedNewClaim = results.filter((r) => r.actual === 'new_claim');

  return {
    total,
    correct,
    accuracy: divide(correct, total),
    macroF1: divide(macroF1Sum, CLASSIFICATIONS.length),
    confusion,
    perClass,
    mismatches: results.filter((r) => !r.match),
    matchedTop1Correct,
    matchedTop1Total,
    matchedTop1Accuracy: divide(matchedTop1Correct, matchedTop1Total),
    canonicalReuseAccuracy: divide(reuseCorrect, total),
    relatedVsRejectAccuracy: divide(relatedRejectCorrect, total),
    rejectPrecision: divide(rejectTruePositives, predictedNewClaim.length),
    rejectRecall: divide(rejectTruePositives, goldNewClaim.length),
    falseLinkRate: divide(goldNewClaim.length - rejectTruePositives, goldNewClaim.length),
  };
}

// ── Cluster-scenario simulation ──────────────────────────────────────

export interface ScenarioStep {
  observationId: string;
  goldClusterId: string;
  expectedClassification: Classification;
  expectedMatchedClaimId?: string;
  reconciliation: ClaimReconciliation;
}

export interface ScenarioRun {
  state: ProjectionState;
  steps: ScenarioStep[];
}

interface EnvelopeLike {
  seq: number;
  id: string;
  timestamp: string;
  eventType: string;
  eventVersion: number;
  runId: string;
  batchId: null;
  actor: 'system';
  actorId: null;
  entityId: null;
  entityType: null;
  payload: unknown;
}

function envelope(seq: number, eventType: string, payload: unknown): EnvelopeLike {
  const index = String(seq).padStart(4, '0');
  return {
    seq,
    id: `ev-eval-${index}`,
    timestamp: `2025-01-01T00:00:${index.slice(-2)}.000Z`,
    eventType,
    eventVersion: 1,
    runId: EVAL_RUN_ID,
    batchId: null,
    actor: 'system',
    actorId: null,
    entityId: null,
    entityType: null,
    payload,
  };
}

/**
 * Replay a scenario deterministically through the merged graph handler
 * registry: seeds become CLAIM_ACCEPTED events, each observation is
 * planned with planClaimObservation against the live projection state
 * and applied as a CLAIM_OBSERVED event with fixed envelope ids/seqs.
 */
export function runScenario(scenario: ScenarioFixture): ScenarioRun {
  if (scenario.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    throw new EvaluationCorpusError(`scenario ${scenario.name}: schemaVersion must be ${String(CORPUS_SCHEMA_VERSION)}`);
  }
  const state = createEmptyProjectionState();
  let seq = 0;

  for (const seed of scenario.seedClaims) {
    seq += 1;
    const payload = {
      ...materializeAssertion(seed),
      id: seed.id,
      familyId: EVAL_FAMILY_ID,
      confidence: seed.confidence ?? 0.8,
      contradictionState: 'none' as const,
      firstSeenRunId: 'eval-seed-run',
      lastSeenRunId: 'eval-seed-run',
    };
    graphEventHandlers.CLAIM_ACCEPTED(envelope(seq, 'CLAIM_ACCEPTED', payload) as Parameters<typeof graphEventHandlers.CLAIM_ACCEPTED>[0], state);
  }

  const steps: ScenarioStep[] = [];
  for (const observation of scenario.observations) {
    seq += 1;
    const materialized = materializeObservation(observation.assertion, observation.id);
    const planned = planClaimObservation(materialized, state);
    const payload = { observation: materialized, reconciliation: planned.reconciliation };
    graphEventHandlers.CLAIM_OBSERVED(envelope(seq, 'CLAIM_OBSERVED', payload) as Parameters<typeof graphEventHandlers.CLAIM_OBSERVED>[0], state);
    steps.push({
      observationId: observation.id,
      goldClusterId: observation.gold.clusterId,
      expectedClassification: observation.expected.classification,
      ...(observation.expected.matchedClaimId !== undefined
        ? { expectedMatchedClaimId: observation.expected.matchedClaimId }
        : {}),
      reconciliation: structuredClone(planned.reconciliation),
    });
  }
  return { state, steps };
}

// ── B³ clustering metrics ────────────────────────────────────────────

export interface BCubedResult {
  precision: number;
  recall: number;
  f1: number;
  observationCount: number;
  stepMismatches: {
    observationId: string;
    expectedClassification: Classification;
    actualClassification: Classification;
    expectedMatchedClaimId?: string;
    actualMatchedClaimId?: string;
  }[];
}

/**
 * B³ precision/recall/F1 over observation-to-canonical-claim partitions.
 * Per-observation precision = |predicted ∩ gold| / |predicted|, recall =
 * |predicted ∩ gold| / |gold|, averaged across observations. Singleton
 * new_claim clusters are scored naturally (correct rejection helps,
 * wrong linking hurts).
 */
export function bCubed(steps: ScenarioStep[]): BCubedResult {
  const n = steps.length;
  if (n === 0) return { precision: 1, recall: 1, f1: 1, observationCount: 0, stepMismatches: [] };
  let precisionSum = 0;
  let recallSum = 0;
  for (let i = 0; i < n; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    const stepCanonical = step.reconciliation.canonicalClaimId;
    const stepGold = step.goldClusterId;
    let predictedCount = 0;
    let goldCount = 0;
    let overlap = 0;
    for (let j = 0; j < n; j++) {
      const other = steps[j];
      if (other === undefined) continue;
      const samePredicted = other.reconciliation.canonicalClaimId === stepCanonical;
      const sameGold = other.goldClusterId === stepGold;
      if (samePredicted) predictedCount += 1;
      if (sameGold) goldCount += 1;
      if (samePredicted && sameGold) overlap += 1;
    }
    precisionSum += divide(overlap, predictedCount);
    recallSum += divide(overlap, goldCount);
  }
  const precision = precisionSum / n;
  const recall = recallSum / n;
  return {
    precision,
    recall,
    f1: divide(2 * precision * recall, precision + recall),
    observationCount: n,
    stepMismatches: steps
      .filter((s) => s.reconciliation.classification !== s.expectedClassification
        || (s.expectedClassification !== 'new_claim'
          && s.reconciliation.matchedClaimId !== s.expectedMatchedClaimId))
      .map((s) => ({
        observationId: s.observationId,
        expectedClassification: s.expectedClassification,
        actualClassification: s.reconciliation.classification,
        ...(s.expectedMatchedClaimId !== undefined || s.reconciliation.matchedClaimId !== undefined
          ? { expectedMatchedClaimId: s.expectedMatchedClaimId, actualMatchedClaimId: s.reconciliation.matchedClaimId }
          : {}),
      })),
  };
}

export function runClusterScenario(scenario: ScenarioFixture): BCubedResult {
  return bCubed(runScenario(scenario).steps);
}

// ── Golden-projection comparison ─────────────────────────────────────

export interface GoldenComparison {
  matches: boolean;
  metadataMatches: boolean;
  checksumMatches: boolean;
  stateMatches: boolean;
  diffs: string[];
}

export function buildGoldenProjection(scenario: ScenarioFixture): GoldenProjectionFixture {
  const { state } = runScenario(scenario);
  const canonical = canonicalSerializeProjectionState(state);
  return {
    corpusVersion: CORPUS_SCHEMA_VERSION,
    projectionVersion: CURRENT_PROJECTION_VERSION,
    reconcilerVersion: 2,
    checksum: computeProjectionChecksum(state),
    state: JSON.parse(canonical) as Record<string, unknown>,
  };
}

/** Keys whose values are [[id, value], ...] map serializations. */
const MAP_COLLECTION_KEYS = new Set([
  'entities', 'claims', 'claimObservations', 'claimReconciliations', 'observationToClaimId',
  'claimRelations', 'contradictions', 'evidence', 'sources', 'gaps', 'families', 'threads',
  'researchRuns', 'entityMergeHistory', 'familyMergeHistory',
]);
const REVERSE_INDEX_KEYS = new Set([
  'observationsByClaimId', 'claimRelationsByFromClaimId', 'claimRelationsByToClaimId',
  'evidenceByClaimId', 'claimsByFamilyId', 'threadsByFamilyId',
]);

function diffMapCollections(path: string, expected: unknown, actual: unknown, diffs: string[]): void {
  const expectedEntries = new Map(Object.entries(expected as Record<string, unknown>));
  const actualEntries = new Map(Object.entries(actual as Record<string, unknown>));
  const missing = [...expectedEntries.keys()].filter((k) => !actualEntries.has(k));
  const extra = [...actualEntries.keys()].filter((k) => !expectedEntries.has(k));
  if (missing.length > 0) diffs.push(`${path}: missing IDs [${missing.sort().join(', ')}]`);
  if (extra.length > 0) diffs.push(`${path}: unexpected IDs [${extra.sort().join(', ')}]`);
  for (const key of expectedEntries.keys()) {
    if (!actualEntries.has(key)) continue;
    if (JSON.stringify(expectedEntries.get(key)) !== JSON.stringify(actualEntries.get(key))) {
      diffs.push(`${path}: changed entry "${key}"`);
    }
  }
}

/**
 * Compare a freshly simulated scenario state against its golden fixture.
 * Reports DIFFERING collections/IDs on mismatch, not just a boolean.
 */
export function compareGoldenProjection(scenario: ScenarioFixture, golden: GoldenProjectionFixture): GoldenComparison {
  const { state } = runScenario(scenario);
  const diffs: string[] = [];

  // Validate version metadata before state comparison.
  const metadataDiffs: string[] = [];
  if (golden.corpusVersion !== CORPUS_SCHEMA_VERSION) {
    metadataDiffs.push(`corpusVersion: expected ${String(CORPUS_SCHEMA_VERSION)}, got ${String(golden.corpusVersion)}`);
  }
  if (golden.projectionVersion !== CURRENT_PROJECTION_VERSION) {
    metadataDiffs.push(`projectionVersion: expected ${String(CURRENT_PROJECTION_VERSION)}, got ${String(golden.projectionVersion)}`);
  }
  if (golden.reconcilerVersion !== 2) {
    metadataDiffs.push(`reconcilerVersion: expected 2, got ${String(golden.reconcilerVersion)}`);
  }
  const metadataMatches = metadataDiffs.length === 0;
  diffs.push(...metadataDiffs);

  const checksum = computeProjectionChecksum(state);
  const checksumMatches = checksum === golden.checksum;
  const actualState = JSON.parse(canonicalSerializeProjectionState(state)) as Record<string, unknown>;
  const expectedKeys = new Set(Object.keys(golden.state));
  const actualKeys = new Set(Object.keys(actualState));
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) diffs.push(`state.${key}: missing from actual state`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) diffs.push(`state.${key}: unexpected in actual state`);
  }
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) continue;
    const expected = golden.state[key];
    const actual = actualState[key];
    if (MAP_COLLECTION_KEYS.has(key) || REVERSE_INDEX_KEYS.has(key)) {
      diffMapCollections(`state.${key}`, Object.fromEntries(expected as [string, unknown][]), Object.fromEntries(actual as [string, unknown][]), diffs);
    } else if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      diffs.push(`state.${key}: value differs`);
    }
  }
  return { matches: metadataMatches && checksumMatches && diffs.length === 0, metadataMatches, checksumMatches, stateMatches: diffs.length === 0, diffs };
}
