import { describe, it, expect } from 'vitest';
import {
  segmentSourceContent,
  selectRelevantPassages,
  selectRelevantPassagesWithLLM,
} from '../../src/research/passageSelection.js';
import { BudgetTracker } from '../../src/research/budget.js';
import type { LlmClient } from '../../src/research/llm/client.js';
import type { PassageSelectionInput } from '../../src/research/passageSelection.js';

// ── segmentSourceContent ──────────────────────────────────────────────────

describe('segmentSourceContent', () => {
  it('returns empty array for empty content', () => {
    expect(segmentSourceContent('', 'src1')).toEqual([]);
  });

  it('returns single passage for short content', () => {
    const result = segmentSourceContent('Hello world', 'src1');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('passage_src1_0');
    expect(result[0]?.text).toBe('Hello world');
    expect(result[0]?.startOffset).toBe(0);
    expect(result[0]?.endOffset).toBe(11);
  });

  it('segments content into windows with correct offsets', () => {
    const content = 'A'.repeat(10_000);
    const result = segmentSourceContent(content, 'src1', { windowSize: 4_000 });
    expect(result.length).toBeGreaterThanOrEqual(2);
    // Offsets must be contiguous and cover full content
    expect(result[0]!.startOffset).toBe(0);
    const last = result[result.length - 1]!;
    expect(last.endOffset).toBe(10_000);
    // All text concatenated equals original
    const reassembled = result.map((p) => p.text).join('');
    expect(reassembled).toBe(content);
  });

  it('prefers breaking at double-newlines over hard cut', () => {
    // 3950 chars of text + paragraph break + 50 more chars
    const before = 'x'.repeat(3_950);
    const after = 'y'.repeat(50);
    const content = before + '\n\n' + after;
    const result = segmentSourceContent(content, 'src1', { windowSize: 4_000 });
    // Should break at the paragraph boundary, not at exactly 4000
    expect(result.length).toBe(2);
    expect(result[0]!.text).toBe(before + '\n\n');
    expect(result[0]!.endOffset).toBe(3_952);
  });

  it('preserves exact text via offsets into original', () => {
    const content = 'The quick brown fox jumps. ' + 'lazy dog '.repeat(500);
    const result = segmentSourceContent(content, 'src1', { windowSize: 100 });
    for (const p of result) {
      expect(content.slice(p.startOffset, p.endOffset)).toBe(p.text);
    }
  });
});

// ── selectRelevantPassages ────────────────────────────────────────────────

