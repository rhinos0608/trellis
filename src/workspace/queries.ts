/**
 * Read-only query functions operating on ProjectionState for the workspace
 * domain (families and threads). These are pure functions over the
 * materialized view — no side effects, no I/O.
 */

import type { ProjectionState } from '../store/projectionState.js';
import type { Family, Thread } from './types.js';
import { resolveFamily } from './familyResolver.js';

// ── Family queries ────────────────────────────────────────────────────────

/** Get a single family by ID. */
export function getFamilyById(
  state: ProjectionState,
  id: string,
): Family | undefined {
  return state.families.get(id);
}

/** List all families. */
export function listFamilies(state: ProjectionState): Family[] {
  return [...state.families.values()];
}

/**
 * Find a family whose manifest best matches the given query string.
 * Returns undefined if no family exists. Uses the same scoring as
 * resolveFamily but never creates a new family — threshold set to
 * Infinity so any "no match" result comes back as isNew.
 */
export function findFamilyByManifestMatch(
  state: ProjectionState,
  query: string,
  opts?: { matchThreshold?: number },
): Family | undefined {
  const families = listFamilies(state);
  if (families.length === 0) return undefined;

  const result = resolveFamily(query, families, {
    matchThreshold: opts?.matchThreshold ?? Infinity,
  });

  return result.isNew ? undefined : result.family;
}

// ── Thread queries ────────────────────────────────────────────────────────

/** Get all threads belonging to a family. */
export function getThreadsByFamily(
  state: ProjectionState,
  familyId: string,
): Thread[] {
  const threadIds = state.threadsByFamilyId.get(familyId);
  if (!threadIds) return [];

  const threads: Thread[] = [];
  for (const id of threadIds) {
    const thread = state.threads.get(id);
    if (thread) threads.push(thread);
  }
  return threads;
}
