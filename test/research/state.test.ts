import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import type { GroundedFinding } from '../../src/research/internalTypes.js';

function makeEngine(): ResearchStateEngine {
  const budget = new BudgetTracker({ maxStateEntries: 100 });
  return new ResearchStateEngine(budget);
}

function makeGroundedFinding(
  id: string,
  subject: string,
  predicate: string,
  polarity: 'asserted' | 'negated',
  overrides?: Partial<GroundedFinding>,
): GroundedFinding {
  return {
    id,
    claim: `${subject} ${predicate}`,
    normalizedClaim: `${subject} ${predicate}`,
    evidenceExcerpt: `evidence for ${subject} ${predicate}`,
    evidenceDirectness: 'direct',
    claimType: 'primary',
    sourceIds: ['src1'],
    subQuestionIds: ['sq1'],
    confidence: 0.9,
    lastUpdated: new Date().toISOString(),
    assertion: {
      subjectText: subject,
      predicate,
      polarity,
      hedge: 'certain',
      evidenceType: 'study',
      canonicalKey: { subject, predicate },
    },
    groundings: [
      {
        sourceId: 'src1',
        passageId: 'p1',
        verbatimSpan: 'test span',
        spanStart: 0,
        spanEnd: 10,
        contentHash: 'hash1',
        alignment: 'exact' as const,
      },
    ],
    extractionVersion: 'llm-grounded-v1',
    ...overrides,
  };
}

describe('postProcessFindings — polarity preservation', () => {
  it('does NOT merge asserted + negated findings sharing the same subject+predicate', () => {
    const engine = makeEngine();
    engine.initialize('test query', engine.getBudget());

    const f1 = engine.addFinding(makeGroundedFinding('x', 'React', 'is fast', 'asserted'));
    const f2 = engine.addFinding(makeGroundedFinding('x', 'React', 'is fast', 'negated'));

    expect(engine.getFindings()).toHaveLength(2);

    const result = engine.postProcessFindings();

    // Both findings survive — not merged
    expect(engine.getFindings()).toHaveLength(2);
    // merged is always 0 (no destructive merge)
    expect(result.merged).toBe(0);
    // The two findings are still distinct
    const ids = engine.getFindings().map((f) => f.id);
    expect(ids).toContain(f1);
    expect(ids).toContain(f2);
  });

  it('detects contradiction for lexical negation (asserted vs negated claim text)', () => {
    const engine = makeEngine();
    engine.initialize('test query', engine.getBudget());

    // The lexical detector needs negation words in the claim text
    const f1 = engine.addFinding(makeGroundedFinding('x', 'React', 'is fast', 'asserted', { claim: 'React is fast' }));
    const f2 = engine.addFinding(makeGroundedFinding('x', 'React', 'is not fast', 'negated', { claim: 'React is not fast' }));

    const result = engine.postProcessFindings();

    // Both findings preserved
    expect(engine.getFindings()).toHaveLength(2);
    // Contradiction detected via lexical negation heuristic
    expect(result.contradictions).toBeGreaterThanOrEqual(1);
  });

  it('returns merged: 0 when no findings', () => {
    const engine = makeEngine();
    engine.initialize('test query', engine.getBudget());
    const result = engine.postProcessFindings();
    expect(result.merged).toBe(0);
    expect(result.contradictions).toBe(0);
  });
});
