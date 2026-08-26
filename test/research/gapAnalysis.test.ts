import { describe, it, expect } from 'vitest';
import { BudgetTracker } from '../../src/research/budget.js';
import { ResearchStateEngine } from '../../src/research/state.js';
import { GapAnalyzer, GapFiller, planGapAcquisitions } from '../../src/research/gapAnalysis.js';
import type { SubQuestion, SubQuestionCoverage, GapRecord } from '../../src/research/internalTypes.js';
import type { ResearchCapabilities } from '../../src/providers/types.js';

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

const FULL_CAPS: ResearchCapabilities = {
  search: true,
  read: true,
  academic: true,
  code: true,
  community: { reddit: true, hackernews: true, stackoverflow: true },
  media: true,
  reference: true,
  browser: false,
};

const NO_ACADEMIC_CAPS: ResearchCapabilities = {
  ...FULL_CAPS,
  academic: false,
};

describe('planGapAcquisitions', () => {
  function gap(cat: string, extra: Partial<GapRecord> = {}): GapRecord {
    return {
      id: 'g1',
      category: cat as GapRecord['category'],
      description: 'test',
      status: 'open',
      suggestedActions: [],
      priority: 1,
      ...extra,
    };
  }

  it('unanswered_sub_question → search with sub-question text', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1')]);
    const gaps = [gap('unanswered_sub_question', { subQuestionId: 'sq1' })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('search');
    expect(acq[0]!.query).toBe('What about sq1?');
    expect(acq[0]!.searchOpts).toEqual({ limit: 10 });
    expect(acq[0]!.targetSubQuestionIds).toEqual(['sq1']);
  });

  it('missing_recency → search with freshness year and finding claim', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1')]);
    // Add a finding with grounding (required by addFinding)
    state.addSource({
      id: 'src1', title: 'T', url: 'https://a.com', sourceType: 'web',
      domain: 'a.com', accessDate: new Date().toISOString(), isPrimary: false,
      relevantSubQuestions: ['sq1'], extractionStatus: 'pending', subQuestionId: 'sq1',
    });
    state.addFinding({
      claim: 'Cloud costs are rising',
      normalizedClaim: 'cloud costs rising',
      evidenceDirectness: 'direct',
      claimType: 'primary',
      sourceIds: ['src1'],
      subQuestionIds: ['sq1'],
      groundings: [{ sourceId: 'src1', passageId: 'p1', verbatimSpan: 'costs rising', spanStart: 0, spanEnd: 12, contentHash: 'h', alignment: { score: 1, method: 'verbatim', matchedTerms: ['costs', 'rising'], missingAnchorTerms: [], explanation: 'exact match' } }],
      extractionVersion: 'llm-grounded-v1',
      lastUpdated: new Date().toISOString(),
      freshnessSensitive: true,
    });
    const findings = state.getState().findings;
    const gaps = [gap('missing_recency', { relatedFindingId: findings[0]!.id, subQuestionId: 'sq1' })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('search');
    expect(acq[0]!.query).toBe('Cloud costs are rising');
    expect(acq[0]!.searchOpts).toEqual({ freshness: 'year', limit: 10 });
  });

  it('single_source_dependency → academic when caps.academic=true', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1')]);
    const gaps = [gap('single_source_dependency', { subQuestionId: 'sq1' })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('academic');
    expect(acq[0]!.query).toBe('What about sq1?');
  });

  it('single_source_dependency → search when caps.academic=false', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1')]);
    const gaps = [gap('single_source_dependency', { subQuestionId: 'sq1' })];
    const acq = planGapAcquisitions(gaps, state, NO_ACADEMIC_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('search');
  });

  it('thin_coverage → broader search (limit 15)', () => {
    const state = makeState();
    state.setSubQuestions([makeSQ('sq1')]);
    const gaps = [gap('thin_coverage', { subQuestionId: 'sq1' })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('search');
    expect(acq[0]!.searchOpts).toEqual({ limit: 15 });
  });

  it('missing_source_type produces nothing when no suggestedActions', () => {
    const state = makeState();
    const gaps = [gap('missing_source_type')];
    expect(planGapAcquisitions(gaps, state, FULL_CAPS)).toHaveLength(0);
  });

  it('overrepresented_viewpoint produces nothing when description has no match', () => {
    const state = makeState();
    const gaps = [gap('overrepresented_viewpoint')];
    expect(planGapAcquisitions(gaps, state, FULL_CAPS)).toHaveLength(0);
  });

  // ── missing_source_type capability-gated routing ─────────────────────────

  it('missing_source_type routes to academic when missing type is academic', () => {
    const state = makeState();
    const gaps = [gap('missing_source_type', {
      missingSourceTypes: ['academic'],
    })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('academic');
  });

  it('missing_source_type routes to github when missing type is github', () => {
    const state = makeState();
    const gaps = [gap('missing_source_type', {
      missingSourceTypes: ['github'],
    })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('github');
  });

  it('missing_source_type routes to reddit when missing type is reddit', () => {
    const state = makeState();
    const gaps = [gap('missing_source_type', {
      missingSourceTypes: ['reddit'],
    })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('reddit');
  });

  it('missing_source_type routes to hackernews when missing type is hackernews', () => {
    const state = makeState();
    const gaps = [gap('missing_source_type', {
      missingSourceTypes: ['hackernews'],
    })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('hackernews');
  });

  it('missing_source_type routes to stackoverflow when missing type is stackoverflow', () => {
    const state = makeState();
    const gaps = [gap('missing_source_type', {
      missingSourceTypes: ['stackoverflow'],
    })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('stackoverflow');
  });

  it('missing_source_type emits nothing when academic capability is unavailable', () => {
    const state = makeState();
    const gaps = [gap('missing_source_type', {
      missingSourceTypes: ['academic'],
    })];
    expect(planGapAcquisitions(gaps, state, NO_ACADEMIC_CAPS)).toHaveLength(0);
  });

  it('missing_source_type emits nothing when github (code) capability is unavailable', () => {
    const state = makeState();
    const caps: ResearchCapabilities = { ...FULL_CAPS, code: false };
    const gaps = [gap('missing_source_type', {
      missingSourceTypes: ['github'],
    })];
    expect(planGapAcquisitions(gaps, state, caps)).toHaveLength(0);
  });

  it('missing_source_type emits multiple acquisitions for multiple missing types', () => {
    const state = makeState();
    const gaps = [gap('missing_source_type', {
      missingSourceTypes: ['academic', 'github', 'reddit'],
    })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(3);
    expect(acq.map((a) => a.method)).toEqual(['academic', 'github', 'reddit']);
  });

  // ── overrepresented_viewpoint non-dominant routing ───────────────────────

  it('overrepresented_viewpoint routes to academic when dominant is web', () => {
    const state = makeState();
    const gaps = [gap('overrepresented_viewpoint', {
      description: 'Source type "web" dominates (90%). Bias risk.',
      dominantSourceType: 'web',
    })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('academic');
  });

  it('overrepresented_viewpoint routes to github when dominant is academic', () => {
    const state = makeState();
    const gaps = [gap('overrepresented_viewpoint', {
      description: 'Source type "academic" dominates (85%). Bias risk.',
      dominantSourceType: 'academic',
    })];
    const acq = planGapAcquisitions(gaps, state, FULL_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('github');
  });

  it('overrepresented_viewpoint routes to github when academic is unavailable and dominant is web', () => {
    const state = makeState();
    const gaps = [gap('overrepresented_viewpoint', {
      description: 'Source type "web" dominates (80%). Bias risk.',
      dominantSourceType: 'web',
    })];
    const acq = planGapAcquisitions(gaps, state, NO_ACADEMIC_CAPS);
    expect(acq).toHaveLength(1);
    expect(acq[0]!.method).toBe('github');
  });

  it('overrepresented_viewpoint emits nothing when only dominant type available', () => {
    const state = makeState();
    const caps: ResearchCapabilities = {
      search: true, read: true, academic: false, code: false,
      community: { reddit: false, hackernews: false, stackoverflow: false },
      media: false, reference: false, browser: false,
    };
    const gaps = [gap('overrepresented_viewpoint', {
      description: 'Source type "web" dominates (95%). Bias risk.',
      dominantSourceType: 'web',
    })];
    expect(planGapAcquisitions(gaps, state, caps)).toHaveLength(0);
  });

  it('unresolvable subQuestionId is skipped without throwing', () => {
    const state = makeState();
    state.setSubQuestions([]);
    const gaps = [gap('unanswered_sub_question', { subQuestionId: 'nonexistent' })];
    expect(() => planGapAcquisitions(gaps, state, FULL_CAPS)).not.toThrow();
    expect(planGapAcquisitions(gaps, state, FULL_CAPS)).toHaveLength(0);
  });

  it('unresolvable relatedFindingId is skipped without throwing', () => {
    const state = makeState();
    const gaps = [gap('missing_recency', { relatedFindingId: 'nonexistent' })];
    expect(() => planGapAcquisitions(gaps, state, FULL_CAPS)).not.toThrow();
    expect(planGapAcquisitions(gaps, state, FULL_CAPS)).toHaveLength(0);
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
