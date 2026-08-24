import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { PruningEngine } from '../../src/research/pruning.js';
import type { SourceEntry, Finding, GapRecord } from '../../src/research/internalTypes.js';

function makeSource(id: string, overrides?: Partial<SourceEntry>): SourceEntry {
  return {
    id,
    title: `Source ${id}`,
    url: `https://example.com/${id}`,
    sourceType: 'web',
    domain: 'example.com',
    accessDate: new Date().toISOString(),
    isPrimary: false,
    relevantSubQuestions: [],
    extractionStatus: 'pending',
    subQuestionId: '',
    ...overrides,
  };
}

function makeFinding(id: string, sourceIds: string[], overrides?: Partial<Finding>): Finding {
  return {
    id,
    claim: `Finding ${id}`,
    normalizedClaim: `finding ${id}`,
    evidenceDirectness: 'secondary',
    claimType: 'secondary',
    sourceIds,
    subQuestionIds: [],
    createdAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

function makeGap(id: string, priority: number): GapRecord {
  return {
    id,
    category: 'thin_coverage',
    description: `Gap ${id}`,
    status: 'open',
    suggestedActions: [],
    priority,
  };
}

function makeState(budgetOverrides?: Record<string, number>) {
  const profile = {
    depth: 'standard' as const,
    maxSources: 70,
    maxExtractions: 60,
    maxGapLoops: 4,
    minGapLoops: 2,
    maxToolCalls: 200,
    maxTokens: 400_000,
    maxTimeMs: 480_000,
    maxStateEntries: 50,
    ...budgetOverrides,
  };
  const budget = new BudgetTracker(profile);
  return new ResearchStateEngine(budget);
}

describe('PruningEngine', () => {
  describe('tierFindings', () => {
    it('tiers findings by source count', () => {
      const engine = new PruningEngine();
      const findings = [
        makeFinding('f1', ['s1', 's2', 's3']),         // confirmed (3+)
        makeFinding('f2', ['s1', 's2']),                // corroborated (2)
        makeFinding('f3', ['s1']),                       // unverified (1)
      ];
      const tiers = engine.tierFindings(findings);
      expect(tiers.confirmed).toHaveLength(1);
      expect(tiers.confirmed[0]!.id).toBe('f1');
      expect(tiers.corroborated).toHaveLength(1);
      expect(tiers.corroborated[0]!.id).toBe('f2');
      expect(tiers.unverified).toHaveLength(1);
      expect(tiers.unverified[0]!.id).toBe('f3');
    });

    it('returns empty arrays for empty input', () => {
      const engine = new PruningEngine();
      const tiers = engine.tierFindings([]);
      expect(tiers.confirmed).toEqual([]);
      expect(tiers.corroborated).toEqual([]);
      expect(tiers.unverified).toEqual([]);
    });
  });

  describe('enforceStateGuard', () => {
    it('does nothing when under budget', () => {
      const state = makeState({ maxStateEntries: 100 });
      state.addSource(makeSource('s1'));
      state.addFinding(makeFinding('f1', ['s1']));
      const engine = new PruningEngine();
      const evicted = engine.enforceStateGuard(state, state.getBudget());
      expect(evicted).toBe(0);
    });

    it('evicts sources without findings first', () => {
      const state = makeState({ maxStateEntries: 100 });
      state.addSource(makeSource('s1'));
      state.addSource(makeSource('s2'));
      state.addSource(makeSource('s3'));
      state.addSource(makeSource('s4'));
      state.addFinding(makeFinding('f1', ['s1']));
      state.addSource(makeSource('s5'));
      // 6 entries. Load via fromJSON into a state with maxStateEntries=5 tracker
      const snapshot = state.getState();
      const tightBudget = new BudgetTracker({
        depth: 'standard', maxSources: 70, maxExtractions: 60,
        maxGapLoops: 4, minGapLoops: 2, maxToolCalls: 200,
        maxTokens: 400_000, maxTimeMs: 480_000, maxStateEntries: 5,
      });
      state.initialize('test', tightBudget);
      state.getState(); // sync
      state.fromJSON(snapshot); // load the 6 entries

      const engine = new PruningEngine();
      const evicted = engine.enforceStateGuard(state, tightBudget);
      expect(evicted).toBeGreaterThan(0);
      const remainingIds = state.getSources().map((s) => s.id);
      expect(remainingIds).toContain('s1');
    });

    it('returns 0 when entries are exactly at max', () => {
      const state = makeState({ maxStateEntries: 5 });
      state.addSource(makeSource('s1'));
      state.addSource(makeSource('s2'));
      state.addSource(makeSource('s3'));
      state.addFinding(makeFinding('f1', ['s1']));
      state.addFinding(makeFinding('f2', ['s2']));
      // total = 5 entries, max = 5
      const engine = new PruningEngine();
      const evicted = engine.enforceStateGuard(state, state.getBudget());
      expect(evicted).toBe(0);
    });
  });

  describe('evictSources', () => {
    it('returns 0 for empty sources', () => {
      const state = makeState();
      const engine = new PruningEngine();
      const evicted = engine.evictSources(state, state.getBudget());
      expect(evicted).toBe(0);
    });

    it('removes stale pending sources not linked to findings', () => {
      const state = makeState({ maxSources: 100 });
      // Create a source with an old access date (>120s ago) and pending extraction
      const oldDate = new Date(Date.now() - 200_000).toISOString();
      state.addSource(makeSource('s-old', {
        accessDate: oldDate,
        extractionStatus: 'pending',
      }));
      state.addSource(makeSource('s-linked', {
        accessDate: oldDate,
        extractionStatus: 'pending',
      }));
      state.addFinding(makeFinding('f1', ['s-linked']));

      const engine = new PruningEngine();
      const evicted = engine.evictSources(state, state.getBudget());
      expect(evicted).toBeGreaterThanOrEqual(1);
      const ids = state.getSources().map((s) => s.id);
      expect(ids).toContain('s-linked');
    });
  });
});
