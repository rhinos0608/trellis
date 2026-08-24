import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { GapAnalyzer, GapFiller } from '../../src/research/gapAnalysis.js';
import type { SubQuestion, SubQuestionCoverage } from '../../src/research/internalTypes.js';

function makeSQ(id: string, status: SubQuestion['status'] = 'pending'): SubQuestion {
  return {
    id,
    text: `What about ${id}?`,
    classification: 'explainer',
    evidenceType: 'general',
    preferredSources: [],
    freshnessRequirement: 'any',
    failureModes: [],
    budgetPriority: 1,
    status,
  };
}

function makeState() {
  const budget = new BudgetTracker({
    depth: 'standard',
    maxSources: 70,
    maxExtractions: 60,
    maxGapLoops: 4,
    minGapLoops: 2,
    maxToolCalls: 200,
    maxTokens: 400_000,
    maxTimeMs: 480_000,
    maxStateEntries: 500,
  });
  return new ResearchStateEngine(budget);
}

describe('GapAnalyzer', () => {
  it('detects unanswered sub-questions', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1'), makeSQ('sq2')]);
    const analyzer = new GapAnalyzer(state);
    const gaps = analyzer.analyze();
    const unanswered = gaps.filter((g) => g.category === 'unanswered_sub_question');
    expect(unanswered).toHaveLength(2);
  });

  it('ignores answered sub-questions', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1', 'sufficient')]);
    const analyzer = new GapAnalyzer(state);
    const gaps = analyzer.analyze();
    const unanswered = gaps.filter((g) => g.category === 'unanswered_sub_question');
    expect(unanswered).toHaveLength(0);
  });

  it('detects missing source type diversity', () => {
    const state = makeState();
    state.setSubQuestions([]);
    // Add sources of only 1 type
    state.addSource({
      id: 's1', title: 'T1', url: 'https://a.com/1', sourceType: 'web',
      domain: 'a.com', accessDate: new Date().toISOString(), isPrimary: false,
      relevantSubQuestions: [], extractionStatus: 'pending', subQuestionId: '',
    });
    const analyzer = new GapAnalyzer(state);
    const gaps = analyzer.analyze();
    const missingType = gaps.filter((g) => g.category === 'missing_source_type');
    expect(missingType).toHaveLength(1);
  });

  it('does not flag missing source types when 3+ types present', () => {
    const state = makeState();
    state.setSubQuestions([]);
    const types = ['web', 'academic', 'github'] as const;
    for (const t of types) {
      state.addSource({
        id: `s-${t}`, title: t, url: `https://${t}.com`, sourceType: t,
        domain: `${t}.com`, accessDate: new Date().toISOString(), isPrimary: false,
        relevantSubQuestions: [], extractionStatus: 'pending', subQuestionId: '',
      });
    }
    const analyzer = new GapAnalyzer(state);
    const gaps = analyzer.analyze();
    const missingType = gaps.filter((g) => g.category === 'missing_source_type');
    expect(missingType).toHaveLength(0);
  });

  it('detects overrepresented viewpoints when one type dominates >70%', () => {
    const state = makeState();
    state.setSubQuestions([]);
    for (let i = 0; i < 10; i++) {
      state.addSource({
        id: `s${i}`, title: `T${i}`, url: `https://web.com/${i}`, sourceType: 'web',
        domain: 'web.com', accessDate: new Date().toISOString(), isPrimary: false,
        relevantSubQuestions: [], extractionStatus: 'pending', subQuestionId: '',
      });
    }
    // 1 non-web source
    state.addSource({
      id: 's-academic', title: 'Academic', url: 'https://arxiv.com/1', sourceType: 'academic',
      domain: 'arxiv.com', accessDate: new Date().toISOString(), isPrimary: false,
      relevantSubQuestions: [], extractionStatus: 'pending', subQuestionId: '',
    });
    const analyzer = new GapAnalyzer(state);
    const gaps = analyzer.analyze();
    const overrep = gaps.filter((g) => g.category === 'overrepresented_viewpoint');
    expect(overrep).toHaveLength(1);
    expect(overrep[0]!.description).toContain('web');
  });

  it('detects thin coverage from SubQuestionCoverage', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1')]);
    const coverage: SubQuestionCoverage[] = [{
      subQuestionId: 'sq1',
      subQuestionText: 'What about sq1?',
      sourceCount: 1,
      uniqueDomainCount: 1,
      findingCount: 0,
      averageContentDepth: 0,
      hasPromotionalSources: false,
      sourceTypes: ['web'],
      status: 'thin',
    }];
    const analyzer = new GapAnalyzer(state);
    const gaps = analyzer.analyze(coverage);
    const thinGaps = gaps.filter((g) => g.category === 'single_source_dependency');
    expect(thinGaps).toHaveLength(1);
  });

  it('deduplicates thin coverage gaps', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1')]);
    const coverage: SubQuestionCoverage[] = [
      {
        subQuestionId: 'sq1', subQuestionText: 'Q', sourceCount: 1,
        uniqueDomainCount: 1, findingCount: 0, averageContentDepth: 0,
        hasPromotionalSources: false, sourceTypes: ['web'], status: 'thin',
      },
      {
        subQuestionId: 'sq1', subQuestionText: 'Q', sourceCount: 1,
        uniqueDomainCount: 1, findingCount: 0, averageContentDepth: 0,
        hasPromotionalSources: false, sourceTypes: ['web'], status: 'thin',
      },
    ];
    const analyzer = new GapAnalyzer(state);
    const gaps = analyzer.analyze(coverage);
    const thinGaps = gaps.filter((g) =>
      g.category === 'single_source_dependency' || g.category === 'thin_coverage',
    );
    expect(thinGaps).toHaveLength(1);
  });
});

