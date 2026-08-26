import { describe, it, expect } from 'vitest';
import { resolveThread } from '../../src/workspace/threadResolver.js';
import type { Thread } from '../../src/workspace/types.js';

const FIXED_TIME = '2025-01-15T10:00:00.000Z';
let idCounter = 0;
function makeId(): string { return `test-id-${++idCounter}`; }

function makeThread(overrides: Partial<Thread> & { id: string; familyId: string; label: string }): Thread {
  return {
    createdAt: FIXED_TIME,
    status: 'open',
    ...overrides,
  };
}

describe('resolveThread', () => {
  it('creates a new thread when no threads exist', () => {
    const result = resolveThread('vitest configuration options', 'fam-1', [], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    expect(result.isNew).toBe(true);
    expect(result.thread.familyId).toBe('fam-1');
  });

  it('reuses an existing thread with a strong label match', () => {
    const existing = makeThread({
      id: 'thr-1', familyId: 'fam-1',
      label: 'TypeScript Configuration Testing',
      description: 'How to configure TypeScript for testing',
    });
    const result = resolveThread('TypeScript configuration testing strategies', 'fam-1', [existing], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    expect(result.isNew).toBe(false);
    expect(result.thread.id).toBe('thr-1');
  });

  it('creates a new thread when no open thread matches', () => {
    const existing = makeThread({
      id: 'thr-1', familyId: 'fam-1',
      label: 'React Hooks',
      description: 'React hooks patterns and anti-patterns',
    });
    const result = resolveThread('quantum computing basics', 'fam-1', [existing], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    expect(result.isNew).toBe(true);
    expect(result.thread.id).not.toBe('thr-1');
  });

  it('ignores threads from other families', () => {
    const otherFamily = makeThread({
      id: 'thr-other', familyId: 'fam-other',
      label: 'Vitest Configuration Testing',
    });
    const result = resolveThread('vitest testing configuration', 'fam-1', [otherFamily], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    expect(result.isNew).toBe(true);
  });

  it('ignores resolved threads', () => {
    const resolved = makeThread({
      id: 'thr-resolved', familyId: 'fam-1',
      label: 'Vitest Configuration Testing',
      status: 'resolved',
    });
    const result = resolveThread('vitest testing configuration', 'fam-1', [resolved], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    expect(result.isNew).toBe(true);
  });

  // ── Ambiguity guard ─────────────────────────────────────────────────

  it('creates a new thread when two candidates are near-tied and ambiguous', () => {
    // Two threads with similar scope — scores stay below confident threshold
    // so the ambiguity guard fires when they're near-tied
    const threadA = makeThread({
      id: 'thr-a', familyId: 'fam-1',
      label: 'Software Testing Strategies',
      description: 'General software testing strategies and practices',
    });
    const threadB = makeThread({
      id: 'thr-b', familyId: 'fam-1',
      label: 'Software Testing Patterns',
      description: 'General software testing patterns and approaches',
    });
    // "testing strategies patterns" overlaps with both at similar moderate levels
    const result = resolveThread('testing strategies patterns', 'fam-1', [threadA, threadB], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    // Near-tied scores below confident threshold → ambiguity guard → create new
    expect(result.isNew).toBe(true);
    expect(result.thread.id).not.toBe('thr-a');
    expect(result.thread.id).not.toBe('thr-b');
  });

  it('reuses when one candidate is clearly ahead despite a close second', () => {
    // One thread is a much stronger match
    const threadA = makeThread({
      id: 'thr-a', familyId: 'fam-1',
      label: 'TypeScript Configuration Testing',
      description: 'How to configure TypeScript for testing',
    });
    const threadB = makeThread({
      id: 'thr-b', familyId: 'fam-1',
      label: 'React State Management',
      description: 'Managing state in React applications',
    });
    const result = resolveThread('TypeScript configuration testing strategies', 'fam-1', [threadA, threadB], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    expect(result.isNew).toBe(false);
    expect(result.thread.id).toBe('thr-a');
  });

  it('reuses when best score exceeds confident threshold despite close second', () => {
    // Both score high but best is above the confident threshold
    const threadA = makeThread({
      id: 'thr-a', familyId: 'fam-1',
      label: 'TypeScript Testing Configuration',
      description: 'How to configure TypeScript for testing with detailed setup',
    });
    const threadB = makeThread({
      id: 'thr-b', familyId: 'fam-1',
      label: 'TypeScript Testing Setup',
      description: 'Setting up TypeScript for testing environments',
    });
    const result = resolveThread('TypeScript testing configuration setup', 'fam-1', [threadA, threadB], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    // Best should score >= 0.50 (confident), so even with a close second, reuse
    expect(result.isNew).toBe(false);
  });

  // ── Short query guard ───────────────────────────────────────────────

  it('creates new for a short generic query even if a single token overlaps', () => {
    // "testing" alone is 1 token — should need higher threshold
    const existing = makeThread({
      id: 'thr-1', familyId: 'fam-1',
      label: 'React Testing Patterns',
      description: 'Testing patterns for React applications',
    });
    const result = resolveThread('testing', 'fam-1', [existing], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    // A single generic token should not match with high confidence
    expect(result.isNew).toBe(true);
  });

  it('reuses when a short specific query has a strong match', () => {
    // "vitest" (1 token) against a vitest-specific thread
    const existing = makeThread({
      id: 'thr-1', familyId: 'fam-1',
      label: 'Vitest',
      description: 'Vitest testing framework',
    });
    const result = resolveThread('vitest', 'fam-1', [existing], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    // "vitest" vs label "vitest" desc "vitest testing" — should score high enough
    // Even with boosted threshold, a perfect label match should pass
    expect(result.isNew).toBe(false);
    expect(result.thread.id).toBe('thr-1');
  });

  it('creates new for a 2-token generic query against a broad thread', () => {
    const existing = makeThread({
      id: 'thr-1', familyId: 'fam-1',
      label: 'React Testing Patterns',
      description: 'Testing patterns for React applications with hooks',
    });
    const result = resolveThread('web testing', 'fam-1', [existing], {
      idGenerator: makeId, now: FIXED_TIME,
    });
    // "web testing" (2 tokens) — generic, should not spuriously match
    expect(result.isNew).toBe(true);
  });
});
