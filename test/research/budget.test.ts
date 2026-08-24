import { describe, it, expect } from 'vitest';
import { BudgetTracker, resolveBudgetProfile } from '../../src/research/budget.js';

function makeProfile(overrides?: Record<string, number>) {
  return {
    depth: 'standard' as const,
    maxSources: 70,
    maxExtractions: 60,
    maxGapLoops: 4,
    minGapLoops: 2,
    maxToolCalls: 200,
    maxTokens: 400_000,
    maxTimeMs: 480_000,
    maxStateEntries: 500,
    ...overrides,
  };
}

describe('BudgetTracker', () => {
  it('starts with zero usage', () => {
    const tracker = new BudgetTracker(makeProfile());
    const rem = tracker.remaining();
    expect(rem.toolCalls).toBe(200);
    expect(rem.tokens).toBe(400_000);
    expect(rem.extractions).toBe(60);
    expect(rem.gapLoops).toBe(4);
    expect(rem.stateEntries).toBe(500);
  });

  it('recordToolCall increments and returns true while under budget', () => {
    const tracker = new BudgetTracker(makeProfile({ maxToolCalls: 3 }));
    expect(tracker.recordToolCall()).toBe(true);
    expect(tracker.recordToolCall()).toBe(true);
    expect(tracker.recordToolCall()).toBe(true);
    expect(tracker.recordToolCall()).toBe(false);
    expect(tracker.remaining().toolCalls).toBe(0);
  });

  it('recordTokens increments and returns true while under budget', () => {
    const tracker = new BudgetTracker(makeProfile({ maxTokens: 100 }));
    expect(tracker.recordTokens(40)).toBe(true);
    expect(tracker.recordTokens(50)).toBe(true);
    expect(tracker.recordTokens(10)).toBe(true); // 40+50+10=100 == max, within budget (<=)
    expect(tracker.recordTokens(1)).toBe(false); // 101 > maxTokens
  });

  it('recordExtraction increments and returns true while under budget', () => {
    const tracker = new BudgetTracker(makeProfile({ maxExtractions: 2 }));
    expect(tracker.recordExtraction()).toBe(true);
    expect(tracker.recordExtraction()).toBe(true);
    expect(tracker.recordExtraction()).toBe(false);
  });

  it('incrementStateEntries with negative value clamps to zero', () => {
    const tracker = new BudgetTracker(makeProfile());
    expect(tracker.incrementStateEntries(-5)).toBe(true);
    expect(tracker.remaining().stateEntries).toBe(500);
  });

  it('incrementStateEntries tracks usage correctly', () => {
    const tracker = new BudgetTracker(makeProfile({ maxStateEntries: 10 }));
    expect(tracker.incrementStateEntries(7)).toBe(true);
    expect(tracker.incrementStateEntries(3)).toBe(true);
    expect(tracker.incrementStateEntries(1)).toBe(false);
  });

  it('recordGapLoop increments counter', () => {
    const tracker = new BudgetTracker(makeProfile({ maxGapLoops: 2 }));
    tracker.recordGapLoop();
    tracker.recordGapLoop();
    expect(tracker.snapshot().gapLoopsUsed).toBe(2);
  });

  it('isConfidencePlateau detects two consecutive low-yield loops', () => {
    const tracker = new BudgetTracker(makeProfile());
    tracker.recordFindingsAddedThisLoop(0);
    expect(tracker.isConfidencePlateau(100)).toBe(false); // need 2 loops
    tracker.recordFindingsAddedThisLoop(0);
    expect(tracker.isConfidencePlateau(100)).toBe(true); // both < 5% of 100
  });

  it('isConfidencePlateau returns false when totalFindings is 0', () => {
    const tracker = new BudgetTracker(makeProfile());
    tracker.recordFindingsAddedThisLoop(0);
    tracker.recordFindingsAddedThisLoop(0);
    expect(tracker.isConfidencePlateau(0)).toBe(false);
  });

  it('isConfidencePlateau returns false with only one loop', () => {
    const tracker = new BudgetTracker(makeProfile());
    tracker.recordFindingsAddedThisLoop(0);
    expect(tracker.isConfidencePlateau(100)).toBe(false);
  });

  it('isConfidencePlateau returns false when recent loops added enough findings', () => {
    const tracker = new BudgetTracker(makeProfile());
    tracker.recordFindingsAddedThisLoop(10);
    tracker.recordFindingsAddedThisLoop(10);
    expect(tracker.isConfidencePlateau(100)).toBe(false); // 10 >= 5% of 100
  });

  it('extendTimeBudget increases maxTimeMs', () => {
    const tracker = new BudgetTracker(makeProfile({ maxTimeMs: 1000 }));
    tracker.extendTimeBudget(500);
    expect(tracker.snapshot().maxTimeMs).toBe(1500);
  });

  it('isExhausted detects tool call exhaustion', () => {
    const tracker = new BudgetTracker(makeProfile({ maxToolCalls: 1, maxTimeMs: 999_999_999 }));
    expect(tracker.isExhausted()).toBe(false);
    tracker.recordToolCall();
    expect(tracker.isExhausted()).toBe(true);
  });

  it('isExhausted detects token exhaustion', () => {
    const tracker = new BudgetTracker(makeProfile({ maxTokens: 10, maxTimeMs: 999_999_999 }));
    tracker.recordTokens(10);
    expect(tracker.isExhausted()).toBe(true);
  });

  it('isExhausted detects extraction exhaustion', () => {
    const tracker = new BudgetTracker(makeProfile({ maxExtractions: 1, maxTimeMs: 999_999_999 }));
    tracker.recordExtraction();
    expect(tracker.isExhausted()).toBe(true);
  });

  it('isExhausted detects gap loop exhaustion', () => {
    const tracker = new BudgetTracker(makeProfile({ maxGapLoops: 1, maxTimeMs: 999_999_999 }));
    tracker.recordGapLoop();
    expect(tracker.isExhausted()).toBe(true);
  });

  it('snapshot returns a copy, not the internal state', () => {
    const tracker = new BudgetTracker(makeProfile());
    tracker.recordToolCall();
    const snap = tracker.snapshot();
    snap.toolCallsUsed = 999;
    expect(tracker.snapshot().toolCallsUsed).toBe(1);
  });

  it('restore replaces internal state from snapshot', () => {
    const tracker = new BudgetTracker(makeProfile());
    tracker.recordToolCall();
    const snap = tracker.snapshot();
    tracker.recordToolCall();
    tracker.recordToolCall();
    expect(tracker.snapshot().toolCallsUsed).toBe(3);
    tracker.restore(snap);
    expect(tracker.snapshot().toolCallsUsed).toBe(1);
  });

  it('recordStepCost accumulates per step', () => {
    const tracker = new BudgetTracker(makeProfile());
    tracker.recordStepCost('decompose', 10);
    tracker.recordStepCost('decompose', 5);
    tracker.recordStepCost('search', 3);
    expect(tracker.getStepCosts()).toEqual({ decompose: 15, search: 3 });
  });

  it('getStepCosts returns a copy', () => {
    const tracker = new BudgetTracker(makeProfile());
    tracker.recordStepCost('x', 1);
    const costs = tracker.getStepCosts();
    costs.x = 999;
    expect(tracker.getStepCosts().x).toBe(1);
  });

  it('remaining() shows correct values after partial usage', () => {
    const tracker = new BudgetTracker(makeProfile({
      maxToolCalls: 10,
      maxTokens: 1000,
      maxExtractions: 5,
      maxGapLoops: 3,
      maxStateEntries: 20,
    }));
    tracker.recordToolCall();
    tracker.recordToolCall();
    tracker.recordTokens(300);
    tracker.recordExtraction();
    tracker.recordGapLoop();
    tracker.incrementStateEntries(7);
    const rem = tracker.remaining();
    expect(rem.toolCalls).toBe(8);
    expect(rem.tokens).toBe(700);
    expect(rem.extractions).toBe(4);
    expect(rem.gapLoops).toBe(2);
    expect(rem.stateEntries).toBe(13);
  });

  it('profile is accessible', () => {
    const profile = makeProfile({ maxToolCalls: 42 });
    const tracker = new BudgetTracker(profile);
    expect(tracker.profile.maxToolCalls).toBe(42);
  });
});