describe('GapFiller', () => {
  it('fillGaps adds new gaps and records gap loop', () => {
    const budget = new BudgetTracker({
      depth: 'standard', maxSources: 70, maxExtractions: 60,
      maxGapLoops: 4, minGapLoops: 2, maxToolCalls: 200,
      maxTokens: 400_000, maxTimeMs: 480_000, maxStateEntries: 500,
    });
    const state = makeState();
    const filler = new GapFiller(state, budget);

    const gaps = [{
      id: 'g1', category: 'thin_coverage' as const, description: 'Test',
      status: 'open' as const, suggestedActions: [], priority: 1,
    }];

    return filler.fillGaps(gaps).then((result) => {
      expect(result.filled).toBe(1);
      expect(result.remaining).toEqual([]);
      expect(budget.snapshot().gapLoopsUsed).toBe(1);
    });
  });

  it('fillGaps deduplicates existing gaps', () => {
    const budget = new BudgetTracker({
      depth: 'standard', maxSources: 70, maxExtractions: 60,
      maxGapLoops: 4, minGapLoops: 2, maxToolCalls: 200,
      maxTokens: 400_000, maxTimeMs: 480_000, maxStateEntries: 500,
    });
    const state = makeState();
    const filler = new GapFiller(state, budget);

    const gap1 = {
      id: 'g1', category: 'thin_coverage' as const, description: 'Test',
      status: 'open' as const, suggestedActions: [], priority: 1,
    };
    const gap1Dupe = {
      id: 'g2', category: 'thin_coverage' as const, description: 'Test dup',
      status: 'open' as const, suggestedActions: [], priority: 1,
    };

    return filler.fillGaps([gap1]).then(() =>
      filler.fillGaps([gap1Dupe]).then((result) => {
        expect(result.filled).toBe(0);
        expect(result.remaining).toHaveLength(1);
      }),
    );
  });

  it('shouldContinueLoop returns false when budget exhausted', () => {
    const budget = new BudgetTracker({
      depth: 'standard', maxSources: 70, maxExtractions: 60,
      maxGapLoops: 4, minGapLoops: 2, maxToolCalls: 200,
      maxTokens: 400_000, maxTimeMs: 480_000, maxStateEntries: 500,
    });
    const state = makeState();
    // Exhaust budget
    for (let i = 0; i < 200; i++) budget.recordToolCall();
    const filler = new GapFiller(state, budget);
    expect(filler.shouldContinueLoop()).toBe(false);
  });

  it('shouldContinueLoop returns true when there are open gaps and min loops not met', () => {
    const budget = new BudgetTracker({
      depth: 'standard', maxSources: 70, maxExtractions: 60,
      maxGapLoops: 4, minGapLoops: 2, maxToolCalls: 200,
      maxTokens: 400_000, maxTimeMs: 480_000, maxStateEntries: 500,
    });
    const state = makeState();
    // Add an open gap
    state.addGap({
      id: 'g1', category: 'thin_coverage', description: 'Test',
      status: 'open', suggestedActions: [], priority: 1,
    });
    const filler = new GapFiller(state, budget);
    // No gap loops used yet, minGapLoops is 2
    expect(filler.shouldContinueLoop()).toBe(true);
  });

  it('shouldContinueLoop returns false with no open gaps and no thin coverage', () => {
    const budget = new BudgetTracker({
      depth: 'standard', maxSources: 70, maxExtractions: 60,
      maxGapLoops: 4, minGapLoops: 2, maxToolCalls: 200,
      maxTokens: 400_000, maxTimeMs: 480_000, maxStateEntries: 500,
    });
    const state = makeState();
    state.setSubQuestions([]);
    const filler = new GapFiller(state, budget);
    expect(filler.shouldContinueLoop()).toBe(false);
  });
});
