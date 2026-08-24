/**
 * Workspace projection handlers — one EventHandler per workspace event type.
 * Mutate state.families, state.threads, and state.entityFamilyMemberships
 * in response to a single EventEnvelope, matching the signature from
 * store/projectionState.ts.
 *
 * Wired into store/'s central EventHandlerRegistry at startup (Worker 2).
 */

import type {
  EventEnvelope,
  TrellisEventType,
} from '../store/eventTypes.js';
import type {
  ProjectionState,
  EventHandler,
  EntityFamilyMembership,
} from '../store/projectionState.js';
import type { FamilyRelation, FamilyRelationType } from './types.js';

// ── Payload shapes (per event type) ───────────────────────────────────────
// Defined here rather than in eventTypes.ts (Worker 2's file) to avoid
// cross-worker contract violations.

interface FamilyCreatedPayload {
  family_id: string;
  label: string;
  description?: string;
  entityIds?: string[];
  runIds?: string[];
  createdAt?: string;
}

interface FamilyResolvedPayload {
  familyId: string;
  query: string;
  isNew: boolean;
}

interface FamilyClassifiedPayload {
  entity_id: string;
  family_id: string;
  confidence?: number | null;
  isPrimary?: boolean;
}

interface FamilyRelatedPayload {
  relation_id: string;
  family_a: string;
  family_b: string;
  relation_type: string;
  reason?: string;
}

interface FamilyRelationRemovedPayload {
  relation_id?: string;
  family_a: string;
  family_b: string;
  reason?: string;
}

interface FamilyRenamedPayload {
  targetId: string;
  oldLabel: string;
  newLabel: string;
}

interface FamilyMergedPayload {
  survivorFamilyId: string;
  mergedFamilyIds: string[];
  mergedSnapshots?: { id: string; label: string; description?: string }[];
  reattributedEntityIds?: string[];
}

interface ThreadCreatedPayload {
  threadId: string;
  familyId: string;
  label: string;
  description?: string;
}

interface ThreadResolvedPayload {
  threadId: string;
  familyId: string;
  resolution?: string;
}

// ── Handlers ──────────────────────────────────────────────────────────────

function handleFamilyCreated(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as FamilyCreatedPayload;
  if (state.families.has(p.family_id)) return; // idempotent

  const now = event.timestamp;
  const manifest: { scopeQuery: string; scopeSummary?: string; tags?: string[] } = {
    scopeQuery: p.label,
  };
  if (p.description !== undefined) {
    manifest.scopeSummary = p.description;
  }

  const family: import('./types.js').Family = {
    id: p.family_id,
    label: p.label,
    manifest,
    createdAt: p.createdAt ?? now,
    lastActivity: now,
    relatedFamilies: [],
  };
  if (p.description !== undefined) {
    family.description = p.description;
  }
  state.families.set(p.family_id, family);

  // Create entity-family memberships if entityIds provided
  if (p.entityIds && p.entityIds.length > 0) {
    const runId = event.runId;
    for (const entityId of p.entityIds) {
      const key = `${entityId}|${p.family_id}`;
      if (!state.entityFamilyKeys.has(key)) {
        state.entityFamilyKeys.add(key);
        const membership: EntityFamilyMembership = {
          entityId,
          familyId: p.family_id,
          confidence: null,
          isPrimary: false,
          runId,
        };
        state.entityFamilyMemberships.push(membership);
      }
    }
  }
}

function handleFamilyResolved(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as FamilyResolvedPayload;
  const family = state.families.get(p.familyId);
  if (family) {
    family.lastActivity = event.timestamp;
  }
}

function handleFamilyClassified(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as FamilyClassifiedPayload;
  const key = `${p.entity_id}|${p.family_id}`;
  if (state.entityFamilyKeys.has(key)) return; // idempotent

  state.entityFamilyKeys.add(key);
  const membership: EntityFamilyMembership = {
    entityId: p.entity_id,
    familyId: p.family_id,
    confidence: p.confidence ?? null,
    isPrimary: p.isPrimary ?? false,
    runId: event.runId,
  };
  state.entityFamilyMemberships.push(membership);
}

function handleFamilyRelated(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as FamilyRelatedPayload;
  const family = state.families.get(p.family_a);
  if (!family) return;

  // Check if relation already exists (idempotent)
  const existing = family.relatedFamilies.find(
    (r) => r.familyId === p.family_b && r.relationType === p.relation_type,
  );
  if (existing) return;

  const relation: FamilyRelation = {
    relationId: p.relation_id,
    familyId: p.family_b,
    relationType: p.relation_type as FamilyRelationType,
  };
  if (p.reason !== undefined) {
    relation.reason = p.reason;
  }
  family.relatedFamilies.push(relation);

  // Bidirectional: also add reverse relation on family_b
  const familyB = state.families.get(p.family_b);
  if (familyB) {
    const reverseType = reverseRelationType(p.relation_type);
    if (reverseType) {
      const reverseExisting = familyB.relatedFamilies.find(
        (r) => r.familyId === p.family_a && r.relationType === reverseType,
      );
      if (!reverseExisting) {
        const reverseRelation: FamilyRelation = {
          relationId: p.relation_id,
          familyId: p.family_a,
          relationType: reverseType,
        };
        if (p.reason !== undefined) {
          reverseRelation.reason = p.reason;
        }
        familyB.relatedFamilies.push(reverseRelation);
      }
    }
  }
}