describe('resolveBudgetProfile', () => {
  it('returns standard for unknown depth', () => {
    const profile = resolveBudgetProfile('unknown');
    expect(profile.depth).toBe('standard');
    expect(profile.maxSources).toBe(70);
  });

  it('returns quick profile', () => {
    const profile = resolveBudgetProfile('quick');
    expect(profile.depth).toBe('quick');
    expect(profile.maxSources).toBe(35);
    expect(profile.maxToolCalls).toBe(60);
  });

  it('returns deep profile', () => {
    const profile = resolveBudgetProfile('deep');
    expect(profile.depth).toBe('deep');
    expect(profile.maxSources).toBe(140);
  });

  it('returns exhaustive profile', () => {
    const profile = resolveBudgetProfile('exhaustive');
    expect(profile.depth).toBe('exhaustive');
    expect(profile.maxSources).toBe(220);
  });

  it('returns tree profile', () => {
    const profile = resolveBudgetProfile('tree');
    expect(profile.depth).toBe('tree');
    expect(profile.maxGapLoops).toBe(999);
  });

  it('applies maxTimeMs override', () => {
    const profile = resolveBudgetProfile('standard', { maxTimeMs: 1000 });
    expect(profile.maxTimeMs).toBe(1000);
    expect(profile.maxSources).toBe(70); // other fields unchanged
  });

  it('returns original profile when no override', () => {
    const profile = resolveBudgetProfile('standard');
    expect(profile.maxTimeMs).toBe(480_000);
  });
});
