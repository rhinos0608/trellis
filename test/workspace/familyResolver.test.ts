import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { resolveFamily } from '../../src/workspace/familyResolver.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import type { Family, FamilyRelation } from '../../src/workspace/types.js';
import type { EventEnvelope } from '../../src/store/eventTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────

const FIXED_TIME = '2025-01-15T10:00:00.000Z';
let idCounter = 0;

function makeId(): string {
  return `test-id-${++idCounter}`;
}

function makeFamily(overrides: Partial<Family> & { id: string; label: string }): Family {
  return {
    description: undefined,
    manifest: { scopeQuery: overrides.label },
    createdAt: FIXED_TIME,
    lastActivity: FIXED_TIME,
    relatedFamilies: [],
    ...overrides,
  };
}

function makeEvent(
  eventType: string,
  payload: unknown,
  overrides?: Partial<EventEnvelope>,
): EventEnvelope {
  return {
    seq: overrides?.seq ?? ++idCounter,
    id: overrides?.id ?? `evt-${idCounter}`,
    timestamp: overrides?.timestamp ?? FIXED_TIME,
    eventType: eventType as EventEnvelope['eventType'],
    eventVersion: 1,
    runId: overrides?.runId ?? 'test-run',
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    payload,
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  };
}

// ── resolveFamily tests ───────────────────────────────────────────────────

describe('resolveFamily', () => {
  it('creates a new family when no families exist', () => {
    const result = resolveFamily('vitest configuration options', [], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.isNew).toBe(true);
    expect(result.family.id).toBe('test-id-1');
    expect(result.family.manifest.scopeQuery).toBe('vitest configuration options');
    expect(result.family.relatedFamilies).toEqual([]);
  });

  it('reuses an existing family with a strong manifest match', () => {
    const existing = makeFamily({
      id: 'fam-1',
      label: 'Vitest Testing',
      manifest: {
        scopeQuery: 'vitest configuration and testing',
        scopeSummary: 'How to configure and use vitest for testing',
        tags: ['vitest', 'testing', 'config'],
      },
    });

    const result = resolveFamily('vitest testing configuration', [existing], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.isNew).toBe(false);
    expect(result.family.id).toBe('fam-1');
  });

  it('creates a new family when no strong match exists', () => {
    const existing = makeFamily({
      id: 'fam-1',
      label: 'React Hooks',
      manifest: {
        scopeQuery: 'react hooks patterns',
        tags: ['react', 'hooks'],
      },
    });

    const result = resolveFamily('vitest configuration options', [existing], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.isNew).toBe(true);
    expect(result.family.id).not.toBe('fam-1');
  });

  it('picks the best matching family among multiple candidates', () => {
    const lowMatch = makeFamily({
      id: 'fam-low',
      label: 'General JavaScript',
      manifest: { scopeQuery: 'javascript web development' },
    });
    const highMatch = makeFamily({
      id: 'fam-high',
      label: 'Vitest Testing',
      manifest: {
        scopeQuery: 'vitest unit testing configuration',
        tags: ['vitest', 'testing'],
      },
    });

    const result = resolveFamily('vitest testing setup', [lowMatch, highMatch], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.isNew).toBe(false);
    expect(result.family.id).toBe('fam-high');
  });

  it('updates lastActivity on match', () => {
    const later = '2025-06-01T00:00:00.000Z';
    const existing = makeFamily({
      id: 'fam-1',
      label: 'Vitest Testing',
      manifest: { scopeQuery: 'vitest testing' },
      lastActivity: '2025-01-01T00:00:00.000Z',
    });

    resolveFamily('vitest testing', [existing], {
      idGenerator: makeId,
      now: later,
    });

    expect(existing.lastActivity).toBe(later);
  });

  it('returns score 0 when creating new family', () => {
    const result = resolveFamily('quantum computing basics', [], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.score).toBe(0);
    expect(result.isNew).toBe(true);
  });

  it('returns actual score when reusing existing family', () => {
    const existing = makeFamily({
      id: 'fam-1',
      label: 'Vitest Testing',
      manifest: {
        scopeQuery: 'vitest configuration and testing',
        scopeSummary: 'How to configure and use vitest for testing',
        tags: ['vitest', 'testing', 'config'],
      },
    });

    const result = resolveFamily('vitest testing configuration', [existing], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.isNew).toBe(false);
    expect(result.score).toBeGreaterThan(0);
    expect(typeof result.score).toBe('number');
  });

  it('returns candidates sorted descending by score', () => {
    const famLow = makeFamily({
      id: 'fam-low',
      label: 'General JavaScript',
      manifest: { scopeQuery: 'javascript web development' },
    });
    const famHigh = makeFamily({
      id: 'fam-high',
      label: 'Vitest Testing',
      manifest: {
        scopeQuery: 'vitest unit testing configuration',
        tags: ['vitest', 'testing'],
      },
    });

    // Force a reuse so candidates are populated above threshold
    const result = resolveFamily('vitest testing setup', [famLow, famHigh], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBe(2);
    expect(result.candidates![0].familyId).toBe('fam-high');
    expect(result.candidates![0].score).toBeGreaterThanOrEqual(result.candidates![1].score);
    expect(result.candidates![0].score).toBeGreaterThan(result.candidates![1].score);
  });

  it('returns candidates when no match creates new family', () => {
    const existing = makeFamily({
      id: 'fam-1',
      label: 'React Hooks',
      manifest: { scopeQuery: 'react hooks patterns', tags: ['react', 'hooks'] },
    });

    const result = resolveFamily('quantum computing basics', [existing], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.isNew).toBe(true);
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBe(1);
    expect(result.candidates![0].familyId).toBe('fam-1');
  });

  it('returns undefined candidates when no families exist', () => {
    const result = resolveFamily('anything', [], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });

    expect(result.candidates).toBeUndefined();
  });
});

