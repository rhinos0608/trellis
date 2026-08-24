/**
 * Budget tracker — tracks resource usage during a research run.
 * Ported from search-mcp state.ts BudgetTracker.
 */

import type { BudgetProfile, BudgetState } from './internalTypes.js';

export class BudgetTracker {
  private state: BudgetState;
  readonly profile: BudgetProfile;

  constructor(profile: BudgetProfile) {
    this.profile = profile;
    this.state = {
      toolCallsUsed: 0,
      tokensUsed: 0,
      extractionsUsed: 0,
      gapLoopsUsed: 0,
      startTime: Date.now(),
      maxToolCalls: profile.maxToolCalls,
      maxTokens: profile.maxTokens,
      maxExtractions: profile.maxExtractions,
      maxGapLoops: profile.maxGapLoops,
      stateEntriesUsed: 0,
      maxStateEntries: profile.maxStateEntries,
      maxTimeMs: profile.maxTimeMs,
      stepCosts: {},
      findingsAddedPerLoop: [],
    };
  }

  recordToolCall(): boolean {
    this.state.toolCallsUsed++;
    return this.state.toolCallsUsed <= this.profile.maxToolCalls;
  }

  recordTokens(count: number): boolean {
    this.state.tokensUsed += count;
    return this.state.tokensUsed <= this.profile.maxTokens;
  }

  recordExtraction(): boolean {
    this.state.extractionsUsed++;
    return this.state.extractionsUsed <= this.profile.maxExtractions;
  }

  incrementStateEntries(n: number): boolean {
    if (n < 0) n = 0;
    this.state.stateEntriesUsed += n;
    return this.state.stateEntriesUsed <= this.state.maxStateEntries;
  }

  recordGapLoop(): void {
    this.state.gapLoopsUsed++;
  }

  recordFindingsAddedThisLoop(n: number): void {
    this.state.findingsAddedPerLoop.push(n);
  }

  isConfidencePlateau(totalFindings: number): boolean {
    const arr = this.state.findingsAddedPerLoop;
    if (arr.length < 2 || totalFindings <= 0) return false;
    const threshold = 0.05 * totalFindings;
    const last = arr[arr.length - 1];
    const secondLast = arr[arr.length - 2];
    if (last === undefined || secondLast === undefined) return false;
    return last < threshold && secondLast < threshold;
  }

  extendTimeBudget(additionalMs: number): void {
    this.state.maxTimeMs += additionalMs;
  }

  isExhausted(): boolean {
    return (
      this.state.toolCallsUsed >= this.profile.maxToolCalls ||
      this.state.tokensUsed >= this.profile.maxTokens ||
      this.state.extractionsUsed >= this.profile.maxExtractions ||
      this.state.gapLoopsUsed >= this.profile.maxGapLoops ||
      this.state.stateEntriesUsed >= this.state.maxStateEntries ||
      this.elapsedMs() >= this.state.maxTimeMs
    );
  }

  remaining(): {
    toolCalls: number;
    tokens: number;
    extractions: number;
    gapLoops: number;
    stateEntries: number;
    timeMs: number;
  } {
    return {
      toolCalls: Math.max(0, this.profile.maxToolCalls - this.state.toolCallsUsed),
      tokens: Math.max(0, this.profile.maxTokens - this.state.tokensUsed),
      extractions: Math.max(
        0,
        this.profile.maxExtractions - this.state.extractionsUsed,
      ),
      gapLoops: Math.max(
        0,
        this.profile.maxGapLoops - this.state.gapLoopsUsed,
      ),
      stateEntries: Math.max(
        0,
        this.state.maxStateEntries - this.state.stateEntriesUsed,
      ),
      timeMs: Math.max(0, this.state.maxTimeMs - this.elapsedMs()),
    };
  }

  elapsedMs(): number {
    return Date.now() - this.state.startTime;
  }

  snapshot(): BudgetState {
    return { ...this.state };
  }

  restore(snapshot: BudgetState): void {
    this.state = { ...snapshot };
  }

  recordStepCost(step: string, cost: number): void {
    this.state.stepCosts[step] =
      (this.state.stepCosts[step] ?? 0) + cost;
  }

  getStepCosts(): Record<string, number> {
    return { ...this.state.stepCosts };
  }
}

// ── Budget profiles ────────────────────────────────────────────────────────

const BUDGET_PROFILES: Record<string, BudgetProfile> & { standard: BudgetProfile } = {
  quick: {
    depth: 'quick',
    maxSources: 35,
    maxExtractions: 15,
    maxGapLoops: 2,
    minGapLoops: 1,
    maxToolCalls: 60,
    maxTokens: 150_000,
    maxTimeMs: 300_000,
    maxStateEntries: 200,
  },
  standard: {
    depth: 'standard',
    maxSources: 70,
    maxExtractions: 60,
    maxGapLoops: 4,
    minGapLoops: 2,
    maxToolCalls: 200,
    maxTokens: 400_000,
    maxTimeMs: 480_000,
    maxStateEntries: 500,
  },
  deep: {
    depth: 'deep',
    maxSources: 140,
    maxExtractions: 100,
    maxGapLoops: 6,
    minGapLoops: 3,
    maxToolCalls: 400,
    maxTokens: 800_000,
    maxTimeMs: 1_800_000,
    maxStateEntries: 1000,
  },
  exhaustive: {
    depth: 'exhaustive',
    maxSources: 220,
    maxExtractions: 150,
    maxGapLoops: 8,
    minGapLoops: 4,
    maxToolCalls: 800,
    maxTokens: 1_500_000,
    maxTimeMs: 2_700_000,
    maxStateEntries: 2000,
  },
  tree: {
    depth: 'tree',
    maxSources: 100,
    maxExtractions: 50,
    maxGapLoops: 999,
    minGapLoops: 0,
    maxToolCalls: 300,
    maxTokens: 600_000,
    maxTimeMs: 900_000,
    maxStateEntries: 500,
  },
};

export function resolveBudgetProfile(
  depth: string,
  overrides?: { maxTimeMs?: number },
): BudgetProfile {
  const base = BUDGET_PROFILES[depth] ?? BUDGET_PROFILES.standard;
  return overrides?.maxTimeMs ? { ...base, maxTimeMs: overrides.maxTimeMs } : base;
}
