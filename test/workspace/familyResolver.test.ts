import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { resolveFamily } from '../../src/workspace/familyResolver.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { initDb, closeDb, appendEvents, rebuildProjection } from '../../src/store/index.js';
import type { NewEventInput } from '../../src/store/events.js';
import type { Family, FamilyRelation } from '../../src/workspace/types.js';
import type { EventEnvelope } from '../../src/store/eventTypes.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  idCounter++;
  return {
    seq: idCounter,
    id: `evt-${idCounter}`,
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
    ...overrides,
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

  it('does not mutate lastActivity (projection handler owns it)', () => {
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

    expect(existing.lastActivity).toBe('2025-01-01T00:00:00.000Z');
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

  // ── Ambiguity guard ───────────────────────────────────────────────

  it('creates a new family when two candidates are near-tied and ambiguous', () => {
    // Two families with similar scope — both will score similarly for a generic query
    const famA = makeFamily({
      id: 'fam-a',
      label: 'Testing Strategies',
      manifest: {
        scopeQuery: 'testing strategies and best practices',
        tags: ['testing', 'strategies'],
      },
    });
    const famB = makeFamily({
      id: 'fam-b',
      label: 'Testing Patterns',
      manifest: {
        scopeQuery: 'testing patterns and approaches',
        tags: ['testing', 'patterns'],
      },
    });
    // Generic query overlaps heavily with both families
    const result = resolveFamily('testing strategies patterns', [famA, famB], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });
    // Near-tied scores should trigger ambiguity guard → create new
    expect(result.isNew).toBe(true);
    expect(result.family.id).not.toBe('fam-a');
    expect(result.family.id).not.toBe('fam-b');
  });

  it('reuses when one candidate is clearly ahead despite a close second', () => {
    const famClose = makeFamily({
      id: 'fam-close',
      label: 'Vitest Setup',
      manifest: {
        scopeQuery: 'vitest setup configuration',
        tags: ['vitest', 'setup'],
      },
    });
    const famDistant = makeFamily({
      id: 'fam-distant',
      label: 'JavaScript Web Development',
      manifest: {
        scopeQuery: 'javascript web development',
        tags: ['javascript', 'web'],
      },
    });
    const result = resolveFamily('vitest testing setup configuration', [famClose, famDistant], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });
    // vitest-setup scores much higher than javascript-web — clear winner
    expect(result.isNew).toBe(false);
    expect(result.family.id).toBe('fam-close');
  });

  it('reuses when best score exceeds confident threshold despite close second', () => {
    const famA = makeFamily({
      id: 'fam-a',
      label: 'Vitest Configuration Testing',
      manifest: {
        scopeQuery: 'vitest configuration and testing',
        scopeSummary: 'How to configure and use vitest for testing',
        tags: ['vitest', 'testing', 'config'],
      },
    });
    const famB = makeFamily({
      id: 'fam-b',
      label: 'Vitest Setup Configuration',
      manifest: {
        scopeQuery: 'vitest setup and configuration',
        scopeSummary: 'Setting up vitest configuration for projects',
        tags: ['vitest', 'setup', 'config'],
      },
    });
    const result = resolveFamily('vitest testing configuration setup', [famA, famB], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });
    // Best score should exceed 0.50 (confident), so reuse despite close second
    expect(result.isNew).toBe(false);
  });

  // ── Short query guard ───────────────────────────────────────────────

  it('creates new for a short generic query even if a single token overlaps', () => {
    const existing = makeFamily({
      id: 'fam-1',
      label: 'React Testing Patterns',
      manifest: {
        scopeQuery: 'react testing patterns',
        tags: ['react', 'testing', 'patterns'],
      },
    });
    // "testing" is 1 token — should need higher threshold to match
    const result = resolveFamily('testing', [existing], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });
    expect(result.isNew).toBe(true);
  });

  it('reuses when a short specific query has a strong match', () => {
    const existing = makeFamily({
      id: 'fam-1',
      label: 'Vitest',
      manifest: {
        scopeQuery: 'vitest',
        tags: ['vitest'],
      },
    });
    // "vitest" (1 token) vs a manifest that IS vitest — should match
    const result = resolveFamily('vitest', [existing], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });
    expect(result.isNew).toBe(false);
    expect(result.family.id).toBe('fam-1');
  });

  it('creates new for a 2-token generic query against a broad family', () => {
    const existing = makeFamily({
      id: 'fam-1',
      label: 'React Testing Patterns',
      manifest: {
        scopeQuery: 'react testing patterns',
        tags: ['react', 'testing', 'patterns'],
      },
    });
    // "web testing" is 2 tokens — generic, should not spuriously match
    const result = resolveFamily('web testing', [existing], {
      idGenerator: makeId,
      now: FIXED_TIME,
    });
    expect(result.isNew).toBe(true);
  });
});

// ── Projection rebuild regression test ───────────────────────────────────

describe('FAMILY_RESOLVED lastActivity survives projection rebuild', () => {
  let tmpDir: string;

  const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-resolved-rebuild-')); });
  afterEach(() => { closeDb(); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ } });

  it('rebuild from genesis preserves lastActivity set by FAMILY_RESOLVED', () => {
    initDb(path.join(tmpDir, 'test.db'));

    const now = '2025-07-01T12:00:00.000Z';
    const familyId = 'fam-resolved-test';
    const runId = 'run-resolved-1';

    const mk = (eventType: string, payload: Record<string, unknown>, overrides?: Partial<NewEventInput>): NewEventInput => ({
      timestamp: now, eventType, eventVersion: 1, runId,
      batchId: null, actor: 'system', entityId: null, entityType: null,
      payload, ...overrides,
    });

    // 1) Live projection: append FAMILY_CREATED then FAMILY_RESOLVED
    const liveProjection = rebuildProjection(ALL_HANDLERS);
    appendEvents([
      mk('FAMILY_CREATED', { family_id: familyId, label: 'Test Family' }, { entityType: 'family' }),
      mk('FAMILY_RESOLVED', { familyId, query: 'test query', isNew: false }, { runId }),
    ], { projection: liveProjection, handlers: ALL_HANDLERS });

    const liveFamily = liveProjection.families.get(familyId);
    expect(liveFamily).toBeDefined();
    const liveLastActivity = liveFamily!.lastActivity;
    // FAMILY_RESOLVED handler sets lastActivity to the event timestamp
    expect(liveLastActivity).toBe(now);

    // 2) Rebuild projection from genesis (simulates server restart)
    const rebuilt = rebuildProjection(ALL_HANDLERS, { forceGenesis: true });
    const rebuiltFamily = rebuilt.families.get(familyId);
    expect(rebuiltFamily).toBeDefined();

    // THIS is the assertion that catches the audit_only regression:
    // with audit_only, the FAMILY_RESOLVED handler is never called during
    // rebuild, so lastActivity would revert to the FAMILY_CREATED timestamp.
    // With pure_run_local, the handler IS called and lastActivity stays correct.
    expect(rebuiltFamily!.lastActivity).toBe(liveLastActivity);
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
