import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NewEventInput } from '../../src/store/events.js';
import type { EventHandlerRegistry } from '../../src/store/projectionState.js';
import { appendEvents, closeDb, createEmptyProjectionState, getDb, initDb } from '../../src/store/index.js';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../../src/workspace/projectionHandlers.js';
import { EVENT_CODECS } from '../../src/store/eventSchemas/registry.js';
import { READ_MODEL_IMPACT } from '../../src/store/readModel/index.js';

const handlers: EventHandlerRegistry = { ...graphEventHandlers, ...workspaceEventHandlers };
let tempDir: string;
const assertion = (subjectText: string) => ({ subjectText, predicate: 'improves', objectText: 'research', polarity: 'asserted' as const, hedge: 'certain' as const, evidenceType: 'study' as const, canonicalKey: { subject: subjectText.toLowerCase(), predicate: 'improves' } });
const event = (eventType: NewEventInput['eventType'], payload: unknown, eventVersion = 1): NewEventInput => ({ eventType, eventVersion, runId: 'run-incremental', batchId: null, actor: 'system', entityId: null, entityType: null, timestamp: new Date().toISOString(), payload });
const family = () => event('FAMILY_CREATED', { family_id: 'family-1', label: 'Incremental tests' });
const observation = (id: string, text: string) => ({ ...assertion(text), id, familyId: 'family-1', runId: 'run-incremental', observedAt: new Date().toISOString(), confidence: 0.9, sourceIds: [], extractionVersion: 'v1' });
const observed = (id: string, text: string, claimId: string, classification: 'new_claim' | 'supersedes' = 'new_claim', previousObservationId?: string): NewEventInput => event('CLAIM_OBSERVED', { observation: observation(id, text), reconciliation: { observationId: id, classification, canonicalClaimId: classification === 'supersedes' ? `claim_${id}` : claimId, ...(classification === 'new_claim' ? {} : { matchedClaimId: claimId, supersedes: { previousObservationId, previousAssertion: assertion('old') } }), score: 1, method: 'canonical_key_exact', rationale: 'test', reconcilerVersion: 1, candidates: [] } });
const projection = () => createEmptyProjectionState();
const count = (table: string) => (getDb()!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-read-model-incremental-')); expect(initDb(path.join(tempDir, 'read-model.db'))).not.toBeNull(); });
afterEach(() => { closeDb(); fs.rmSync(tempDir, { recursive: true, force: true }); });

describe('incremental knowledge read-model updates', () => {
  it('writes event, claim, and observation in one append', () => {
    const state = projection();
    const result = appendEvents([family(), observed('obs-1', 'first claim', 'claim-1')], { projection: state, handlers });
    expect(result).toHaveLength(2);
    expect(count('events')).toBe(2);
    expect(count('rm_claims')).toBe(1);
    expect(count('rm_claim_observations')).toBe(1);
  });

  it('supersedes creates new claim and preserves old', () => {
    const state = projection();
    appendEvents([family(), observed('obs-1', 'old assertion', 'claim-1')], { projection: state, handlers });
    appendEvents([observed('obs-2', 'new assertion', 'claim-1', 'supersedes', 'obs-1')], { projection: state, handlers });
    expect(count('rm_claims')).toBe(2);
    const oldRow = getDb()!.prepare("SELECT payload_json FROM rm_claims WHERE id='claim-1'").get() as { payload_json: string };
    expect(JSON.parse(oldRow.payload_json).subjectText).toBe('old assertion');
    const newRow = getDb()!.prepare("SELECT payload_json FROM rm_claims WHERE id='claim_obs-2'").get() as { payload_json: string };
    expect(JSON.parse(newRow.payload_json).subjectText).toBe('new assertion');
  });

  it('writes evidence and refreshed claim counts', () => {
    const state = projection();
    appendEvents([family(), observed('obs-1', 'claim', 'claim-1'), event('SOURCE_OBSERVED', { sourceId: 'source-1', observedSourceId: 'provider-1', canonicalUrl: 'https://example.com', url: 'https://example.com', domain: 'example.com', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'run-incremental', observedAt: new Date().toISOString() })], { projection: state, handlers });
    appendEvents([event('EVIDENCE_LINKED', { id: 'evidence-1', claimId: 'claim-1', sourceId: 'source-1', observationId: 'obs-1', stance: 'supports', runId: 'run-incremental', excerpt: 'proof' }, 2)], { projection: state, handlers });
    expect(count('rm_evidence')).toBe(1);
    expect(getDb()!.prepare("SELECT supporting_evidence_count, opposing_evidence_count FROM rm_claims WHERE id='claim-1'").get()).toEqual({ supporting_evidence_count: 1, opposing_evidence_count: 0 });
  });

  it('inserts and updates observed sources', () => {
    const state = projection();
    const source = (title: string) => event('SOURCE_OBSERVED', { sourceId: 'source-1', observedSourceId: 'provider-1', canonicalUrl: 'https://example.com', url: 'https://example.com', title, domain: 'example.com', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'run-incremental', observedAt: new Date().toISOString() });
    appendEvents([source('first')], { projection: state, handlers });
    appendEvents([source('second')], { projection: state, handlers });
    expect(count('rm_sources')).toBe(1);
    expect((getDb()!.prepare("SELECT run_count FROM rm_sources WHERE id='source-1'").get() as { run_count: number }).run_count).toBe(2);
  });

  it('inserts and removes claim relations', () => {
    const state = projection();
    appendEvents([family(), observed('obs-1', 'one', 'claim-1'), observed('obs-2', 'two', 'claim-2'), event('EDGE_ADDED', { id: 'relation-1', fromClaimId: 'claim-1', toClaimId: 'claim-2', relation: 'supports', strength: 'strong', score: 0.9, runId: 'run-incremental' })], { projection: state, handlers });
    expect(count('rm_claim_relations')).toBe(1);
    appendEvents([event('EDGE_REMOVED', { edgeId: 'relation-1' })], { projection: state, handlers });
    expect(count('rm_claim_relations')).toBe(0);
  });

  it('keeps FTS tokens synchronized after supersedes', () => {
    const state = projection();
    appendEvents([family(), observed('obs-1', 'old unique token', 'claim-1')], { projection: state, handlers });
    appendEvents([observed('obs-2', 'new unique token', 'claim-1', 'supersedes', 'obs-1')], { projection: state, handlers });
    const db = getDb()!;
    // Old claim persists (superseded but not deleted) — 'old' still in FTS
    expect((db.prepare("SELECT COUNT(*) AS n FROM rm_claims_fts WHERE rm_claims_fts MATCH 'old'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM rm_claims_fts WHERE rm_claims_fts MATCH 'new'").get() as { n: number }).n).toBe(1);
  });

  it('rolls back event insert when read-model serialization fails', () => {
    const state = projection();
    appendEvents([event('SOURCE_OBSERVED', { sourceId: 'source-1', observedSourceId: 'provider-1', canonicalUrl: 'https://example.com', url: 'https://example.com', domain: 'example.com', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'run-incremental', observedAt: new Date().toISOString() })], { projection: state, handlers });
    (state.sources.get('source-1') as unknown as { broken: bigint }).broken = 1n;
    expect(() => appendEvents([event('SOURCE_READ', { sourceId: 'source-1' })], { projection: state, handlers })).toThrow();
    expect(count('events')).toBe(1);
  });

  it('advances read-model cursor to final batch sequence', () => {
    const state = projection();
    const result = appendEvents([event('SOURCE_OBSERVED', { sourceId: 'source-1', observedSourceId: 'provider-1', canonicalUrl: 'https://example.com/1', url: 'https://example.com/1', domain: 'example.com', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'run-incremental', observedAt: new Date().toISOString() }), event('SOURCE_OBSERVED', { sourceId: 'source-2', observedSourceId: 'provider-2', canonicalUrl: 'https://example.com/2', url: 'https://example.com/2', domain: 'example.com', sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'run-incremental', observedAt: new Date().toISOString() })], { projection: state, handlers });
    expect((getDb()!.prepare("SELECT last_applied_seq FROM rm_state WHERE model_name='knowledge'").get() as { last_applied_seq: number }).last_applied_seq).toBe(result[1]!.seq);
  });

  it('keeps stale cursor when append starts with read-model backlog', () => {
    const state = projection();
    const sourceEvent = (id: string) => event('SOURCE_OBSERVED', { sourceId: id, observedSourceId: id, canonicalUrl: `https://${id}.example.com`, url: `https://${id}.example.com`, domain: `${id}.example.com`, sourceType: 'web', isPrimary: true, extractionStatus: 'extracted', runId: 'run-incremental', observedAt: new Date().toISOString() });
    appendEvents([sourceEvent('source-1'), sourceEvent('source-2'), sourceEvent('source-3')], { projection: state, handlers });
    getDb()!.prepare("UPDATE rm_state SET last_applied_seq = 0, status = 'ready' WHERE model_name = 'knowledge'").run();
    appendEvents([sourceEvent('source-4')], { projection: state, handlers });
    expect(getDb()!.prepare("SELECT last_applied_seq, status FROM rm_state WHERE model_name='knowledge'").get()).toEqual({ last_applied_seq: 0, status: 'dirty' });
  });

  it('has impact resolver for every registered event type', () => {
    for (const eventType of Object.keys(EVENT_CODECS)) expect(READ_MODEL_IMPACT[eventType as keyof typeof READ_MODEL_IMPACT]).toBeDefined();
  });
});
