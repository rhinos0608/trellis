/**
 * Unit tests for the MCP tool handlers (research + knowledge).
 * Tests handler dispatch and result shapes directly — no full MCP round-trip.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ResearchToolSchema, KnowledgeToolSchema } from '../../src/mcp/schemas.js';
import { handleResearchTool, type ResearchToolDeps } from '../../src/mcp/researchTool.js';
import { handleKnowledgeTool, type KnowledgeToolDeps } from '../../src/mcp/knowledgeTool.js';
import { createRunService, type RunService, type RunStatus } from '../../src/research/runService.js';
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';
import type { ProjectionState } from '../../src/store/projectionState.js';
import { initDb, getDb, appendEvents, closeDb } from '../../src/store/index.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import { createKnowledgeQueryService, type KnowledgeQueryService } from '../../src/query/service.js';

// ── Helpers ────────────────────────────────────────────────────────

const TEST_DB = ':memory:';

function makeConfig(): TrellisConfig {
  return {
    storage: { dbPath: TEST_DB },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'node', args: [] },
    logLevel: 'silent',
  };
}

function makeMockProvider(): ResearchProvider {
  return {
    name: 'test-provider',
    capabilities: {
      search: true, read: true, academic: true, code: true,
      community: { reddit: false, hackernews: false, stackoverflow: false },
      media: false, reference: false, browser: false,
    },
    search: async () => [],
    read: async () => ({ url: '', content: '', contentHash: '' }),
    crawl: async () => [],
    academic: async () => [],
  };
}

function makeEmptyProjectionState(): ProjectionState {
  return createEmptyProjectionState();
}

// ── Schema validation ──────────────────────────────────────────────

describe('ResearchToolSchema', () => {
  it('validates start action', () => {
    const result = ResearchToolSchema.parse({ action: 'start', query: 'test query' });
    expect(result).toMatchObject({ action: 'start', query: 'test query' });
  });

  it('validates start with optional fields', () => {
    const result = ResearchToolSchema.parse({
      action: 'start',
      query: 'test',
      strategy: 'agent',
      depth: 'deep',
      familyId: 'fam_1',
      sessionId: 'sess_1',
    });
    expect(result).toMatchObject({
      action: 'start',
      strategy: 'agent',
      depth: 'deep',
      familyId: 'fam_1',
      sessionId: 'sess_1',
    });
  });

  it('rejects invalid strategy', () => {
    expect(() =>
      ResearchToolSchema.parse({ action: 'start', query: 'x', strategy: 'invalid' }),
    ).toThrow();
  });

  it('validates status action', () => {
    const result = ResearchToolSchema.parse({ action: 'status', runId: 'run_1' });
    expect(result).toEqual({ action: 'status', runId: 'run_1' });
  });

  it('validates cancel action', () => {
    const result = ResearchToolSchema.parse({ action: 'cancel', runId: 'run_1' });
    expect(result).toEqual({ action: 'cancel', runId: 'run_1' });
  });

  it('validates rollback action', () => {
    const result = ResearchToolSchema.parse({ action: 'rollback', runId: 'run_1' });
    expect(result).toEqual({ action: 'rollback', runId: 'run_1' });
  });

  it('rejects unknown action', () => {
    expect(() => ResearchToolSchema.parse({ action: 'bogus' })).toThrow();
  });
});

describe('KnowledgeToolSchema', () => {
  it('validates families (no filter)', () => {
    const result = KnowledgeToolSchema.parse({ action: 'families' });
    expect(result).toEqual({ action: 'families' });
  });

  it('validates families (with id)', () => {
    const result = KnowledgeToolSchema.parse({ action: 'families', familyId: 'f1' });
    expect(result).toEqual({ action: 'families', familyId: 'f1' });
  });

  it('validates threads', () => {
    const result = KnowledgeToolSchema.parse({ action: 'threads', familyId: 'f1' });
    expect(result).toEqual({ action: 'threads', familyId: 'f1' });
  });

  it('validates claims', () => {
    const result = KnowledgeToolSchema.parse({ action: 'claims', familyId: 'f1' });
    expect(result).toEqual({ action: 'claims', familyId: 'f1' });
  });

  it('validates claims with threadId', () => {
    const result = KnowledgeToolSchema.parse({ action: 'claims', familyId: 'f1', threadId: 't1' });
    expect(result).toEqual({ action: 'claims', familyId: 'f1', threadId: 't1' });
  });

  it('validates evidence', () => {
    const result = KnowledgeToolSchema.parse({ action: 'evidence', claimId: 'clm_1' });
    expect(result).toEqual({ action: 'evidence', claimId: 'clm_1' });
  });

  it('validates contradictions', () => {
    const result = KnowledgeToolSchema.parse({ action: 'contradictions', familyId: 'f1' });
    expect(result).toEqual({ action: 'contradictions', familyId: 'f1' });
  });

  it('validates gaps', () => {
    const result = KnowledgeToolSchema.parse({ action: 'gaps', familyId: 'f1' });
    expect(result).toEqual({ action: 'gaps', familyId: 'f1' });
  });

  it('validates entity by id', () => {
    const result = KnowledgeToolSchema.parse({ action: 'entity', entityId: 'e1' });
    expect(result).toEqual({ action: 'entity', entityId: 'e1' });
  });

  it('validates entity by label', () => {
    const result = KnowledgeToolSchema.parse({ action: 'entity', label: 'TypeScript' });
    expect(result).toEqual({ action: 'entity', label: 'TypeScript' });
  });

  it('rejects unknown action', () => {
    expect(() => KnowledgeToolSchema.parse({ action: 'mystery' })).toThrow();
  });
});

// ── Research tool handler ──────────────────────────────────────────

describe('handleResearchTool', () => {
  let runService: RunService;

  beforeEach(() => {
    initDb(TEST_DB);
    runService = createRunService();
  });

  it('status returns found:false for nonexistent run', async () => {
    const deps: ResearchToolDeps = {
      runService,
      config: makeConfig(),
      getProvider: async () => makeMockProvider(),
    };
    const result = await handleResearchTool(
      { action: 'status', runId: 'run_nonexistent' },
      deps,
    );
    expect(result).toEqual({ found: false, error: 'Run not found: run_nonexistent' });
  });

  it('cancel returns false for nonexistent run', async () => {
    const deps: ResearchToolDeps = {
      runService,
      config: makeConfig(),
      getProvider: async () => makeMockProvider(),
    };
    const result = await handleResearchTool(
      { action: 'cancel', runId: 'run_nonexistent' },
      deps,
    );
    expect(result).toEqual({ cancelled: false });
  });

  it('rollback returns error shape for nonexistent run', async () => {
    const deps: ResearchToolDeps = {
      runService,
      config: makeConfig(),
      getProvider: async () => makeMockProvider(),
    };
    const result = await handleResearchTool(
      { action: 'rollback', runId: 'run_nonexistent' },
      deps,
    );
    // rollbackRunById returns outcome counts (no events to roll back = all skipped)
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('executed');
    expect(result).toHaveProperty('blocked');
  });

  it('start delegates to getProvider lazily', async () => {
    let providerCalled = false;
    const deps: ResearchToolDeps = {
      runService,
      config: makeConfig(),
      getProvider: async () => {
        providerCalled = true;
        return makeMockProvider();
      },
    };
    const result = await handleResearchTool(
      { action: 'start', query: 'test research' },
      deps,
    );
    expect(result).toHaveProperty('runId');
    expect(result).toHaveProperty('familyId');
    expect(providerCalled).toBe(true);
  });

  it('getProvider error propagates', async () => {
    const deps: ResearchToolDeps = {
      runService,
      config: makeConfig(),
      getProvider: async () => {
        throw new Error('Provider not configured');
      },
    };
    const result = await handleResearchTool({ action: 'start', query: 'test' }, deps);
    expect(result).toEqual({ error: 'Provider not configured' });
  });
});

// ── Knowledge tool handler ─────────────────────────────────────────

describe('handleKnowledgeTool', () => {
  let queryService: KnowledgeQueryService;

  beforeEach(() => {
    initDb(TEST_DB);
    queryService = createKnowledgeQueryService(getDb()!);
  });

  function makeDeps(state: ProjectionState): KnowledgeToolDeps {
    return { getState: () => state, queryService, queryEvents: () => [] };
  }

  it('families lists all families on empty state', () => {
    const result = handleKnowledgeTool({ action: 'families' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ families: [] });
  });

  it('families with familyId returns not found on empty state', () => {
    const result = handleKnowledgeTool({ action: 'families', familyId: 'f1' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ found: false, error: 'Family not found: f1' });
  });

  it('threads returns empty array for unknown family', () => {
    const result = handleKnowledgeTool({ action: 'threads', familyId: 'f1' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ familyId: 'f1', threads: [] });
  });

  it('claims returns empty array for unknown family', () => {
    const result = handleKnowledgeTool({ action: 'claims', familyId: 'f1' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ familyId: 'f1', threadId: undefined, claims: [] });
  });

  it('evidence returns empty array for unknown claim', () => {
    const result = handleKnowledgeTool({ action: 'evidence', claimId: 'clm_1' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ claimId: 'clm_1', evidence: [] });
  });

  it('contradictions returns empty array for unknown family', () => {
    const result = handleKnowledgeTool({ action: 'contradictions', familyId: 'f1' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ familyId: 'f1', contradictions: [] });
  });

  it('gaps returns empty array for unknown family', () => {
    const result = handleKnowledgeTool({ action: 'gaps', familyId: 'f1' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ familyId: 'f1', gaps: [] });
  });

  it('entity returns not found for unknown id', () => {
    const result = handleKnowledgeTool({ action: 'entity', entityId: 'e1' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ found: false, error: 'Entity not found: e1' });
  });

  it('entity returns not found for unknown label', () => {
    const result = handleKnowledgeTool({ action: 'entity', label: 'NoSuchThing' }, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ found: false, error: 'No entity with label: NoSuchThing' });
  });

  it('entity returns error when neither id nor label given', () => {
    const result = handleKnowledgeTool({ action: 'entity' } as any, makeDeps(makeEmptyProjectionState()));
    expect(result).toEqual({ error: 'Either entityId or label must be provided' });
  });
});