// ── projection handler tests ──────────────────────────────────────────────

describe('workspace projection handlers', () => {
  describe('FAMILY_CREATED', () => {
    it('creates a family and entity memberships', () => {
      const state = createEmptyProjectionState();
      const handler = workspaceEventHandlers.FAMILY_CREATED!;

      handler(makeEvent('FAMILY_CREATED', {
        family_id: 'fam-1',
        label: 'Vitest Config',
        description: 'Testing framework configuration',
        entityIds: ['ent-1', 'ent-2'],
        runIds: ['run-1'],
      }), state);

      expect(state.families.size).toBe(1);
      const fam = state.families.get('fam-1');
      expect(fam).toBeDefined();
      expect(fam!.label).toBe('Vitest Config');
      expect(fam!.description).toBe('Testing framework configuration');
      expect(fam!.manifest.scopeQuery).toBe('Vitest Config');

      // Entity memberships
      expect(state.entityFamilyMemberships.length).toBe(2);
      expect(state.entityFamilyKeys.has('ent-1|fam-1')).toBe(true);
      expect(state.entityFamilyKeys.has('ent-2|fam-1')).toBe(true);
    });

    it('is idempotent', () => {
      const state = createEmptyProjectionState();
      const handler = workspaceEventHandlers.FAMILY_CREATED!;
      const event = makeEvent('FAMILY_CREATED', {
        family_id: 'fam-1',
        label: 'Vitest Config',
      });

      handler(event, state);
      handler(event, state);

      expect(state.families.size).toBe(1);
      expect(state.entityFamilyMemberships.length).toBe(0);
    });
  });

  describe('FAMILY_RELATED', () => {
    it('adds bidirectional relation between two families', () => {
      const state = createEmptyProjectionState();
      // Pre-create both families
      state.families.set('fam-a', makeFamily({ id: 'fam-a', label: 'Family A' }));
      state.families.set('fam-b', makeFamily({ id: 'fam-b', label: 'Family B' }));

      const handler = workspaceEventHandlers.FAMILY_RELATED!;
      handler(makeEvent('FAMILY_RELATED', {
        relation_id: 'rel-1',
        family_a: 'fam-a',
        family_b: 'fam-b',
        relation_type: 'adjacent',
        reason: 'Related topics',
      }), state);

      const famA = state.families.get('fam-a')!;
      const famB = state.families.get('fam-b')!;

      // fam-a should have relation to fam-b
      expect(famA.relatedFamilies.length).toBe(1);
      expect(famA.relatedFamilies[0].familyId).toBe('fam-b');
      expect(famA.relatedFamilies[0].relationType).toBe('adjacent');

      // fam-b should have reverse relation to fam-a
      expect(famB.relatedFamilies.length).toBe(1);
      expect(famB.relatedFamilies[0].familyId).toBe('fam-a');
      expect(famB.relatedFamilies[0].relationType).toBe('adjacent');
    });

    it('adds bidirectional parent/child with correct inverse', () => {
      const state = createEmptyProjectionState();
      state.families.set('fam-parent', makeFamily({ id: 'fam-parent', label: 'Parent' }));
      state.families.set('fam-child', makeFamily({ id: 'fam-child', label: 'Child' }));

      const handler = workspaceEventHandlers.FAMILY_RELATED!;
      handler(makeEvent('FAMILY_RELATED', {
        relation_id: 'rel-1',
        family_a: 'fam-parent',
        family_b: 'fam-child',
        relation_type: 'parent',
      }), state);

      const parent = state.families.get('fam-parent')!;
      const child = state.families.get('fam-child')!;

      expect(parent.relatedFamilies[0].relationType).toBe('parent');
      expect(child.relatedFamilies[0].relationType).toBe('child');
    });

    it('is idempotent for duplicate relations', () => {
      const state = createEmptyProjectionState();
      state.families.set('fam-a', makeFamily({ id: 'fam-a', label: 'A' }));
      state.families.set('fam-b', makeFamily({ id: 'fam-b', label: 'B' }));

      const handler = workspaceEventHandlers.FAMILY_RELATED!;
      const event = makeEvent('FAMILY_RELATED', {
        relation_id: 'rel-1',
        family_a: 'fam-a',
        family_b: 'fam-b',
        relation_type: 'adjacent',
      });

      handler(event, state);
      handler(event, state);

      expect(state.families.get('fam-a')!.relatedFamilies.length).toBe(1);
    });
  });

  describe('FAMILY_RELATION_REMOVED', () => {
    it('removes relation from both families', () => {
      const state = createEmptyProjectionState();
      const famA = makeFamily({ id: 'fam-a', label: 'A' });
      const famB = makeFamily({ id: 'fam-b', label: 'B' });
      famA.relatedFamilies.push({
        relationId: 'rel-1',
        familyId: 'fam-b',
        relationType: 'adjacent',
      });
      famB.relatedFamilies.push({
        relationId: 'rel-1',
        familyId: 'fam-a',
        relationType: 'adjacent',
      });
      state.families.set('fam-a', famA);
      state.families.set('fam-b', famB);

      const handler = workspaceEventHandlers.FAMILY_RELATION_REMOVED!;
      handler(makeEvent('FAMILY_RELATION_REMOVED', {
        family_a: 'fam-a',
        family_b: 'fam-b',
        reason: 'No longer related',
      }), state);

      expect(state.families.get('fam-a')!.relatedFamilies.length).toBe(0);
      expect(state.families.get('fam-b')!.relatedFamilies.length).toBe(0);
    });
  });

  describe('THREAD_CREATED', () => {
    it('creates a thread and updates reverse index', () => {
      const state = createEmptyProjectionState();
      const handler = workspaceEventHandlers.THREAD_CREATED!;

      handler(makeEvent('THREAD_CREATED', {
        threadId: 'thr-1',
        familyId: 'fam-1',
        label: 'Configuration',
        description: 'How to configure vitest',
      }), state);

      expect(state.threads.size).toBe(1);
      const thread = state.threads.get('thr-1')!;
      expect(thread.familyId).toBe('fam-1');
      expect(thread.label).toBe('Configuration');
      expect(thread.status).toBe('open');

      const familyThreads = state.threadsByFamilyId.get('fam-1');
      expect(familyThreads).toBeDefined();
      expect(familyThreads!.has('thr-1')).toBe(true);
    });
  });

  describe('THREAD_RESOLVED', () => {
    it('sets thread status to resolved', () => {
      const state = createEmptyProjectionState();
      state.threads.set('thr-1', {
        id: 'thr-1',
        familyId: 'fam-1',
        label: 'Test',
        createdAt: FIXED_TIME,
        status: 'open',
      });

      const handler = workspaceEventHandlers.THREAD_RESOLVED!;
      handler(makeEvent('THREAD_RESOLVED', {
        threadId: 'thr-1',
        familyId: 'fam-1',
      }), state);

      expect(state.threads.get('thr-1')!.status).toBe('resolved');
    });
  });

  describe('FAMILY_MERGED', () => {
    it('removes merged family, reattributes threads and memberships', () => {
      const state = createEmptyProjectionState();

      // Set up two families with threads and memberships
      state.families.set('fam-survivor', makeFamily({ id: 'fam-survivor', label: 'Survivor' }));
      state.families.set('fam-merged', makeFamily({ id: 'fam-merged', label: 'Merged' }));

      state.threads.set('thr-1', {
        id: 'thr-1', familyId: 'fam-merged', label: 'Thread 1',
        createdAt: FIXED_TIME, status: 'open',
      });
      state.threadsByFamilyId.set('fam-merged', new Set(['thr-1']));

      state.entityFamilyKeys.add('ent-1|fam-merged');
      state.entityFamilyMemberships.push({
        entityId: 'ent-1', familyId: 'fam-merged',
        confidence: null, isPrimary: false, runId: 'run-1',
      });

      const handler = workspaceEventHandlers.FAMILY_MERGED!;
      handler(makeEvent('FAMILY_MERGED', {
        survivorFamilyId: 'fam-survivor',
        mergedFamilyIds: ['fam-merged'],
        reattributedEntityIds: ['ent-1'],
      }), state);

      // Merged family removed
      expect(state.families.has('fam-merged')).toBe(false);
      expect(state.families.has('fam-survivor')).toBe(true);

      // Thread moved to survivor
      const thread = state.threads.get('thr-1')!;
      expect(thread.familyId).toBe('fam-survivor');
      expect(state.threadsByFamilyId.has('fam-merged')).toBe(false);
      expect(state.threadsByFamilyId.get('fam-survivor')!.has('thr-1')).toBe(true);

      // Entity membership reattributed
      expect(state.entityFamilyKeys.has('ent-1|fam-merged')).toBe(false);
      expect(state.entityFamilyKeys.has('ent-1|fam-survivor')).toBe(true);
      const membership = state.entityFamilyMemberships.find(
        (m) => m.entityId === 'ent-1',
      );
      expect(membership!.familyId).toBe('fam-survivor');

      // Merge history recorded
      expect(state.familyMergeHistory.has('fam-merged')).toBe(true);
      expect(state.familyMergeHistory.get('fam-merged')!.intoId).toBe('fam-survivor');
    });
  });
});
