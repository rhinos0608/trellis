import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NewEventInput } from '../../src/store/events.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import { appendEvents, closeDb, createEmptyProjectionState, getDb, initDb, rebuildProjection } from '../../src/store/index.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { rebuildKnowledgeReadModel, verifyKnowledgeReadModel } from '../../src/store/readModel/index.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
let tempDir: string;
let dbPath: string;

function event(eventType: NewEventInput['eventType'], payload: unknown, runId = 'run-rm', eventVersion = 1): NewEventInput {
  return { eventType, eventVersion, runId, batchId: null, actor: 'system', entityId: null, entityType: null, timestamp: new Date().toISOString(), payload };
}

const assertion = (subjectText: string) => ({
  subjectText, predicate: 'improves', objectText: 'research', polarity: 'asserted' as const,
  hedge: 'certain' as const, evidenceType: 'study' as const,
  canonicalKey: { subject: subjectText.toLowerCase(), predicate: 'improves' },
});

function populate(): void {
  const projection = createEmptyProjectionState();
  const first = { ...assertion("Trellis's unicode ✓; claim"), id: 'obs-1', familyId: 'family-1', runId: 'run-rm', observedAt: '2025-01-01T00:00:00.000Z', confidence: 0.9, sourceIds: ['source-1'], extractionVersion: 'v1' };
  const second = { ...assertion('Another claim'), id: 'obs-2', familyId: 'family-1', runId: 'run-rm', observedAt: '2025-01-01T00:00:01.000Z', confidence: 0.8, sourceIds: [], extractionVersion: 'v1' };
  appendEvents([
    event('FAMILY_CREATED', { family_id: 'family-1', label: 'Read model test family' }),
    event('CLAIM_OBSERVED', { observation: first, reconciliation: { observationId: 'obs-1', classification: 'new_claim', canonicalClaimId: 'claim-1', score: 1, method: 'canonical_key_exact', rationale: 'new', reconcilerVersion: 1, candidates: [] } }),
    event('CLAIM_OBSERVED', { observation: second, reconciliation: { observationId: 'obs-2', classification: 'new_claim', canonicalClaimId: 'claim-2', score: 1, method: 'canonical_key_exact', rationale: 'new', reconcilerVersion: 1, candidates: [] } }),
    event('SOURCE_OBSERVED', { sourceId: 'source-1', observedSourceId: 'provider-source-1', canonicalUrl: "https://example.com/a?quote=';✓", url: "https://example.com/a?quote=';✓", title: 'Special source', domain: 'example.com', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'run-rm', observedAt: '2025-01-01T00:00:00.000Z' }),
    event('EVIDENCE_LINKED', { id: 'evidence-1', claimId: 'claim-1', sourceId: 'source-1', observationId: 'obs-1', runId: 'run-rm', stance: 'supports', excerpt: "quote '; ✓" }, 'run-rm', 2),
    event('EDGE_ADDED', { id: 'relation-1', fromClaimId: 'claim-1', toClaimId: 'claim-2', relation: 'supports', strength: 'strong', score: 0.9, runId: 'run-rm' }),
  ], { projection, handlers });
}

