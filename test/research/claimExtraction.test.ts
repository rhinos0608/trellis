import { describe, it, expect } from 'vitest';
import {
  selectExtractionPassages,
  validateExtractedClaim,
  candidateToGroundedFinding,
  extractClaimsFromSource,
} from '../../src/research/claimExtraction.js';
import type { ClaimExtractionInput, ExtractedClaimDraft, SourcePassage } from '../../src/research/internalTypes.js';
import basicFixture from '../fixtures/extraction/v1/basic.json';
import { BudgetTracker } from '../../src/research/budget.js';
import type { LlmClient } from '../../src/research/llm/client.js';

const budget = new BudgetTracker({
  depth: 'standard', maxSources: 50, maxExtractions: 50, maxGapLoops: 4,
  minGapLoops: 2, maxToolCalls: 200, maxTokens: 400_000, maxTimeMs: 480_000,
  maxStateEntries: 500,
});

function makeInput(overrides?: Partial<ClaimExtractionInput>): ClaimExtractionInput {
  return {
    source: {
      id: basicFixture.sourceId,
      title: 'React 19 Release',
      url: 'https://example.com/react19',
      sourceType: 'web',
      isPrimary: true,
      relevantSubQuestions: ['sq1', 'sq2'],
    },
    query: basicFixture.query,
    subQuestions: basicFixture.subQuestions,
    content: basicFixture.sourceText,
    contentHash: 'test-hash',
    ...overrides,
  };
}

function makeMockLlm(rawResponse: unknown, success = true): Pick<LlmClient, 'callJSON'> {
  return {
    callJSON: async () => {
      if (!success) {
        return { success: false, response: { content: '', model: 'mock', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0, success: false, error: 'mock error' } };
      }
      return {
        success: true,
        data: rawResponse as { claims: unknown[] },
        response: { content: JSON.stringify(rawResponse), model: 'mock', tokensUsed: 100, tokensSource: 'estimated', attempts: 1, durationMs: 50, success: true },
      };
    },
  };
}

describe('selectExtractionPassages', () => {
  it('returns empty array for empty content', () => {
    expect(selectExtractionPassages('', 'src1')).toEqual([]);
  });

  it('returns single passage bounded to 16k chars', () => {
    const passages = selectExtractionPassages('Hello world', 'src1');
    expect(passages).toHaveLength(1);
    expect(passages[0]?.id).toBe('passage_src1_0');
    expect(passages[0]?.text).toBe('Hello world');
    expect(passages[0]?.startOffset).toBe(0);
    expect(passages[0]?.endOffset).toBe(11);
  });
});

describe('validateExtractedClaim', () => {
  const input = makeInput();
  const passages = selectExtractionPassages(input.content, input.source.id);
  const passageId = passages[0]?.id ?? '';

  it('accepts exact substring match', () => {
    const draft: ExtractedClaimDraft = {
      subjectText: 'React 19',
      predicate: 'was released on',
      objectText: 'December 5, 2024',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'claim',
      evidenceDirectness: 'direct',
      passageId,
      verbatimSpan: 'React 19 was released on December 5, 2024',
      confidence: 0.95,
      subQuestionIds: ['sq1'],
      caveats: [],
      freshnessSensitive: false,
    };
    const result = validateExtractedClaim(draft, input, passages, input.source.id);
    expect('reason' in result).toBe(false);
    if (!('reason' in result)) {
      expect(result.assertion.subjectText).toBe('React 19');
      expect(result.grounding.spanStart).toBe(0);
      expect(result.grounding.spanEnd).toBe(41);
    }
  });

  it('rejects hallucinated (non-substring) quote', () => {
    const draft: ExtractedClaimDraft = {
      subjectText: 'React 19',
      predicate: 'requires',
      objectText: 'Python 3.12',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'claim',
      evidenceDirectness: 'direct',
      passageId,
      verbatimSpan: 'React 19 requires Python 3.12 or later',
      confidence: 0.9,
      subQuestionIds: ['sq1'],
      caveats: [],
      freshnessSensitive: false,
    };
    const result = validateExtractedClaim(draft, input, passages, input.source.id);
    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.reason).toBe('span_not_verbatim');
    }
  });

  it('rejects unknown passageId', () => {
    const draft: ExtractedClaimDraft = {
      subjectText: 'React 19',
      predicate: 'was released on',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'claim',
      evidenceDirectness: 'direct',
      passageId: 'passage_nonexistent',
      verbatimSpan: 'something',
      confidence: 0.5,
      subQuestionIds: ['sq1'],
      caveats: [],
      freshnessSensitive: false,
    };
    const result = validateExtractedClaim(draft, input, passages, input.source.id);
    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.reason).toBe('unknown_passage');
    }
  });

  it('rejects insufficient claim-text alignment', () => {
    const draft: ExtractedClaimDraft = {
      subjectText: 'React 19',
      predicate: 'features',
      objectText: 'Server Components',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'claim',
      evidenceDirectness: 'direct',
      passageId,
      verbatimSpan: 'React',
      confidence: 0.9,
      subQuestionIds: ['sq1'],
      caveats: [],
      freshnessSensitive: false,
    };
    const result = validateExtractedClaim(draft, input, passages, input.source.id);
    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.reason).toBe('unaligned_evidence');
    }
  });

  it('rejects invalid subQuestionId', () => {
    const draft: ExtractedClaimDraft = {
      subjectText: 'React 19',
      predicate: 'was released on',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'claim',
      evidenceDirectness: 'direct',
      passageId,
      verbatimSpan: 'React 19 was released on December 5, 2024',
      confidence: 0.95,
      subQuestionIds: ['invalid_sq'],
      caveats: [],
      freshnessSensitive: false,
    };
    const result = validateExtractedClaim(draft, input, passages, input.source.id);
    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.reason).toBe('invalid_subquestion');
    }
  });
});

