/**
 * Structure-aware, relevance-based passage selection for claim extraction.
 * Replaces naive first-16K-character truncation with scored window selection
 * so relevant content deep in long sources is not silently dropped.
 *
 * Reuses the same normalize/tokenize/tokenOverlap pattern as familyResolver.ts
 * for deterministic, dependency-free scoring.
 */

import { z } from 'zod';
import type { SourcePassage } from './internalTypes.js';
import type { LlmClient } from './llm/client.js';
import type { BudgetTracker } from './budget.js';

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_SIZE = 4_000;
const MAX_PASSAGES = 6;
const MAX_TOTAL_CHARS = 24_000;

// ── Tokenization (same pattern as workspace/familyResolver.ts) ─────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'not', 'so', 'if', 'then', 'that', 'this', 'these', 'those', 'it',
  'its', 'about', 'which', 'who', 'whom', 'what', 'when', 'where', 'how',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'only', 'own', 'same', 'than', 'too', 'very',
]);

function tokenize(text: string): string[] {
  return text
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}\s-]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Heading detection ──────────────────────────────────────────────────────

const HEADING_RE = /^#{1,6}\s+\S/m;

// ── Segmentation ───────────────────────────────────────────────────────────

/**
 * Preferred break points — prefer breaking at double-newlines (paragraph
 * boundaries), then single newlines, then simply at the window size limit.
 */
function findBreakPoint(text: string, targetOffset: number, maxSearchBack = 800, minOffset = 0): number {
  const searchStart = Math.max(minOffset, targetOffset - maxSearchBack);
  const slice = text.slice(searchStart, targetOffset);

  // Prefer double-newline (paragraph break)
  const lastDouble = slice.lastIndexOf('\n\n');
  if (lastDouble >= 0) return searchStart + lastDouble + 2;

  // Then single newline
  const lastSingle = slice.lastIndexOf('\n');
  if (lastSingle >= 0) return searchStart + lastSingle + 1;

  // Fallback: hard cut at target
  return targetOffset;
}

/**
 * Segment content into ordered windows of roughly `windowSize` characters,
 * preferring to break on heading or paragraph boundaries.
 */
export function segmentSourceContent(
  content: string,
  sourceId: string,
  options?: { windowSize?: number },
): SourcePassage[] {
  if (content.length === 0) return [];

  const rawWindow = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
  if (!Number.isFinite(rawWindow) || rawWindow <= 0) return [];
  const windowSize = Math.min(rawWindow, MAX_TOTAL_CHARS);
  const passages: SourcePassage[] = [];
  let offset = 0;
  let idx = 0;

  while (offset < content.length) {
    const rawEnd = Math.min(offset + windowSize, content.length);
    const end = rawEnd < content.length
      ? findBreakPoint(content, rawEnd, 800, offset)
      : rawEnd;

    passages.push({
      id: `passage_${sourceId}_${String(idx)}`,
      text: content.slice(offset, end),
      startOffset: offset,
      endOffset: end,
    });

    // Don't advance by zero if we're stuck
    const nextOffset = Math.max(end, offset + 1);
    if (nextOffset <= offset) break;
    offset = nextOffset;
    idx++;
  }

  return passages;
}

// ── Relevance scoring ──────────────────────────────────────────────────────

export interface PassageSelectionInput {
  content: string;
  sourceId: string;
  query: string;
  subQuestions: string[];
}

/**
 * Select the most relevant passages for claim extraction.
 *
 * 1. Segment full content into windows.
 * 2. Score each window by token overlap against query + subQuestions.
 * 3. Boost segments that begin with a heading.
 * 4. Pick top-scoring segments up to MAX_PASSAGES / MAX_TOTAL_CHARS.
 * 5. Add one neighboring segment for context if budget allows.
 * 6. Deduplicate and re-sort into document order.
 */
