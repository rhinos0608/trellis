/**
 * Thread resolution — given a Family and a research query or topic, decide
 * whether it belongs to an existing Thread or needs a new one.
 *
 * Threads are a Trellis-native concept with no prior art in search-mcp.
 * A Thread is a subdomain scoped to one Family (e.g. "testing strategies"
 * within the "Vitest" family). Resolution uses token overlap between the
 * query and existing thread labels/descriptions within the family.
 */

import { randomUUID } from 'node:crypto';
import type { Thread } from './types.js';

// ── Tokenization (mirrors familyResolver) ─────────────────────────────────

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

// ── Scoring ───────────────────────────────────────────────────────────────

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

/**
 * Score a query against a thread. Uses the thread's label (primary) and
 * description (secondary) — both carry signal about the subdomain.
 */
function threadScore(queryTokens: string[], thread: Thread): number {
  const labelTokens = tokenize(thread.label);
  const labelSim = tokenOverlap(queryTokens, labelTokens) * 0.7;

  let descSim = 0;
  if (thread.description) {
    const descTokens = tokenize(thread.description);
    descSim = tokenOverlap(queryTokens, descTokens) * 0.3;
  }

  return labelSim + descSim;
}

// ── Threshold ─────────────────────────────────────────────────────────────

const THREAD_MATCH_THRESHOLD = 0.3;

// ── Anti-false-merge guards (mirrors familyResolver) ─────────────────────

/**
 * Ambiguity guard: reject near-tied matches when neither score is
 * clearly confident. See familyResolver for full rationale.
 */
const AMBIGUITY_MIN_GAP = 0.10;
const AMBIGUITY_CONFIDENT_SCORE = 0.50;

/** Short-query threshold boost. */
const SHORT_QUERY_MIN_TOKENS = 2;
const SHORT_QUERY_THRESHOLD_BOOST = 0.15;

// ── Public API ────────────────────────────────────────────────────────────

export interface ThreadResolution {
  thread: Thread;
  isNew: boolean;
}

/**
 * Resolve which Thread within a Family owns an incoming research query.
 *
 * - If any open thread scores above the threshold, and the match is
 *   unambiguous, reuse it.
 * - Otherwise create a new Thread scoped to this family.
 *
 * Only considers threads with status 'open' — resolved/stale threads are
 * not reused.
 */
export function resolveThread(
  query: string,
  familyId: string,
  existingThreads: Thread[],
  opts?: { matchThreshold?: number; now?: string; idGenerator?: () => string },
): ThreadResolution {
  const threshold = opts?.matchThreshold ?? THREAD_MATCH_THRESHOLD;
  const now = opts?.now ?? new Date().toISOString();
  const generateId = opts?.idGenerator ?? (() => randomUUID());

  const queryTokens = tokenize(query);

  // Boost threshold for short queries — same rationale as familyResolver.
  const effectiveThreshold =
    queryTokens.length <= SHORT_QUERY_MIN_TOKENS
      ? threshold + SHORT_QUERY_THRESHOLD_BOOST
      : threshold;

  // Score all open threads and sort for ambiguity check
  const openThreads = existingThreads.filter(
    (t) => t.familyId === familyId && t.status === 'open',
  );

  const scored = openThreads.map((thread) => ({
    thread,
    score: threadScore(queryTokens, thread),
  }));
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best !== undefined && best.score >= effectiveThreshold) {
    // Ambiguity guard: same logic as familyResolver.
    const secondBest = scored[1];
    if (
      secondBest !== undefined &&
      best.score - secondBest.score < AMBIGUITY_MIN_GAP &&
      best.score < AMBIGUITY_CONFIDENT_SCORE
    ) {
      // Ambiguous — fall through to create-new thread.
    } else {
      return { thread: best.thread, isNew: false };
    }
  }

  // No strong match (or ambiguous) — create new thread
  const id = generateId();
  const label = deriveThreadLabel(query);
  const thread: Thread = {
    id,
    familyId,
    label,
    description: query,
    createdAt: now,
    status: 'open',
  };

  return { thread, isNew: true };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function deriveThreadLabel(query: string): string {
  const words = tokenize(query).slice(0, 6);
  if (words.length === 0) return 'Research Thread';
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
