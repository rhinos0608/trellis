import { describe, expect, it } from 'vitest';
import type { Contradiction, Gap } from '../../src/graph/types.js';
import { selectFollowUpTarget } from '../../src/research/followUpPlanner.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';

function gap(id: string, priority: number, overrides: Partial<Gap> = {}): Gap {
  return { id, familyId: 'family', question: ` question ${id} `, category: 'thin_coverage', status: 'open', priority, firstSeenRunId: 'run', ...overrides };
}
function contradiction(id: string, overrides: Partial<Contradiction> = {}): Contradiction {
  return { id, familyId: 'family', claimIdA: 'a', claimIdB: 'b', contradictionType: 'factual_disagreement', resolutionStatus: 'unresolved', followUpSearchRecommended: ` search ${id} `, firstSeenRunId: 'run', ...overrides };
}
function state(gaps: Gap[] = [], contradictions: Contradiction[] = []) {
  const result = createEmptyProjectionState();
  for (const item of gaps) result.gaps.set(item.id, item);
  for (const item of contradictions) result.contradictions.set(item.id, item);
  return result;
}

describe('selectFollowUpTarget', () => {
  it('selects highest urgency gap by priority', () => {
    expect(selectFollowUpTarget('family', state([gap('g3', 3), gap('g1', 1)]), new Set())?.id).toBe('g1');
  });
  it('uses deterministic id ordering for equal-priority gaps', () => {
    const result = state([gap('g-b', 1), gap('g-a', 1)]);
    expect(selectFollowUpTarget('family', result, new Set())?.id).toBe('g-a');
    expect(selectFollowUpTarget('family', result, new Set())?.id).toBe('g-a');
  });
  it('uses effective contradiction priority 2', () => {
    expect(selectFollowUpTarget('family', state([gap('g3', 3)], [contradiction('c')]), new Set())?.id).toBe('c');
    expect(selectFollowUpTarget('family', state([gap('g1', 1)], [contradiction('c')]), new Set())?.id).toBe('g1');
  });
  it('excludes tried targets', () => {
    expect(selectFollowUpTarget('family', state([gap('g', 1)]), new Set(['g']))).toBeUndefined();
  });
  it('accepts open and partially resolved gaps only', () => {
    expect(selectFollowUpTarget('family', state([gap('resolved', 1, { status: 'resolved' }), gap('partial', 2, { status: 'partially_resolved' })]), new Set())?.id).toBe('partial');
  });
  it('excludes empty contradiction recommendations', () => {
    expect(selectFollowUpTarget('family', state([], [contradiction('none', { followUpSearchRecommended: undefined }), contradiction('empty', { followUpSearchRecommended: '  ' })]), new Set())).toBeUndefined();
  });
  it('isolates family targets', () => {
    expect(selectFollowUpTarget('family', state([gap('other', 1, { familyId: 'other' })], [contradiction('other-c', { familyId: 'other' })]), new Set())).toBeUndefined();
  });
  it('returns undefined when no work exists', () => {
    expect(selectFollowUpTarget('family', state(), new Set())).toBeUndefined();
  });
});
