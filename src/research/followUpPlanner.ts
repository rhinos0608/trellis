import type { ProjectionState } from '../store/projectionState.js';

export interface FollowUpTarget {
  type: 'gap' | 'contradiction';
  id: string;
  query: string;
  threadId?: string;
  priority: number;
}

export interface RunFollowUp {
  kind: 'information_gain_v1';
  targetType: 'gap' | 'contradiction';
  targetId: string;
  sourceRunId: string;
}

export function selectFollowUpTarget(
  familyId: string,
  state: ProjectionState,
  triedTargetIds: ReadonlySet<string>,
): FollowUpTarget | undefined {
  const targets: FollowUpTarget[] = [];

  for (const gap of state.gaps.values()) {
    if (
      gap.familyId === familyId &&
      (gap.status === 'open' || gap.status === 'partially_resolved') &&
      gap.question.trim() !== '' &&
      !triedTargetIds.has(gap.id)
    ) {
      targets.push({
        type: 'gap',
        id: gap.id,
        query: gap.question.trim(),
        ...(gap.threadId ? { threadId: gap.threadId } : {}),
        priority: gap.priority,
      });
    }
  }

  for (const contradiction of state.contradictions.values()) {
    const query = contradiction.followUpSearchRecommended?.trim();
    if (
      contradiction.familyId === familyId &&
      contradiction.resolutionStatus === 'unresolved' &&
      query &&
      !triedTargetIds.has(contradiction.id)
    ) {
      targets.push({
        type: 'contradiction',
        id: contradiction.id,
        query,
        priority: 2,
      });
    }
  }

  targets.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return targets[0];
}
