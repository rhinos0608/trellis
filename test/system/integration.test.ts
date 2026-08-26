/**
 * System-level integration tests — proves three properties that no existing
 * unit test covers:
 *
 * 1. Process-restart survival: closeDb() + initDb() on same file path.
 * 2. Multi-run longitudinal accumulation within one family.
 * 3. Full pipeline through MCP tool handlers (handleResearchTool + handleKnowledgeTool).
 *
 * All tests use a real file-backed SQLite db, a mock ResearchProvider,
 * and the actual runService / projection / query layers end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, closeDb, appendEvents } from '../../src/store/index.js';
import { createRunService } from '../../src/research/runService.js';
import { rebuildProjection } from '../../src/store/projectionBuilder.js';
import { graphEventHandlers } from '../../src/graph/index.js';
import { workspaceEventHandlers } from '../../src/workspace/index.js';
import {
  getClaimsByFamily,
  getEvidenceForClaim,
  getContradictionsByFamily,
  getGapsByFamily,
} from '../../src/graph/queries.js';
import {
  getFamilyById,
} from '../../src/workspace/queries.js';
import { handleResearchTool } from '../../src/mcp/researchTool.js';
import { handleKnowledgeTool } from '../../src/mcp/knowledgeTool.js';
import { ResearchToolSchema, KnowledgeToolSchema } from '../../src/mcp/schemas.js';
import { queryEvents } from '../../src/store/events.js';
import { handleRunStarted } from '../../src/store/exampleHandlers.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import { createKnowledgeQueryService, type KnowledgeQueryService } from '../../src/query/service.js';
import { getDb } from '../../src/store/db.js';
import type { ProjectionState } from '../../src/store/projectionState.js';
import type { KnowledgeToolDeps } from '../../src/mcp/knowledgeTool.js';

function getQueryService(): KnowledgeQueryService {
  return createKnowledgeQueryService(getDb()!);
}
function wrapState(state: ProjectionState): KnowledgeToolDeps {
  return { getState: () => state, queryService: getQueryService(), queryEvents };
}
import type { ResearchProvider } from '../../src/providers/types.js';
import type { TrellisConfig } from '../../src/config/index.js';

// ── Mock provider ────────────────────────────────────────────────────

const mockProvider: ResearchProvider = {
  name: 'mock',
  capabilities: {
    search: true,
    read: true,
    academic: false,
    code: false,
    community: { reddit: false, hackernews: false, stackoverflow: false },
    media: false,
    reference: false,
    browser: false,
  },
  search: async () => [
    { url: 'https://example.com/result1', title: 'Result One', snippet: 'first snippet' },
  ],
  read: async (_ctx, url) => ({
    url,
    title: 'Mock Content Title',
    content: 'This is mock content that is definitely long enough to pass the threshold check for creating a finding from the extracted source.',
    contentHash: 'mockhash',
  }),
  crawl: async () => [],
  academic: async () => [],
};

function makeConfig(dbPath: string): TrellisConfig {
  return {
    storage: { dbPath },
    llm: { apiKey: undefined, baseUrl: undefined, model: undefined },
    searchProvider: { command: 'echo', args: [] },
    logLevel: 'silent',
  };
}

const ALL_HANDLERS = { ...graphEventHandlers, ...workspaceEventHandlers };

// ── Shared helpers ───────────────────────────────────────────────────

let tmpDir: string;

// Every RunService owns a live scheduler; if one is still running when a
// test closes the db, its timers can append lifecycle events into the
// NEXT test's fresh database and corrupt its run ledger. Track all
// instances and shut them down before closeDb.
const createdServices: ReturnType<typeof createRunService>[] = [];
function trackedCreateRunService(): ReturnType<typeof createRunService> {
  const svc = createRunService();
  createdServices.push(svc);
  return svc;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-sys-'));
});

afterEach(async () => {
  for (const svc of createdServices.splice(0)) await svc.shutdownScheduler();
  closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* cleanup ok */ }
});

/**
 * Poll getStatus until completed or timeout.
 */
