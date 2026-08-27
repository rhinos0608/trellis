/**
 * Structure-aware, relevance-based passage selection for claim extraction.
 * Replaces naive first-16K-character truncation with scored window selection
 * so relevant content deep in long sources is not silently dropped.
 *
 * Reuses the same normalize/tokenize/tokenOverlap pattern as familyResolver.ts
 * for deterministic, dependency-free scoring.
 */

import type { SourcePassage } from './internalTypes.js';

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
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
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

  const windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
  const passages: SourcePassage[] = [];
  let offset = 0;
  let idx = 0;

  while (offset < content.length) {
    const rawEnd = Math.min(offset + windowSize, content.length);
    const end = rawEnd < content.length
      ? findBreakPoint(content, rawEnd, 800, offset)
      : rawEnd;

    passages.push({
      id: `passage_${sourceId}_${idx}`,
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

  for (const s of scored) {
    if (selected.size >= MAX_PASSAGES) break;
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
      const candidate = segments[after]!;
      if (totalChars + candidate.text.length <= MAX_TOTAL_CHARS) {
        expanded.add(after);
        totalChars += candidate.text.length;
      }
    }
    if (expanded.size >= MAX_PASSAGES) break;
    const before = idx - 1;
    if (before >= 0 && !expanded.has(before)) {
      const candidate = segments[before]!;
      if (totalChars + candidate.text.length <= MAX_TOTAL_CHARS) {
        expanded.add(before);
        totalChars += candidate.text.length;
      }
    }
  }

  // Build result, sorted back into document order
  const result = [...expanded]
    .map((i) => segments[i]!)
    .sort((a, b) => a.startOffset - b.startOffset);

  return result;
}