describe('selectRelevantPassages', () => {
  it('returns all segments when fewer than max', () => {
    const content = 'Short content about React hooks and components.';
    const result = selectRelevantPassages({
      content,
      sourceId: 'src1',
      query: 'React hooks',
      subQuestions: ['What are hooks?', 'How do hooks work?'],
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Should contain the full content
    const joined = result.map((p) => p.text).join('');
    expect(joined).toContain('React hooks');
  });

  it('selects passage containing answer planted after 100K in ~150K source', () => {
    // Build a ~150K source where the answer is planted at ~100K
    const filler = 'Lorem ipsum dolor sit amet. '.repeat(5_000); // ~140K
    const answerText = 'THE ANSWER: Deep learning models achieve 97.3% accuracy on ImageNet benchmarks using transformer architecture.';
    // Pad to push answer past 100K
    const padding = 'noise word filler text here. '.repeat(2_000); // ~56K
    const preamble = '## Introduction\nThis paper discusses various machine learning techniques.\n\n## Background\n' + filler;
    const fullContent = preamble + padding + '\n\n## Results\n' + answerText + '\n\n## Conclusion\nMore text to fill space.';

    const result = selectRelevantPassages({
      content: fullContent,
      sourceId: 'src_long',
      query: 'What accuracy do deep learning models achieve?',
      subQuestions: ['ImageNet benchmark results', 'transformer architecture accuracy'],
    });

    // The answer region must be in the selected passages
    const allText = result.map((p) => p.text).join('');
    expect(allText).toContain('97.3% accuracy');

    // Must NOT exceed 6 passages
    expect(result.length).toBeLessThanOrEqual(6);

    // Must NOT exceed 24K total characters
    const totalChars = result.reduce((sum, p) => sum + p.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(24_000);

    // Offsets must be correct — slicing original content must match passage text
    for (const p of result) {
      expect(fullContent.slice(p.startOffset, p.endOffset)).toBe(p.text);
    }
  });

  it('stays within 24K char and 6 passage caps', () => {
    // 50 segments of 4K each = 200K total, but only 6 selected + neighbors
    const segments = Array.from({ length: 50 }, (_, i) =>
      `## Section ${i}\n${'word '.repeat(800)}`,
    );
    const content = segments.join('\n\n');

    const result = selectRelevantPassages({
      content,
      sourceId: 'src_big',
      query: 'Section 25 topic',
      subQuestions: ['detailed question about section twenty five'],
    });

    expect(result.length).toBeLessThanOrEqual(6);
    const totalChars = result.reduce((sum, p) => sum + p.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(24_000);
  });

  it('returns passages in document order', () => {
    const segments = Array.from({ length: 10 }, (_, i) =>
      `## Section ${i}\n${'word '.repeat(800)}`,
    );
    const content = segments.join('\n\n');

    const result = selectRelevantPassages({
      content,
      sourceId: 'src_order',
      query: 'Section 3 and Section 7',
      subQuestions: ['question about section three', 'question about section seven'],
    });

    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.startOffset).toBeGreaterThanOrEqual(result[i - 1]!.startOffset);
    }
  });

  it('deduplicates adjacent/overlapping segments', () => {
    const content = '## Intro\n' + 'alpha '.repeat(800) + '\n\n## Middle\n' + 'beta '.repeat(800) + '\n\n## End\n' + 'gamma '.repeat(800);
    const result = selectRelevantPassages({
      content,
      sourceId: 'src_dedup',
      query: 'alpha beta gamma everything',
      subQuestions: ['comprehensive question'],
    });
    // No duplicate passage IDs
    const ids = result.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('boosts segments starting with headings', () => {
    const topic = 'deep learning accuracy benchmark results ';
    const headingContent = '## Deep Learning Results\n' + topic.repeat(200);
    const plainContent = topic.repeat(200);
    // Create 7+ segments so scoring and heading-boost logic executes (MAX_PASSAGES=6)
    const segments = [
      plainContent, headingContent,
      plainContent, plainContent,
      plainContent, plainContent,
      plainContent,
    ];
    const content = segments.join('\n\n');
    const result = selectRelevantPassages({
      content,
      sourceId: 'src_boost',
      query: 'deep learning results accuracy',
      subQuestions: ['benchmark results'],
    });
    // Heading-prefixed segment should be selected
    const selectedTexts = result.map((p) => p.text);
    expect(selectedTexts.some((t) => t.includes('## Deep Learning Results'))).toBe(true);
    // Verify not all segments are returned (exclusion happened)
    expect(result.length).toBeLessThan(segments.length);
  });

  it('handles empty content', () => {
    expect(selectRelevantPassages({
      content: '',
      sourceId: 'src_empty',
      query: 'test',
      subQuestions: [],
    })).toEqual([]);
  });

  // ── Regression: findBreakPoint boundary bug ─────────────────────────

  it('segmentation makes forward progress with small windowSize and early newline', () => {
    // Content: one newline at pos 1, then 1000 chars of filler.
    // With windowSize: 2, the second segment starts at offset 2 and rawEnd=4.
    // Without minOffset guard, findBreakPoint(4) would search back 800 chars,
    // find the stale newline at pos 1, return 2, and the third segment would
    // start at max(2, 2+1)=3 — advancing only 1 char per iteration.
    const content = 'x\n' + 'a'.repeat(1000);
    const result = segmentSourceContent(content, 'src_boundary', { windowSize: 2 });

    // Must cover the full content
    const last = result[result.length - 1]!;
    expect(last.endOffset).toBe(content.length);

    // Must NOT degenerate: with windowSize=2, expect at most a few hundred
    // passages, not ~1000 one-char-at-a-time slices
    expect(result.length).toBeLessThanOrEqual(content.length / 2 + 10);

    // Every passage must have positive length
    for (const p of result) {
      expect(p.endOffset).toBeGreaterThan(p.startOffset);
    }

    // Offsets must be contiguous
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.startOffset).toBe(result[i - 1]!.endOffset);
    }
  });
});

// ── selectRelevantPassagesWithLLM ──────────────────────────────────────────

function makeBudget(overrides?: Partial<Parameters<typeof BudgetTracker['prototype']['remaining']>[0]>): BudgetTracker {
  return new BudgetTracker({
    depth: 'standard', maxSources: 50, maxExtractions: 50, maxGapLoops: 4,
    minGapLoops: 2, maxToolCalls: 200, maxTokens: 400_000, maxTimeMs: 480_000,
    maxStateEntries: 500,
    ...overrides,
  });
}

function makeRerankLlm(response: unknown, success = true): Pick<LlmClient, 'callJSON'> {
  return {
    callJSON: async () => {
      if (!success) {
        return {
          success: false,
          response: { content: '', model: 'mock', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0, success: false, error: 'mock error' },
        };
      }
      return {
        success: true,
        data: response as { passages: { id: string; score: number }[] },
        response: { content: JSON.stringify(response), model: 'mock', tokensUsed: 100, tokensSource: 'estimated', attempts: 1, durationMs: 50, success: true },
      };
    },
  };
}

function makeLongContent(): string {
  // 50 segments of 4K each = 200K total, more than MAX_PASSAGES=6
  const segments = Array.from({ length: 50 }, (_, i) =>
    `## Section ${i}\n${'word '.repeat(800)}`,
  );
  return segments.join('\n\n');
}

describe('selectRelevantPassagesWithLLM', () => {
  it('skips LLM path for short source (≤ MAX_PASSAGES)', async () => {
    let llmCalled = false;
    const llm: Pick<LlmClient, 'callJSON'> = {
      callJSON: async () => { llmCalled = true; return { success: true, data: { passages: [] }, response: { content: '', model: 'mock', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0, success: true } }; },
    };
    const budget = makeBudget();

    const result = await selectRelevantPassagesWithLLM(
      { content: 'Short source about React hooks.', sourceId: 'src1', query: 'React hooks', subQuestions: ['What are hooks?'] },
      { llm, budget },
    );

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(llmCalled).toBe(false);
  });

  it('reranks with 70/30 blend for long source with valid LLM response', async () => {
    const content = makeLongContent();
    const budget = makeBudget();
    const rerankScores = Array.from({ length: 12 }, (_, i) => ({
      id: `passage_src_rerank_${i}`,
      score: 10 - i, // High scores for early indices, low for later
    }));
    const llm = makeRerankLlm({ passages: rerankScores });

    const input: PassageSelectionInput = {
      content,
      sourceId: 'src_rerank',
      query: 'Section 3 topic',
      subQuestions: ['detailed question about section three'],
    };

    const reranked = await selectRelevantPassagesWithLLM(input, { llm, budget });
    const deterministic = selectRelevantPassages(input);

    // Both should respect passage count and char limits
    expect(reranked.length).toBeLessThanOrEqual(6);
    expect(deterministic.length).toBeLessThanOrEqual(6);

    const rerankedChars = reranked.reduce((sum, p) => sum + p.text.length, 0);
    const detChars = deterministic.reduce((sum, p) => sum + p.text.length, 0);
    expect(rerankedChars).toBeLessThanOrEqual(24_000);
    expect(detChars).toBeLessThanOrEqual(24_000);

    // Both must return passages in document order
    for (let i = 1; i < reranked.length; i++) {
      expect(reranked[i]!.startOffset).toBeGreaterThanOrEqual(reranked[i - 1]!.startOffset);
    }
    for (let i = 1; i < deterministic.length; i++) {
      expect(deterministic[i]!.startOffset).toBeGreaterThanOrEqual(deterministic[i - 1]!.startOffset);
    }

    // Reranked result may differ from deterministic due to LLM blend,
    // but must still be valid passages from the content
    for (const p of reranked) {
      expect(content.slice(p.startOffset, p.endOffset)).toBe(p.text);
    }
  });

  it('falls back to deterministic on malformed LLM response', async () => {
    const content = makeLongContent();
    const budget = makeBudget();
    // Malformed: missing required 'passages' field
    const llm = makeRerankLlm({ invalid: 'response' });

    const input: PassageSelectionInput = {
      content,
      sourceId: 'src_malformed',
      query: 'Section 5 topic',
      subQuestions: ['question about section five'],
    };

    const result = await selectRelevantPassagesWithLLM(input, { llm, budget });
    const deterministic = selectRelevantPassages(input);

    // Should match deterministic result on fallback
    expect(result.length).toBe(deterministic.length);
    expect(result.length).toBeLessThanOrEqual(6);
    const totalChars = result.reduce((sum, p) => sum + p.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(24_000);
    // Document order
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.startOffset).toBeGreaterThanOrEqual(result[i - 1]!.startOffset);
    }
  });

  it('falls back to deterministic on LLM call failure', async () => {
    const content = makeLongContent();
    const budget = makeBudget();
    const llm = makeRerankLlm(null, false);

    const input: PassageSelectionInput = {
      content,
      sourceId: 'src_fail',
      query: 'Section 7 topic',
      subQuestions: ['question about section seven'],
    };

    const result = await selectRelevantPassagesWithLLM(input, { llm, budget });
    const deterministic = selectRelevantPassages(input);

    expect(result.length).toBe(deterministic.length);
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('falls back to deterministic when budget is insufficient', async () => {
    const content = makeLongContent();
    // Budget with only 1 tool call remaining (needs >= 2)
    const budget = new BudgetTracker({
      depth: 'standard', maxSources: 50, maxExtractions: 50, maxGapLoops: 4,
      minGapLoops: 2, maxToolCalls: 1, maxTokens: 400_000, maxTimeMs: 480_000,
      maxStateEntries: 500,
    });
    let llmCalled = false;
    const llm: Pick<LlmClient, 'callJSON'> = {
      callJSON: async () => { llmCalled = true; return { success: true, data: { passages: [] }, response: { content: '', model: 'mock', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0, success: true } }; },
    };

    const input: PassageSelectionInput = {
      content,
      sourceId: 'src_budget',
      query: 'Section 9 topic',
      subQuestions: ['question about section nine'],
    };

    const result = await selectRelevantPassagesWithLLM(input, { llm, budget });
    const deterministic = selectRelevantPassages(input);

    expect(llmCalled).toBe(false);
    expect(result.length).toBe(deterministic.length);
  });

  it('falls back to deterministic when budget has insufficient tokens', async () => {
    const content = makeLongContent();
    const budget = new BudgetTracker({
      depth: 'standard', maxSources: 50, maxExtractions: 50, maxGapLoops: 4,
      minGapLoops: 2, maxToolCalls: 200, maxTokens: 100, maxTimeMs: 480_000,
      maxStateEntries: 500,
    });
    let llmCalled = false;
    const llm: Pick<LlmClient, 'callJSON'> = {
      callJSON: async () => { llmCalled = true; return { success: true, data: { passages: [] }, response: { content: '', model: 'mock', tokensUsed: 0, tokensSource: 'estimated', attempts: 1, durationMs: 0, success: true } }; },
    };

    const input: PassageSelectionInput = {
      content,
      sourceId: 'src_tok',
      query: 'Section 11 topic',
      subQuestions: ['question about section eleven'],
    };

    const result = await selectRelevantPassagesWithLLM(input, { llm, budget });
    expect(llmCalled).toBe(false);
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('records exactly one tool call when LLM reranking succeeds', async () => {
    const content = makeLongContent();
    const budget = makeBudget();
    const rerankScores = Array.from({ length: 12 }, (_, i) => ({
      id: `passage_src_tc_${i}`,
      score: 10 - i,
    }));
    const llm = makeRerankLlm({ passages: rerankScores });

    const toolCallsBefore = budget.remaining().toolCalls;
    await selectRelevantPassagesWithLLM(
      { content, sourceId: 'src_tc', query: 'Section 20 topic', subQuestions: ['question'] },
      { llm, budget },
    );
    const toolCallsAfter = budget.remaining().toolCalls;

    expect(toolCallsBefore - toolCallsAfter).toBe(1);
  });

  it('handles empty content gracefully', async () => {
    const budget = makeBudget();
    const llm = makeRerankLlm({ passages: [] });
    const result = await selectRelevantPassagesWithLLM(
      { content: '', sourceId: 'src_empty', query: 'test', subQuestions: [] },
      { llm, budget },
    );
    expect(result).toEqual([]);
  });

  it('falls back when reranking response has duplicate IDs', async () => {
    const content = makeLongContent();
    const budget = makeBudget();
    // Duplicate ID in response
    const llm = makeRerankLlm({ passages: [
      { id: 'passage_src_dup_0', score: 8 },
      { id: 'passage_src_dup_0', score: 5 },
    ] });

    const input: PassageSelectionInput = {
      content,
      sourceId: 'src_dup',
      query: 'Section 5 topic',
      subQuestions: ['question about section five'],
    };

    const result = await selectRelevantPassagesWithLLM(input, { llm, budget });
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('falls back when reranking response has out-of-range scores', async () => {
    const content = makeLongContent();
    const budget = makeBudget();
    // Score outside 1-10 range
    const llm = makeRerankLlm({ passages: [
      { id: 'passage_src_oob_0', score: 0 },
      { id: 'passage_src_oob_1', score: 15 },
    ] });

    const input: PassageSelectionInput = {
      content,
      sourceId: 'src_oob',
      query: 'Section 5 topic',
      subQuestions: ['question about section five'],
    };

    const result = await selectRelevantPassagesWithLLM(input, { llm, budget });
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('falls back when reranking response has unknown passage IDs', async () => {
    const content = makeLongContent();
    const budget = makeBudget();
    // ID not in the sent passages
    const llm = makeRerankLlm({ passages: [
      { id: 'passage_nonexistent', score: 8 },
    ] });

    const input: PassageSelectionInput = {
      content,
      sourceId: 'src_unknown',
      query: 'Section 5 topic',
      subQuestions: ['question about section five'],
    };

    const result = await selectRelevantPassagesWithLLM(input, { llm, budget });
    expect(result.length).toBeLessThanOrEqual(6);
  });
});