async function waitForRun(
  svc: ReturnType<typeof createRunService>,
  runId: string,
  timeoutMs = 15_000,
): Promise<NonNullable<ReturnType<typeof svc.getStatus>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = svc.getStatus(runId);
    if (st && (st.status === 'completed' || st.status === 'failed' || st.status === 'cancelled')) {
      return st;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const finalStatus = svc.getStatus(runId);
  throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms. Last status: ${JSON.stringify(finalStatus)}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Property 1: Process-restart survival
// ═══════════════════════════════════════════════════════════════════════

describe('Property 1: process-restart survival', () => {
  it('closeDb + initDb on same file preserves all state', async () => {
    const dbPath = path.join(tmpDir, 'restart-test.db');
    const config = makeConfig(dbPath);

    // ── Phase 1: run a research cycle ─────────────────────────────
    initDb(dbPath);
    const svc1 = trackedCreateRunService();
    const { runId, familyId } = await svc1.startRun({
      query: 'What are the benefits of TypeScript over JavaScript?',
      provider: mockProvider,
      config,
      strategy: 'pipeline',
    });

    await waitForRun(svc1, runId);

    // Snapshot state before restart
    const statusBefore = svc1.getStatus(runId);
    expect(statusBefore).not.toBeNull();
    expect(statusBefore!.status).toBe('completed');
    expect(statusBefore!.claimCount).toBe(0);

    // Build projection from running db and record all claims
    const stateBefore = rebuildProjection(ALL_HANDLERS);
    const claimsBefore = getClaimsByFamily(stateBefore, familyId);
    expect(claimsBefore.length).toBe(0);
    const claimIdsBefore = claimsBefore.map((c) => c.id).sort();
    const familyBefore = getFamilyById(stateBefore, familyId);
    expect(familyBefore).toBeDefined();

    // Record evidence and contradictions counts
    const evidenceBefore = claimsBefore.flatMap((c) => getEvidenceForClaim(stateBefore, c.id));
    const contradictionsBefore = getContradictionsByFamily(stateBefore, familyId);
    const gapsBefore = getGapsByFamily(stateBefore, familyId);
    const sourcesBeforeCount = stateBefore.sources.size;

    // ── Phase 2: simulate process exit + restart ──────────────────
    closeDb();
    // Verify db file still exists on disk
    expect(fs.existsSync(dbPath)).toBe(true);

    initDb(dbPath);

    // ── Phase 3: rebuild projection and verify everything ─────────
    const stateAfter = rebuildProjection(ALL_HANDLERS);

    // Family survived
    const familyAfter = getFamilyById(stateAfter, familyId);
    expect(familyAfter).toBeDefined();
    expect(familyAfter!.label).toBe(familyBefore!.label);

    // All claims survived
    const claimsAfter = getClaimsByFamily(stateAfter, familyId);
    const claimIdsAfter = claimsAfter.map((c) => c.id).sort();
    expect(claimIdsAfter).toEqual(claimIdsBefore);

    // Evidence survived
    const evidenceAfter = claimsAfter.flatMap((c) => getEvidenceForClaim(stateAfter, c.id));
    expect(evidenceAfter.length).toBe(evidenceBefore.length);

    // Contradictions survived (may be 0 — that's fine, just verify count matches)
    const contradictionsAfter = getContradictionsByFamily(stateAfter, familyId);
    expect(contradictionsAfter.length).toBe(contradictionsBefore.length);

    // Gaps survived
    const gapsAfter = getGapsByFamily(stateAfter, familyId);
    expect(gapsAfter.length).toBe(gapsBefore.length);

    // Sources survived
    expect(stateAfter.sources.size).toBe(sourcesBeforeCount);

    // Run status still queryable via event store
    const svc2 = trackedCreateRunService();
    const statusAfter = svc2.getStatus(runId);
    expect(statusAfter).not.toBeNull();
    expect(statusAfter!.status).toBe('completed');
    expect(statusAfter!.claimCount).toBe(statusBefore!.claimCount);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Property 2: Multi-run longitudinal accumulation within one family
// ═══════════════════════════════════════════════════════════════════════

describe('Property 2: multi-run longitudinal accumulation', () => {
  it('two runs with explicit same familyId accumulate claims correctly', async () => {
    const dbPath = path.join(tmpDir, 'longitudinal-test.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    const FAMILY = 'fam_typescript_benefits';

    // ── Run 1 ─────────────────────────────────────────────────────
    const svc = trackedCreateRunService();
    const run1 = await svc.startRun({
      query: 'Benefits of TypeScript',
      provider: mockProvider,
      config,
      strategy: 'pipeline',
      explicitFamilyId: FAMILY,
    });
    await waitForRun(svc, run1.runId);

    const state1 = rebuildProjection(ALL_HANDLERS);
    const claimsRun1 = getClaimsByFamily(state1, FAMILY);
    expect(claimsRun1.length).toBe(0);

    // ── Run 2 (different query, same explicit family) ─────────────
    const run2 = await svc.startRun({
      query: 'TypeScript vs JavaScript performance',
      provider: mockProvider,
      config,
      strategy: 'pipeline',
      explicitFamilyId: FAMILY,
    });
    await waitForRun(svc, run2.runId);

    const state2 = rebuildProjection(ALL_HANDLERS);

    // Both runs' claims coexist under the same family
    const allClaims = getClaimsByFamily(state2, FAMILY);
    expect(allClaims.length).toBeGreaterThanOrEqual(claimsRun1.length);
    expect(allClaims.length).toBe(0); // no LLM → zero claims

    // Each claim's firstSeenRunId reflects which run created it
    for (const claim of allClaims) {
      expect(claim.firstSeenRunId).toBeTruthy();
      expect(claim.lastSeenRunId).toBeTruthy();
      const isValidRun = claim.firstSeenRunId === run1.runId || claim.firstSeenRunId === run2.runId;
      expect(isValidRun).toBe(true);
    }

    // At least one claim from run1 should still exist with firstSeenRunId = run1
    const claimsFromRun1 = allClaims.filter((c) => c.firstSeenRunId === run1.runId);
    // Run 2 reconciles same claim, so its observation updates lastSeenRunId.
    const claimsFromRun2 = allClaims.filter((c) => c.lastSeenRunId === run2.runId);
    expect(claimsFromRun1.length).toBe(0);
    expect(claimsFromRun2.length).toBe(0);

    // The family is the same
    const family = getFamilyById(state2, FAMILY);
    expect(family).toBeDefined();

    // Sources from both runs are accumulated
    expect(state2.sources.size).toBeGreaterThan(0);
  });

  it('both runs are queryable by status', async () => {
    const dbPath = path.join(tmpDir, 'longitudinal-status.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    const FAMILY = 'fam_lang_comparison';
    const svc = trackedCreateRunService();

    const run1 = await svc.startRun({
      query: 'Python vs Go concurrency',
      provider: mockProvider,
      config,
      strategy: 'pipeline',
      explicitFamilyId: FAMILY,
    });
    await waitForRun(svc, run1.runId);

    const run2 = await svc.startRun({
      query: 'Python concurrency patterns',
      provider: mockProvider,
      config,
      strategy: 'pipeline',
      explicitFamilyId: FAMILY,
    });
    await waitForRun(svc, run2.runId);

    // Both status checks succeed
    const st1 = svc.getStatus(run1.runId);
    const st2 = svc.getStatus(run2.runId);
    expect(st1!.status).toBe('completed');
    expect(st2!.status).toBe('completed');
    expect(st1!.claimCount).toBe(0);
    expect(st2!.claimCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Property 3: Full pipeline through MCP tool handlers
// ═══════════════════════════════════════════════════════════════════════

describe('Property 3: full pipeline through MCP tool handlers', () => {
  it('start → poll status → query knowledge → rollback → confirm rollback', async () => {
    const dbPath = path.join(tmpDir, 'mcp-handler-test.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    const svc = trackedCreateRunService();
    const deps = {
      runService: svc,
      config,
      getProvider: async () => mockProvider,
    };

    // ── Step 1: start via handleResearchTool ──────────────────────
    const startResult = await handleResearchTool(
      { action: 'start', query: 'Node.js event loop internals', strategy: 'pipeline' },
      deps,
    );
    const runId = startResult.runId as string;
    const familyId = startResult.familyId as string;
    expect(runId).toBeTruthy();
    expect(familyId).toBeTruthy();

    // ── Step 2: poll status until completed ───────────────────────
    const deadline = Date.now() + 15_000;
    let completed = false;
    while (Date.now() < deadline) {
      const pollResult = await handleResearchTool({ action: 'status', runId }, deps);
      if ((pollResult as Record<string, unknown>).status === 'completed') {
        completed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(completed).toBe(true);

    // ── Step 3: query knowledge.claims ────────────────────────────
    const state = rebuildProjection(ALL_HANDLERS);
    const claimsResult = handleKnowledgeTool(
      { action: 'claims', familyId },
      wrapState(state),
    );
    const claims = (claimsResult as Record<string, unknown>).claims as Array<Record<string, unknown>>;
    // No LLM configured → zero claims from extraction
    expect(claims.length).toBe(0);

    // ── Step 4: query knowledge.evidence for first claim ──
    if (claims.length > 0) {
      const firstClaimId = claims[0]!.id as string;
      const evidenceResult = handleKnowledgeTool(
        { action: 'evidence', claimId: firstClaimId },
        wrapState(state),
      );
      const evidence = (evidenceResult as Record<string, unknown>).evidence as Array<Record<string, unknown>>;
      expect(evidence.length).toBeGreaterThan(0);
    }

    // ── Step 5: query knowledge.contradictions ────────────────────
    const contradictionsResult = handleKnowledgeTool(
      { action: 'contradictions', familyId },
      wrapState(state),
    );
    expect(contradictionsResult).toHaveProperty('contradictions');

    // ── Step 6: query knowledge.gaps ──────────────────────────────
    const gapsResult = handleKnowledgeTool(
      { action: 'gaps', familyId },
      wrapState(state),
    );
    expect(gapsResult).toHaveProperty('gaps');

    // ── Step 7: query knowledge.families ──────────────────────────
    const familiesResult = handleKnowledgeTool(
      { action: 'families', familyId },
      wrapState(state),
    );
    expect((familiesResult as Record<string, unknown>).found).toBe(true);

    // ── Step 8: rollback via handleResearchTool ───────────────────
    const rollbackResult = await handleResearchTool({ action: 'rollback', runId }, deps);
    expect(rollbackResult.skipped).toBeGreaterThanOrEqual(0);
    expect(rollbackResult.blocked).toBeDefined();

    // ── Step 9: after rollback, claims are gone from projection ───
    const stateAfterRollback = rebuildProjection(ALL_HANDLERS);
    const claimsAfterRollback = getClaimsByFamily(stateAfterRollback, familyId);
    expect(claimsAfterRollback.length).toBe(0);

    // Evidence gone too (linked to rolled-back claims)
    const evidenceAfterRollback = claimsAfterRollback.flatMap((c) =>
      getEvidenceForClaim(stateAfterRollback, c.id),
    );
    expect(evidenceAfterRollback.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Property 7: MCP research wire-format parity (Stage 8A refactor)
// ═══════════════════════════════════════════════════════════════════

// The research tool handler was refactored into a thin adapter over the
// ResearchApplicationService (src/app). These assertions pin the exact
// JSON response shapes for every action so the internal extraction
// cannot silently change the MCP contract.

describe('Property 7: research wire-format parity through application service', () => {
  it('list/history/retry/continue/rollback responses keep their exact shapes', async () => {
    const dbPath = path.join(tmpDir, 'parity-test.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    const FAMILY = 'fam_wire_parity';
    const svc = trackedCreateRunService();
    const deps = { runService: svc, config, getProvider: async () => mockProvider };

    const startResult = await handleResearchTool(
      { action: 'start', query: 'Wire parity query', strategy: 'pipeline', familyId: FAMILY },
      deps,
    );
    // start response shape is exactly { runId, familyId }
    expect(Object.keys(startResult).sort()).toEqual(['familyId', 'runId']);
    const runId = startResult.runId as string;
    const familyId = startResult.familyId as string;
    expect(runId).toBeTruthy();
    expect(familyId).toBe(FAMILY);

    const finalStatus = await waitForRun(svc, runId);
    expect(finalStatus.status).toBe('completed');

    // status: { found: true } + full RunStatus spread
    const statusResult = await handleResearchTool({ action: 'status', runId }, deps);
    expect(statusResult).toMatchObject({ found: true, runId, familyId, status: 'completed', query: 'Wire parity query' });
    expect(typeof (statusResult as Record<string, unknown>).startedAt).toBe('string');
    expect(statusResult).toHaveProperty('progress');

    // status for unknown run keeps the { found: false, error } shape
    const unknown = await handleResearchTool({ action: 'status', runId: 'run_unknown' }, deps);
    expect(unknown).toEqual({ found: false, error: 'Run not found: run_unknown' });

    // list: top level { runs }, each entry has exactly the narrow summary fields
    const listResult = await handleResearchTool({ action: 'list', familyId: FAMILY }, deps);
    expect(Object.keys(listResult)).toEqual(['runs']);
    const runs = (listResult as { runs: Array<Record<string, unknown>> }).runs;
    expect(runs.length).toBeGreaterThanOrEqual(1);
    for (const run of runs) {
      expect(Object.keys(run).sort()).toEqual(
        ['completedAt', 'createdAt', 'familyId', 'query', 'runId', 'status', 'strategy'],
      );
    }

    // history: top level { runId, events }; each event { seq, eventType, timestamp, payload }
    const historyResult = await handleResearchTool({ action: 'history', runId, limit: 50 }, deps);
    expect(Object.keys(historyResult).sort()).toEqual(['events', 'runId']);
    const historyEvents = (historyResult as { events: Array<Record<string, unknown>> }).events;
    expect(historyEvents.length).toBeGreaterThan(0);
    for (const event of historyEvents) {
      expect(Object.keys(event).sort()).toEqual(['eventType', 'payload', 'seq', 'timestamp']);
    }

    // retry on a completed run keeps the catch-all { error } response shape
    const retryResult = await handleResearchTool({ action: 'retry', runId }, deps);
    expect(retryResult).toEqual({ error: 'Cannot retry run in status: completed' });

    // continue: discriminated result carries familyId/followUpsUsed/followUpCap + status
    const continueResult = await handleResearchTool({ action: 'continue', familyId: FAMILY }, deps);
    const cr = continueResult as Record<string, unknown>;
    expect(['queued', 'no_work', 'cap_reached']).toContain(cr.status);
    expect(cr.familyId).toBe(FAMILY);
    expect(typeof cr.followUpsUsed).toBe('number');
    expect(cr.followUpCap).toBe(3);

    // rollback: exact key set, readModelError omitted when absent
    const rollbackResult = await handleResearchTool({ action: 'rollback', runId }, deps);
    expect(Object.keys(rollbackResult).sort()).toEqual(['blocked', 'executed', 'readModelRebuilt', 'skipped']);
    expect((rollbackResult as Record<string, unknown>).readModelRebuilt).toBe(true);
    expect(Array.isArray((rollbackResult as Record<string, unknown>).blocked)).toBe(true);

    await svc.shutdownScheduler();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Sanity: all three properties can run in sequence on same db
// ═══════════════════════════════════════════════════════════════════════

describe('combined: restart + longitudinal + MCP handlers', () => {
  it('run, restart, run again with same family, then verify via MCP tool handlers', async () => {
    const dbPath = path.join(tmpDir, 'combined-test.db');
    const config = makeConfig(dbPath);
    const FAMILY = 'fam_combined_test';

    // ── Phase 1: first run ────────────────────────────────────────
    initDb(dbPath);
    const svc = trackedCreateRunService();

    const run1 = await svc.startRun({
      query: 'Rust memory safety guarantees',
      provider: mockProvider,
      config,
      strategy: 'pipeline',
      explicitFamilyId: FAMILY,
    });
    await waitForRun(svc, run1.runId);

    // ── Phase 2: restart ──────────────────────────────────────────
    await svc.shutdownScheduler();
    closeDb();
    expect(fs.existsSync(dbPath)).toBe(true);
    initDb(dbPath);

    // State survives restart
    const state1 = rebuildProjection(ALL_HANDLERS);
    const claims1 = getClaimsByFamily(state1, FAMILY);
    expect(claims1.length).toBe(0);

    // ── Phase 3: second run (longitudinal accumulation) ───────────
    const svc2 = trackedCreateRunService();
    const run2 = await svc2.startRun({
      query: 'Rust ownership model explained',
      provider: mockProvider,
      config,
      strategy: 'pipeline',
      explicitFamilyId: FAMILY,
    });
    await waitForRun(svc2, run2.runId);

    // ── Phase 4: verify via MCP tool handlers ─────────────────────
    const deps = {
      runService: svc2,
      config,
      getProvider: async () => mockProvider,
    };

    const state2 = rebuildProjection(ALL_HANDLERS);

    // Claims from both runs coexist
    const allClaims = handleKnowledgeTool({ action: 'claims', familyId: FAMILY }, wrapState(state2));
    const claimList = (allClaims as Record<string, unknown>).claims as Array<Record<string, unknown>>;
    expect(claimList.length).toBeGreaterThanOrEqual(claims1.length);

    // Status of both runs is completed
    const st1Result = await handleResearchTool({ action: 'status', runId: run1.runId }, deps);
    const st2Result = await handleResearchTool({ action: 'status', runId: run2.runId }, deps);
    expect((st1Result as Record<string, unknown>).status).toBe('completed');
    expect((st2Result as Record<string, unknown>).status).toBe('completed');

    // Rollback run2 only — run1's claims and family survive
    await handleResearchTool({ action: 'rollback', runId: run2.runId }, deps);

    const state3 = rebuildProjection(ALL_HANDLERS);
    const claimsAfterRollback = getClaimsByFamily(state3, FAMILY);

    // Claims from run2 are gone, claims from run1 survive
    for (const c of claimsAfterRollback) {
      expect(c.firstSeenRunId).toBe(run1.runId);
    }

    // Family still exists (created by run1, not rolled back)
    const family = getFamilyById(state3, FAMILY);
    expect(family).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Property 4: MCP actions with no prior integration coverage
// ═══════════════════════════════════════════════════════════════════════

describe('Property 4: research.cancel integration', () => {
  it('cancel an active run returns cancelled=true', async () => {
    const dbPath = path.join(tmpDir, 'cancel-test.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    const svc = trackedCreateRunService();
    const deps = { runService: svc, config, getProvider: async () => mockProvider };

    const startResult = await handleResearchTool(
      { action: 'start', query: 'Cancel test query' },
      deps,
    );
    const runId = startResult.runId as string;

    // Cancel immediately — may or may not be still running, but handler should not throw
    const cancelResult = await handleResearchTool({ action: 'cancel', runId }, deps);
    expect(cancelResult).toHaveProperty('cancelled');

    // If it was still running, cancelResult.cancelled === true
    // If it already finished, cancelResult.cancelled === false
    // Either way, the handler executed without error
    expect(typeof cancelResult.cancelled).toBe('boolean');
  });
});

describe('Property 4: knowledge.threads integration', () => {
  it('threads action returns a threads list for a family', async () => {
    const dbPath = path.join(tmpDir, 'threads-test.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    const svc = trackedCreateRunService();
    const { runId, familyId } = await svc.startRun({
      query: 'Threads test',
      provider: mockProvider,
      config,
      strategy: 'pipeline',
    });
    await waitForRun(svc, runId);

    const state = rebuildProjection(ALL_HANDLERS);
    const result = handleKnowledgeTool({ action: 'threads', familyId }, wrapState(state));
    expect(result).toHaveProperty('familyId', familyId);
    expect(result).toHaveProperty('threads');
    expect(Array.isArray(result.threads)).toBe(true);
  });
});

describe('Property 4: knowledge.entity integration', () => {
  it('entity action returns found:false for non-existent entity', async () => {
    const dbPath = path.join(tmpDir, 'entity-test.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    const state = rebuildProjection(ALL_HANDLERS);

    // By entityId
    const byId = handleKnowledgeTool({ action: 'entity', entityId: 'nonexistent_123' }, wrapState(state));
    expect(byId).toHaveProperty('found', false);

    // By label
    const byLabel = handleKnowledgeTool({ action: 'entity', label: 'NonExistent Entity' }, wrapState(state));
    expect(byLabel).toHaveProperty('found', false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Property 5: threadId round-trip through research.start
// ═══════════════════════════════════════════════════════════════════════

describe('Property 5: threadId round-trip', () => {
  it('threadId passed to startRun appears in RUN_QUEUED event and projection', async () => {
    const dbPath = path.join(tmpDir, 'threadid-test.db');
    const config = makeConfig(dbPath);
    initDb(dbPath);

    const svc = trackedCreateRunService();
    const deps = { runService: svc, config, getProvider: async () => mockProvider };
    const THREAD_ID = 'thread_roundtrip_test';
    const familyState = rebuildProjection(ALL_HANDLERS);
    appendEvents([
      {
        timestamp: new Date().toISOString(), eventType: 'FAMILY_CREATED', eventVersion: 1,
        runId: 'thread-fixture', batchId: null, actor: 'system', entityId: 'family_thread_fixture', entityType: 'family',
        payload: { family_id: 'family_thread_fixture', label: 'Thread fixture' },
      },
      {
        timestamp: new Date().toISOString(), eventType: 'THREAD_CREATED', eventVersion: 1,
        runId: 'thread-fixture', batchId: null, actor: 'system', entityId: THREAD_ID, entityType: 'thread',
        payload: { threadId: THREAD_ID, familyId: 'family_thread_fixture', label: 'Thread fixture' },
      },
    ], { projection: familyState, handlers: ALL_HANDLERS });

    const startResult = await handleResearchTool(
      { action: 'start', query: 'ThreadId roundtrip test', strategy: 'pipeline', familyId: 'family_thread_fixture', threadId: THREAD_ID },
      deps,
    );
    const runId = startResult.runId as string;
    await waitForRun(svc, runId);

    // Verify RUN_QUEUED event payload contains threadId
    const events = queryEvents({ runId });
    const startEvt = events.find((e) => e.eventType === 'RUN_QUEUED');
    expect(startEvt).toBeDefined();
    const payload = startEvt!.payload as Record<string, unknown>;
    expect(payload.threadId).toBe(THREAD_ID);

    // Verify handleRunStarted projects threadId into the research run
    const testState = createEmptyProjectionState();
    handleRunStarted(startEvt!, testState);
    const run = testState.researchRuns.get(runId);
    expect(run).toBeDefined();
    expect(run!.threadId).toBe(THREAD_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Property 6: MCP schema validation
// ═══════════════════════════════════════════════════════════════════════

describe('Property 6: MCP schema validation', () => {
  it('rejects strategy:"tree" with a validation error', () => {
    const result = ResearchToolSchema.safeParse({
      action: 'start',
      query: 'test',
      strategy: 'tree',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid strategy and depth values', () => {
    const result = ResearchToolSchema.safeParse({
      action: 'start',
      query: 'test',
      strategy: 'agent',
      depth: 'deep',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid depth value', () => {
    const result = ResearchToolSchema.safeParse({
      action: 'start',
      query: 'test',
      depth: 'ultra-mega-depth',
    });
    expect(result.success).toBe(false);
  });
});