function handleFamilyRelationRemoved(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as FamilyRelationRemovedPayload;

  const familyA = state.families.get(p.family_a);
  if (familyA) {
    familyA.relatedFamilies = familyA.relatedFamilies.filter(
      (r) => r.familyId !== p.family_b,
    );
  }

  const familyB = state.families.get(p.family_b);
  if (familyB) {
    familyB.relatedFamilies = familyB.relatedFamilies.filter(
      (r) => r.familyId !== p.family_a,
    );
  }
}

function handleFamilyRenamed(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as FamilyRenamedPayload;
  const family = state.families.get(p.targetId);
  if (!family) return;
  family.label = p.newLabel;
  family.lastActivity = event.timestamp;
}

function handleFamilyMerged(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as FamilyMergedPayload;
  const survivor = state.families.get(p.survivorFamilyId);
  if (!survivor) return;

  for (const mergedId of p.mergedFamilyIds) {
    const merged = state.families.get(mergedId);
    state.familyMergeHistory.set(mergedId, {
      fromId: mergedId,
      intoId: p.survivorFamilyId,
      fromLabel: merged?.label ?? mergedId,
      mergedEventId: event.id,
    });
    state.families.delete(mergedId);

    // Move threads from merged family to survivor
    const threads = state.threadsByFamilyId.get(mergedId);
    if (threads) {
      let survivorThreads = state.threadsByFamilyId.get(p.survivorFamilyId);
      if (!survivorThreads) {
        survivorThreads = new Set();
        state.threadsByFamilyId.set(p.survivorFamilyId, survivorThreads);
      }
      for (const threadId of threads) {
        survivorThreads.add(threadId);
        const thread = state.threads.get(threadId);
        if (thread) {
          thread.familyId = p.survivorFamilyId;
        }
      }
      state.threadsByFamilyId.delete(mergedId);
    }

    // Reattribute entity memberships
    if (p.reattributedEntityIds) {
      for (const entityId of p.reattributedEntityIds) {
        const oldKey = `${entityId}|${mergedId}`;
        const newKey = `${entityId}|${p.survivorFamilyId}`;
        if (state.entityFamilyKeys.has(oldKey) && !state.entityFamilyKeys.has(newKey)) {
          state.entityFamilyKeys.delete(oldKey);
          state.entityFamilyKeys.add(newKey);
          for (const m of state.entityFamilyMemberships) {
            if (m.entityId === entityId && m.familyId === mergedId) {
              m.familyId = p.survivorFamilyId;
            }
          }
        }
      }
    }
  }

  survivor.lastActivity = event.timestamp;
}

function handleThreadCreated(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as ThreadCreatedPayload;
  if (state.threads.has(p.threadId)) return; // idempotent

  const thread: import('./types.js').Thread = {
    id: p.threadId,
    familyId: p.familyId,
    label: p.label,
    createdAt: event.timestamp,
    status: 'open',
  };
  if (p.description !== undefined) {
    thread.description = p.description;
  }
  state.threads.set(p.threadId, thread);

  let familyThreads = state.threadsByFamilyId.get(p.familyId);
  if (!familyThreads) {
    familyThreads = new Set();
    state.threadsByFamilyId.set(p.familyId, familyThreads);
  }
  familyThreads.add(p.threadId);
}

function handleThreadResolved(event: EventEnvelope, state: ProjectionState): void {
  const p = event.payload as ThreadResolvedPayload;
  const thread = state.threads.get(p.threadId);
  if (!thread) return;
  thread.status = 'resolved';
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Map a relation type to its bidirectional inverse.
 * Symmetric types map to themselves; asymmetric types swap.
 */
function reverseRelationType(type: string): FamilyRelationType | null {
  switch (type) {
    case 'adjacent': return 'adjacent';
    case 'contradicts': return 'contradicts';
    case 'parent': return 'child';
    case 'child': return 'parent';
    case 'supersedes': return null; // asymmetric — no reverse
    default: return null;
  }
}

// ── Registry export ───────────────────────────────────────────────────────

/** Workspace domain handlers, ready to merge into the central registry. */
export const workspaceEventHandlers: Partial<Record<TrellisEventType, EventHandler>> = {
  FAMILY_CREATED: handleFamilyCreated,
  FAMILY_RESOLVED: handleFamilyResolved,
  FAMILY_CLASSIFIED: handleFamilyClassified,
  FAMILY_RELATED: handleFamilyRelated,
  FAMILY_RELATION_REMOVED: handleFamilyRelationRemoved,
  FAMILY_RENAMED: handleFamilyRenamed,
  FAMILY_MERGED: handleFamilyMerged,
  THREAD_CREATED: handleThreadCreated,
  THREAD_RESOLVED: handleThreadResolved,
};