export function selectRelevantPassages(
  input: PassageSelectionInput,
  options?: { windowSize?: number },
): SourcePassage[] {
  const segments = segmentSourceContent(input.content, input.sourceId, options);
  if (segments.length === 0) return [];
  // Single short source — return it as-is, no scoring needed
  if (segments.length <= MAX_PASSAGES) return segments;

  // Build query token set
  const queryText = [input.query, ...input.subQuestions].join(' ');
  const queryTokens = tokenize(queryText);

  // Score each segment
  const scored = segments.map((seg, i) => {
    const segTokens = tokenize(seg.text);
    let score = tokenOverlap(queryTokens, segTokens);

    // Heading boost: segments starting with markdown heading get +0.08
    if (HEADING_RE.test(seg.text.slice(0, 120))) {
      score += 0.08;
    }

    return { seg, score, idx: i };
  });

  // Sort by score descending, pick top by budget
  scored.sort((a, b) => b.score - a.score);

  const selected = new Set<number>();
  let totalChars = 0;

  // Reserve at least one slot for neighbor context
  const maxSeeds = Math.max(1, MAX_PASSAGES - 1);
  for (const s of scored) {
    if (selected.size >= maxSeeds) break;
    if (totalChars + s.seg.text.length > MAX_TOTAL_CHARS) continue;
    selected.add(s.idx);
    totalChars += s.seg.text.length;
  }

  // Add one neighbor (before or after) for each selected segment if budget allows
  const expanded = new Set(selected);
  for (const idx of selected) {
    if (expanded.size >= MAX_PASSAGES) break;
    const after = idx + 1;
    if (after < segments.length && !expanded.has(after)) {
      const candidate = segments[after];
      if (candidate !== undefined && totalChars + candidate.text.length <= MAX_TOTAL_CHARS) {
        expanded.add(after);
        totalChars += candidate.text.length;
      }
    }
    if (expanded.size >= MAX_PASSAGES) break;
    const before = idx - 1;
    if (before >= 0 && !expanded.has(before)) {
      const candidate = segments[before];
      if (candidate !== undefined && totalChars + candidate.text.length <= MAX_TOTAL_CHARS) {
        expanded.add(before);
        totalChars += candidate.text.length;
      }
    }
  }

  // Build result, sorted back into document order
  const result = [...expanded]
    .map((i) => segments[i])
    .filter((s): s is SourcePassage => s !== undefined)
    .sort((a, b) => a.startOffset - b.startOffset);

  return result;
}

// ── LLM reranking ──────────────────────────────────────────────────────────

/** Response from the LLM reranking call. */
const RerankResponseSchema = z.object({
  passages: z.array(z.object({
    id: z.string(),
    score: z.number(),
  })),
});

/** Minimum budget required before invoking the reranking LLM. */
const RERANK_MIN_TOOL_CALLS = 2;
const RERANK_MIN_TOKENS = 20_000;
const RERANK_MIN_TIME_MS = 30_000;

// Score blend: 70% LLM (normalized) + 30% lexical/heading score
const LLM_BLEND_WEIGHT = 0.7;
const LEXICAL_BLEND_WEIGHT = 0.3;

/** Maximum LLM scores to send for reranking. */
const RERANK_TOP_K = 12;

/**
 * Async passage selection with LLM reranking. When the source has MORE than
 * MAX_PASSAGES candidates, sends the deterministic top-12 bounded passages
 * to the LLM for relevance scoring, then blends the LLM scores (70%) with
 * the existing lexical/heading scores (30%) and applies the standard passage
 * count limit, character budget, neighbor expansion, and document-order
 * restoration.
 *
 * On budget-insufficient, LLM failure, abort, or invalid response: returns
 * the deterministic result unchanged (graceful fallback, always).
 */