function count(table: string): number {
  return (getDb()!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-read-model-'));
  dbPath = path.join(tempDir, 'read-model.db');
  expect(initDb(dbPath)).not.toBeNull();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('knowledge read-model rebuild', () => {
  it('creates tables, FTS tables, indexes, and triggers in fresh migration', () => {
    const expected = ['rm_claims', 'rm_claim_observations', 'rm_sources', 'rm_evidence', 'rm_claim_relations', 'rm_claims_fts', 'rm_sources_fts', 'rm_claims_fts_ai', 'rm_claims_fts_ad', 'rm_claims_fts_au', 'rm_sources_fts_ai', 'rm_sources_fts_ad', 'rm_sources_fts_au', 'idx_rm_claims_family_last', 'idx_rm_claims_thread_last', 'idx_rm_claims_epistemic', 'idx_rm_claims_canonical', 'idx_rm_observations_claim_time', 'idx_rm_observations_family_time', 'idx_rm_observations_run', 'idx_rm_sources_domain_last', 'idx_rm_sources_type_last', 'idx_rm_sources_hash', 'idx_rm_evidence_claim', 'idx_rm_evidence_source', 'idx_rm_evidence_observation', 'idx_rm_evidence_run', 'idx_rm_relations_from', 'idx_rm_relations_to', 'idx_rm_relations_run'];
    const placeholders = expected.map(() => '?').join(',');
    const names = (getDb()!.prepare(`SELECT name FROM sqlite_master WHERE name IN (${placeholders})`).all(...expected) as { name: string }[]).map((row) => row.name);
    for (const name of expected) expect(names).toContain(name);
  });

  it('rebuilds empty event log to ready zero-row model', () => {
    const status = rebuildKnowledgeReadModel(handlers);
    expect(status).toEqual({ version: 1, lastAppliedSeq: 0, status: 'ready' });
    for (const table of ['rm_claims', 'rm_claim_observations', 'rm_sources', 'rm_evidence', 'rm_claim_relations']) expect(count(table)).toBe(0);
    expect(getDb()!.prepare("SELECT status, last_applied_seq FROM rm_state WHERE model_name='knowledge'").get()).toEqual({ status: 'ready', last_applied_seq: 0 });
  });

  it('rebuilds populated projection with exact collection parity and passes FTS integrity-check', () => {
    populate();
    expect(() => rebuildKnowledgeReadModel(handlers)).not.toThrow();
    const state = rebuildProjection(handlers, { forceGenesis: true });
    expect(verifyKnowledgeReadModel(state)).toEqual({ matches: true, mismatches: [] });
    expect(count('rm_claims')).toBe(state.claims.size);
    expect(count('rm_claim_observations')).toBe(state.claimObservations.size);
    expect(count('rm_sources')).toBe(state.sources.size);
    expect(count('rm_evidence')).toBe(state.evidence.size);
    expect(count('rm_claim_relations')).toBe(state.claimRelations.size);
  });

  it('round-trips special claim and source characters through payload_json', () => {
    populate();
    rebuildKnowledgeReadModel(handlers);
    const db = getDb()!;
    const claim = JSON.parse((db.prepare("SELECT payload_json FROM rm_claims WHERE id='claim-1'").get() as { payload_json: string }).payload_json) as Record<string, unknown>;
    const source = JSON.parse((db.prepare("SELECT payload_json FROM rm_sources WHERE id='source-1'").get() as { payload_json: string }).payload_json) as Record<string, unknown>;
    expect(claim.subjectText).toBe("Trellis's unicode ✓; claim");
    expect(source.url).toBe("https://example.com/a?quote=';✓");
    expect(claim).toEqual((rebuildProjection(handlers, { forceGenesis: true }).claims.get('claim-1')));
    expect(source).toEqual((rebuildProjection(handlers, { forceGenesis: true }).sources.get('source-1')));
  });

  it('detects scalar-column corruption independently of payload_json', () => {
    populate();
    rebuildKnowledgeReadModel(handlers);
    getDb()!.prepare("UPDATE rm_claims SET subject_text = 'corrupted' WHERE id = 'claim-1'").run();
    const result = verifyKnowledgeReadModel(rebuildProjection(handlers, { forceGenesis: true }));
    expect(result.matches).toBe(false);
    expect(result.mismatches.some((mismatch) => mismatch.includes('rm_claims: row claim-1 column subject_text'))).toBe(true);
  });

  it('restores intentionally deleted claim row on rebuild', () => {
    populate();
    rebuildKnowledgeReadModel(handlers);
    getDb()!.prepare('DELETE FROM rm_claims WHERE id = ?').run('claim-1');
    expect(count('rm_claims')).toBe(1);
    rebuildKnowledgeReadModel(handlers);
    expect(count('rm_claims')).toBe(2);
    expect(getDb()!.prepare("SELECT id FROM rm_claims WHERE id='claim-1'").get()).toBeDefined();
  });

  it('stores highest real event seq in rm_state', () => {
    populate();
    rebuildKnowledgeReadModel(handlers);
    const highest = (getDb()!.prepare('SELECT MAX(seq) AS seq FROM events').get() as { seq: number }).seq;
    const applied = (getDb()!.prepare("SELECT last_applied_seq FROM rm_state WHERE model_name='knowledge'").get() as { last_applied_seq: number }).last_applied_seq;
    expect(applied).toBe(highest);
  });

  it('completes FTS rebuild and integrity-check without throwing', () => {
    populate();
    // rebuildKnowledgeReadModel runs both FTS5 rebuild and integrity-check commands.
    expect(() => rebuildKnowledgeReadModel(handlers)).not.toThrow();
  });

  it('preserves lifecycle columns (curation_status) through genesis rebuild', () => {
    populate();
    const projection = rebuildProjection(handlers);
    appendEvents([
      event('CLAIM_RETRACTION_SET', { curation: { commandId: 'cmd-retract', reason: 'test', expectedSeq: 0 }, target: { kind: 'claim', id: 'claim-1' }, previousStatus: 'active', newStatus: 'retracted' }),
    ], { projection, handlers });
    rebuildKnowledgeReadModel(handlers);
    const row = getDb()!.prepare("SELECT curation_status FROM rm_claims WHERE id = 'claim-1'").get() as { curation_status: string };
    expect(row.curation_status).toBe('retracted');
    const otherRow = getDb()!.prepare("SELECT curation_status FROM rm_claims WHERE id = 'claim-2'").get() as { curation_status: string };
    expect(otherRow.curation_status).toBe('active');
  });
});