describe('candidateToGroundedFinding', () => {
  it('populates legacy Finding fields from assertion', () => {
    const input = makeInput();
    const passages = selectExtractionPassages(input.content, input.source.id);
    const draft: ExtractedClaimDraft = {
      subjectText: 'React 19',
      predicate: 'was released on',
      objectText: 'December 5, 2024',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'study',
      evidenceDirectness: 'direct',
      passageId: passages[0]?.id ?? '',
      verbatimSpan: 'React 19 was released on December 5, 2024',
      confidence: 0.95,
      subQuestionIds: ['sq1'],
      caveats: [],
      freshnessSensitive: false,
    };
    const candidate = validateExtractedClaim(draft, input, passages, input.source.id);
    if ('reason' in candidate) throw new Error('Expected valid candidate');

    const finding = candidateToGroundedFinding(candidate, input.source, '2025-01-01T00:00:00.000Z');
    expect(finding.claim).toContain('React 19');
    expect(finding.claimType).toBe('primary'); // study → primary
    expect(finding.assertion.subjectText).toBe('React 19');
    expect(finding.groundings).toHaveLength(1);
    expect(finding.extractionVersion).toBe('llm-grounded-v1');
    expect(finding.sourceIds).toEqual([input.source.id]);
  });
});

describe('extractClaimsFromSource', () => {
  it('returns unavailable when no LLM', async () => {
    const result = await extractClaimsFromSource(makeInput(), { budget });
    expect(result.status).toBe('unavailable');
    expect(result.findings).toHaveLength(0);
  });

  it('extracts valid claims and rejects hallucinated ones', async () => {
    const llm = makeMockLlm(basicFixture.mockLlmResponse);
    const result = await extractClaimsFromSource(makeInput(), { llm, budget });
    expect(result.status).toBe('extracted');
    expect(result.findings).toHaveLength(basicFixture.expected.validCount);
    expect(result.rejected).toHaveLength(basicFixture.expected.rejectedCount);
    expect(result.rejected[0]?.reason).toBe(basicFixture.expected.rejectedReasons[0]);
  });

  it('returns failed status on malformed JSON', async () => {
    const llm = makeMockLlm({ invalid: 'response' });
    const result = await extractClaimsFromSource(makeInput(), { llm, budget });
    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(0);
  });

  it('returns failed status on LLM call error', async () => {
    const llm = makeMockLlm(null, false);
    const result = await extractClaimsFromSource(makeInput(), { llm, budget });
    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(0);
  });

  it('returns extracted with zero claims when LLM returns empty claims', async () => {
    const llm = makeMockLlm({ claims: [] });
    const result = await extractClaimsFromSource(makeInput(), { llm, budget });
    expect(result.status).toBe('extracted');
    expect(result.findings).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it('extracts claims with LLM reranking when content is long enough', async () => {
    // Build content long enough to exceed MAX_PASSAGES=6 segments
    // Each segment is ~4K chars (DEFAULT_WINDOW_SIZE), so need >24K total
    const filler = 'The React compiler optimizes component rendering. '.repeat(40);
    const longContent = Array.from({ length: 15 }, (_, i) =>
      `## Section ${i}: React 19 features\nReact 19 introduces features like server components and the use() hook. Section ${i} discusses performance improvements in React 19. ${filler}`,
    ).join('\n\n');

    let rerankCallCount = 0;
    const llm: Pick<LlmClient, 'callJSON'> = {
      callJSON: async () => {
        rerankCallCount++;
        if (rerankCallCount === 1) {
          // First call: reranking — return valid scores for top passages
          const passages = Array.from({ length: 12 }, (_, i) => ({
            id: `passage_src_long_${i}`,
            score: 10 - i,
          }));
          return {
            success: true,
            data: { passages } as { passages: { id: string; score: number }[] },
            response: { content: JSON.stringify({ passages }), model: 'mock', tokensUsed: 100, tokensSource: 'estimated', attempts: 1, durationMs: 50, success: true },
          };
        }
        // Second call: extraction — return claims matching the actual passage IDs
        const extractionResponse = {
          claims: [
            {
              subjectText: 'React 19',
              predicate: 'introduces',
              objectText: 'server components',
              polarity: 'asserted',
              hedge: 'certain',
              evidenceType: 'claim',
              evidenceDirectness: 'direct',
              passageId: 'passage_src_long_0',
              verbatimSpan: 'React 19 introduces features like server components and the use() hook',
              confidence: 0.9,
              subQuestionIds: ['sq1'],
              caveats: [],
              freshnessSensitive: false,
            },
          ],
        };
        return {
          success: true,
          data: extractionResponse as { claims: unknown[] },
          response: { content: JSON.stringify(extractionResponse), model: 'mock', tokensUsed: 100, tokensSource: 'estimated', attempts: 1, durationMs: 50, success: true },
        };
      },
    };

    const longBudget = new BudgetTracker({
      depth: 'standard', maxSources: 50, maxExtractions: 50, maxGapLoops: 4,
      minGapLoops: 2, maxToolCalls: 200, maxTokens: 400_000, maxTimeMs: 480_000,
      maxStateEntries: 500,
    });

    const result = await extractClaimsFromSource(
      makeInput({ content: longContent }),
      { llm, budget: longBudget },
    );
    expect(result.status).toBe('extracted');
    expect(rerankCallCount).toBe(2); // reranking + extraction
  });

  it('extracts claims with deterministic path when budget insufficient for reranking', async () => {
    // Build content long enough to trigger reranking attempt (>24K chars for >6 segments)
    const filler = 'The React compiler optimizes component rendering. '.repeat(40);
    const longContent = Array.from({ length: 15 }, (_, i) =>
      `## Section ${i}: React 19 features\nReact 19 introduces features like server components and the use() hook. Section ${i} discusses performance improvements in React 19. ${filler}`,
    ).join('\n\n');

    let rerankingInvoked = false;
    const llm: Pick<LlmClient, 'callJSON'> = {
      callJSON: async (opts) => {
        // Detect reranking call vs extraction call: reranking prompt contains 'score each passage'
        const prompt = opts.messages[0]?.content ?? '';
        if (prompt.includes('score each passage')) {
          rerankingInvoked = true;
        }
        return {
          success: true,
          data: basicFixture.mockLlmResponse as { claims: unknown[] },
          response: { content: JSON.stringify(basicFixture.mockLlmResponse), model: 'mock', tokensUsed: 100, tokensSource: 'estimated', attempts: 1, durationMs: 50, success: true },
        };
      },
    };

    // Budget with only 1 tool call remaining — insufficient for reranking (needs >= 2)
    const tightBudget = new BudgetTracker({
      depth: 'standard', maxSources: 50, maxExtractions: 50, maxGapLoops: 4,
      minGapLoops: 2, maxToolCalls: 1, maxTokens: 400_000, maxTimeMs: 480_000,
      maxStateEntries: 500,
    });

    const result = await extractClaimsFromSource(
      makeInput({ content: longContent }),
      { llm, budget: tightBudget },
    );
    expect(result.status).toBe('extracted');
    // Reranking should NOT have been called (budget gate blocked it)
    expect(rerankingInvoked).toBe(false);
    // But extraction still proceeded via deterministic path
  });
});