export async function selectRelevantPassagesWithLLM(
  input: PassageSelectionInput,
  deps: {
    llm: Pick<LlmClient, 'callJSON'>;
    budget: BudgetTracker;
    signal?: AbortSignal;
  },
  options?: { windowSize?: number },
): Promise<SourcePassage[]> {
  const segments = segmentSourceContent(input.content, input.sourceId, options);
  if (segments.length === 0) return [];

  // Short source — skip to deterministic path (no scoring needed)
  if (segments.length <= MAX_PASSAGES) return segments;

  // Build query token set
  const queryText = [input.query, ...input.subQuestions].join(' ');
  const queryTokens = tokenize(queryText);

  // Score each segment (same logic as deterministic path)
  const scored = segments.map((seg, i) => {
    const segTokens = tokenize(seg.text);
    let score = tokenOverlap(queryTokens, segTokens);
    if (HEADING_RE.test(seg.text.slice(0, 120))) {
      score += 0.08;
    }
    return { seg, score, idx: i };
  });

  // Sort by score descending, pick top bounded by character budget
  scored.sort((a, b) => b.score - a.score);
  const selected = new Set<number>();
  let totalChars = 0;
  const maxSeeds = Math.max(1, MAX_PASSAGES - 1);
  for (const s of scored) {
    if (selected.size >= maxSeeds) break;
    if (totalChars + s.seg.text.length > MAX_TOTAL_CHARS) continue;
    selected.add(s.idx);
    totalChars += s.seg.text.length;
  }

  // Pre-flight budget check: require at least 2 tool calls, 20K tokens, 1 extraction, 30s
  const remaining = deps.budget.remaining();
  if (
    remaining.toolCalls < RERANK_MIN_TOOL_CALLS ||
    remaining.tokens < RERANK_MIN_TOKENS ||
    remaining.extractions < 1 ||
    remaining.timeMs < RERANK_MIN_TIME_MS
  ) {
    return buildDeterministicResult(segments, selected, totalChars);
  }

  // Reserve exactly one tool call for the reranking LLM invocation
  // (token accounting flows through LlmClient's existing recordTokens)
  if (!deps.budget.recordToolCall()) {
    return buildDeterministicResult(segments, selected, totalChars);
  }

  try {
    // Send top-12 bounded passages to LLM for reranking
    const rerankPassages = scored
      .slice(0, RERANK_TOP_K)
      .map((s) => ({ id: s.seg.id, text: s.seg.text }));

    const rerankPrompt = `You are a passage reranking system. Given a user query and sub-questions, score each passage by relevance.

Query: ${input.query}

Sub-questions:
${input.subQuestions.map((sq) => `- ${sq}`).join('\n')}

Passages:
${rerankPassages.map((p) => `[${p.id}]:\n${p.text}`).join('\n\n')}

Return strict JSON with passage IDs and relevance scores 1-10 (10 = most relevant):
{
  "passages": [
    {"id": "passage_...", "score": 8}
  ]
}`;

    const callResult = await deps.llm.callJSON<z.infer<typeof RerankResponseSchema>>({
      model: 'worker',
      messages: [{ role: 'user', content: rerankPrompt }],
      temperature: 0,
      maxTokens: 1024,
      responseFormat: 'json_object',
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });

    if (!callResult.success) {
      return buildDeterministicResult(segments, selected, totalChars);
    }

    // Validate response schema + business rules
    const validation = validateRerankResponse(callResult.data, new Set(rerankPassages.map((p) => p.id)));
    if (!validation.ok) {
      return buildDeterministicResult(segments, selected, totalChars);
    }

    const llmScores = validation.scores;

    // Blend scores: 70% LLM (normalized) + 30% lexical/heading score
    // LLM scores are 1-10, normalize to 0-1
    const blended = scored.map((s) => {
      const llmRaw = llmScores.get(s.seg.id);
      if (llmRaw !== undefined) {
        const llmNormalized = (llmRaw - 1) / 9;
        return { seg: s.seg, score: llmNormalized * LLM_BLEND_WEIGHT + s.score * LEXICAL_BLEND_WEIGHT, idx: s.idx };
      }
      return s;
    });

    blended.sort((a, b) => b.score - a.score || a.idx - b.idx);
    selected.clear();
    totalChars = 0;
    for (const s of blended) {
      if (selected.size >= maxSeeds) break;
      if (totalChars + s.seg.text.length > MAX_TOTAL_CHARS) continue;
      selected.add(s.idx);
      totalChars += s.seg.text.length;
    }
  } catch {
    // LLM unavailable or aborted — fall back to deterministic result
    return buildDeterministicResult(segments, selected, totalChars);
  }

  // Apply existing neighbor expansion and document-order restoration
  return buildDeterministicResult(segments, selected, totalChars);
}

/** Build the final result from seed indices: neighbor expansion + document order. */
function buildDeterministicResult(
  segments: SourcePassage[],
  selected: Set<number>,
  totalChars: number,
): SourcePassage[] {
  const expanded = new Set(selected);
  for (const idx of selected) {
    if (expanded.size >= MAX_PASSAGES) break;
    const after = idx + 1;
    if (after < segments.length && !expanded.has(after)) {
      const candidate = segments[after];
      if (candidate !== undefined && totalChars + candidate.text.length <= MAX_TOTAL_CHARS) {
        expanded.add(after);
        totalChars += candidate.text.length;
      }
    }
    if (expanded.size >= MAX_PASSAGES) break;
    const before = idx - 1;
    if (before >= 0 && !expanded.has(before)) {
      const candidate = segments[before];
      if (candidate !== undefined && totalChars + candidate.text.length <= MAX_TOTAL_CHARS) {
        expanded.add(before);
        totalChars += candidate.text.length;
      }
    }
  }
  return [...expanded]
    .map((i) => segments[i])
    .filter((s): s is SourcePassage => s !== undefined)
    .sort((a, b) => a.startOffset - b.startOffset);
}

/** Validate reranking response: unique IDs, subset of sent IDs, scores 1-10, within bounds. */
function validateRerankResponse(
  data: unknown,
  sentIds: Set<string>,
): { ok: false } | { ok: true; scores: Map<string, number> } {
  const parsed = RerankResponseSchema.safeParse(data);
  if (!parsed.success) return { ok: false };

  const { passages } = parsed.data;
  if (passages.length === 0 || passages.length > sentIds.size) return { ok: false };

  const scores = new Map<string, number>();
  for (const p of passages) {
    if (!sentIds.has(p.id)) return { ok: false };
    if (scores.has(p.id)) return { ok: false };
    if (!Number.isFinite(p.score) || p.score < 1 || p.score > 10) return { ok: false };
    scores.set(p.id, p.score);
  }
  return { ok: true, scores };
}
