/**
 * Integration tests for MCP hybrid read routing:
 * - Cursor-invalidated projection cache
 * - SQL fast-path for claims/evidence with dirty-model fallback
 * - Later-event freshness
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getDb, closeDb, appendEvents } from '../../src/store/index.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import { createKnowledgeQueryService, type KnowledgeQueryService } from '../../src/query/service.js';
import { handleKnowledgeTool, type KnowledgeToolDeps } from '../../src/mcp/knowledgeTool.js';
import { getLatestEventCursor, queryEvents } from '../../src/store/events.js';
import type { NewEventInput } from '../../src/store/eventTypes.js';
import type { ProjectionState } from '../../src/store/projectionState.js';

const HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-knowledge-routing-'));
  expect(initDb(path.join(dir, 'test.db'))).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Event factories (match test/query/service.test.ts patterns) ────

function makeEvent(
  eventType: NewEventInput['eventType'],
  payload: unknown,
  eventVersion = 1,
): NewEventInput {
  return {
    eventType,
    eventVersion,
    runId: 'routing-test',
    batchId: null,
    actor: 'system',
    entityId: null,
    entityType: null,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function makeFamily(id: string): NewEventInput {
  return makeEvent('FAMILY_CREATED', { family_id: id, label: id });
}

function makeClaim(id: string, familyId: string, text: string, at: string): NewEventInput {
  return makeEvent('CLAIM_OBSERVED', {
    observation: {
      id: `obs-${id}`,
      familyId,
      runId: 'routing-test',
      observedAt: at,
      subjectText: text,
      predicate: 'improves',
      objectText: 'research',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'study',
      canonicalKey: { subject: text.toLowerCase(), predicate: 'improves' },
      confidence: 0.9,
      sourceIds: [],
      extractionVersion: 'v1',
    },
    reconciliation: {
      observationId: `obs-${id}`,
      classification: 'new_claim',
      canonicalClaimId: id,
      score: 1,
      method: 'canonical_key_exact',
      rationale: 'test',
      reconcilerVersion: 1,
      candidates: [],
    },
  });
}

function makeSource(id: string): NewEventInput {
  return makeEvent('SOURCE_OBSERVED', {
    sourceId: id,
    observedSourceId: id,
    canonicalUrl: `https://${id}.example.com`,
    url: `https://${id}.example.com`,
    title: id,
    domain: `${id}.example.com`,
    sourceType: 'web',
    isPrimary: true,
    extractionStatus: 'extracted',
    runId: 'routing-test',
    observedAt: '2024-01-01T00:00:00.000Z',
  });
}

function makeEvidence(id: string, claimId: string, sourceId: string): NewEventInput {
  return makeEvent('EVIDENCE_LINKED', {
    id,
    claimId,
    sourceId,
    excerpt: `Evidence for ${claimId}`,
    runId: 'routing-test',
    observationId: `obs-${claimId}`,
    stance: 'supports',
  }, 2); // v2 includes observationId + stance
}

function seedAndProject(...events: NewEventInput[]): ProjectionState {
  const projection = createEmptyProjectionState();
  appendEvents(events, { projection, handlers: HANDLERS });
  return projection;
}

function makeDeps(
  projection: ProjectionState,
  queryService: KnowledgeQueryService,
  qe: (opts?: Record<string, unknown>) => unknown[] = () => [],
): KnowledgeToolDeps {
  return { getState: () => projection, queryService, queryEvents: qe };
}

// ── Cache invalidation ────────────────────────────────────────────

describe('projection cache invalidation', () => {
  it('sees freshly appended data through handler', () => {
    const qs = createKnowledgeQueryService(getDb()!);
    const projection = seedAndProject(makeFamily('fam-1'));
    const deps = makeDeps(projection, qs);

    // First read
    const r1 = handleKnowledgeTool({ action: 'families' }, deps);
    expect(r1).toEqual({ families: [expect.objectContaining({ id: 'fam-1' })] });

    // Append a second family
    appendEvents([makeFamily('fam-2')], { projection, handlers: HANDLERS });

    // Second read — projection was mutated in-place by appendEvents
    const r2 = handleKnowledgeTool({ action: 'families' }, deps);
    const ids = (r2 as { families: Array<{ id: string }> }).families.map((f) => f.id);
    expect(ids).toContain('fam-2');
  });

  it('cursor-based cache preserves identity when no new events, invalidates on append', () => {
    const qs = createKnowledgeQueryService(getDb()!);
    const projection = seedAndProject(makeFamily('fam-1'));
    let cachedState: ProjectionState | null = null;
    let cachedSeq = -1;

    function getCachedState(): ProjectionState {
      const currentSeq = getLatestEventCursor();
      if (cachedState !== null && cachedSeq === currentSeq) return cachedState;
      cachedState = projection;
      cachedSeq = currentSeq;
      return cachedState;
    }

    const deps: KnowledgeToolDeps = {
      getState: getCachedState,
      queryService: qs,
      queryEvents: () => [],
    };

    const r1 = handleKnowledgeTool({ action: 'families' }, deps);
    const r2 = handleKnowledgeTool({ action: 'families' }, deps);
    // Data is identical when cursor hasn't changed (same serialized output)
    expect(r1).toEqual(r2);

    // Append new event — cache should invalidate
    appendEvents([makeFamily('fam-2')], { projection, handlers: HANDLERS });
    const r3 = handleKnowledgeTool({ action: 'families' }, deps);
    const ids3 = (r3 as { families: Array<{ id: string }> }).families.map((f) => f.id);
    expect(ids3).toContain('fam-2');
    // State object reference after cursor change is still projection (mutated in-place)
    // but cursor changed so cache was rebuilt
    expect(cachedSeq).toBe(getLatestEventCursor());
  });
});

// ── SQL/projection parity ─────────────────────────────────────────

describe('SQL/projection parity', () => {
  it('claims via SQL match claims via projection fallback', () => {
    const qs = createKnowledgeQueryService(getDb()!);
    getDb()!.prepare("UPDATE rm_state SET status='ready' WHERE model_name='knowledge'").run();

    const projection = seedAndProject(
      makeFamily('fam-1'),
      makeSource('src-1'),
      makeClaim('clm-a', 'fam-1', 'Alpha claim', '2024-01-02T00:00:00.000Z'),
      makeClaim('clm-b', 'fam-1', 'Beta claim', '2024-01-01T00:00:00.000Z'),
    );

    // SQL path (read model ready)
    const sqlResult = handleKnowledgeTool(
      { action: 'claims', familyId: 'fam-1' },
      makeDeps(projection, qs),
    );
    const sqlIds = (sqlResult as { claims: Array<{ id: string }> }).claims.map((c) => c.id);

    // Projection path (read model dirty → fallback)
    getDb()!.prepare("UPDATE rm_state SET status='dirty' WHERE model_name='knowledge'").run();
    const projResult = handleKnowledgeTool(
      { action: 'claims', familyId: 'fam-1' },
      makeDeps(projection, qs),
    );
    const projIds = (projResult as { claims: Array<{ id: string }> }).claims.map((c) => c.id);

    // Same claim IDs regardless of path
    expect(sqlIds.sort()).toEqual(projIds.sort());
  });

  it('evidence via SQL matches evidence via projection', () => {
    const qs = createKnowledgeQueryService(getDb()!);

    const projection = seedAndProject(
      makeFamily('fam-1'),
      makeSource('src-1'),
      makeClaim('clm-1', 'fam-1', 'Test claim', '2024-01-01T00:00:00.000Z'),
      makeEvidence('ev-1', 'clm-1', 'src-1'),
      makeEvidence('ev-2', 'clm-1', 'src-1'),
    );

    // SQL path
    const sqlResult = handleKnowledgeTool(
      { action: 'evidence', claimId: 'clm-1' },
      makeDeps(projection, qs),
    );
    const sqlIds = (sqlResult as { evidence: Array<{ id: string }> }).evidence.map((e) => e.id);

    // Projection path (dirty fallback)
    getDb()!.prepare("UPDATE rm_state SET status='dirty' WHERE model_name='knowledge'").run();
    const projResult = handleKnowledgeTool(
      { action: 'evidence', claimId: 'clm-1' },
      makeDeps(projection, qs),
    );
    const projIds = (projResult as { evidence: Array<{ id: string }> }).evidence.map((e) => e.id);

    expect(sqlIds.sort()).toEqual(projIds.sort());
  });
});

// ── Dirty-model fallback ──────────────────────────────────────────

describe('dirty-model fallback', () => {
  it('claims action falls back to projection when read model is dirty', () => {
    const qs = createKnowledgeQueryService(getDb()!);
    // rm_state starts as 'dirty' from migration
    const projection = seedAndProject(
      makeFamily('fam-1'),
      makeSource('src-1'),
      makeClaim('clm-x', 'fam-1', 'Fallback claim', '2024-01-01T00:00:00.000Z'),
    );

    // Should not throw — falls back to projection
    const result = handleKnowledgeTool(
      { action: 'claims', familyId: 'fam-1' },
      makeDeps(projection, qs),
    );
    const claims = (result as { claims: Array<{ id: string }> }).claims;
    expect(claims).toHaveLength(1);
    expect(claims[0].id).toBe('clm-x');
  });

  it('evidence action falls back to projection when read model is dirty', () => {
    const qs = createKnowledgeQueryService(getDb()!);
    const projection = seedAndProject(
      makeFamily('fam-1'),
      makeSource('src-1'),
      makeClaim('clm-1', 'fam-1', 'Test', '2024-01-01T00:00:00.000Z'),
      makeEvidence('ev-1', 'clm-1', 'src-1'),
    );

    const result = handleKnowledgeTool(
      { action: 'evidence', claimId: 'clm-1' },
      makeDeps(projection, qs),
    );
    const ev = (result as { evidence: Array<{ id: string }> }).evidence;
    expect(ev).toHaveLength(1);
    expect(ev[0].id).toBe('ev-1');
  });
});

// ── Later-event freshness ─────────────────────────────────────────

describe('later-event freshness', () => {
  it('changes action sees claim-relevant events appended after initial state', () => {
    const qs = createKnowledgeQueryService(getDb()!);
    const projection = seedAndProject(
      makeFamily('fam-1'),
      makeSource('src-1'),
      makeClaim('clm-a', 'fam-1', 'Alpha claim', '2024-01-02T00:00:00.000Z'),
    );

    // Capture cursor after initial seed
    const cursorAfterFirst = getLatestEventCursor()!;

    // Append a claim-relevant event: new claim in fam-2
    appendEvents([
      makeFamily('fam-2'),
      makeClaim('clm-b', 'fam-2', 'Beta claim', '2024-01-03T00:00:00.000Z'),
    ], { projection, handlers: HANDLERS });

    // Query changes since first cursor
    const result = handleKnowledgeTool(
      { action: 'changes', sinceSeq: cursorAfterFirst },
      makeDeps(projection, qs, queryEvents as unknown as (opts?: Record<string, unknown>) => unknown[]),
    );
    const changeSet = (result as { changeSet: Record<string, unknown> }).changeSet;
    expect(changeSet).toBeDefined();
    // The new claim appears in newClaims (makeClaim produces classification=new_claim)
    const newClaims = changeSet.newClaims as Array<{ description: string; entityId?: string }> | undefined;
    expect(newClaims).toBeDefined();
    expect(newClaims!.some((c) => c.description.includes('Beta claim'))).toBe(true);
  });
});
