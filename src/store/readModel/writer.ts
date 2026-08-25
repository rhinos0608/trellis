import type { Database } from 'better-sqlite3';
import type { EventEnvelope } from '../eventTypes.js';
import type { ProjectionState } from '../projectionState.js';
import { READ_MODEL_IMPACT } from './impact.js';
import type { ReadModelImpact } from './impact.js';
import { serializeClaim, serializeClaimObservation, serializeClaimRelation, serializeEvidence, serializeSource } from './serializers.js';

const TABLES = {
  claims: ['rm_claims', serializeClaim],
  observations: ['rm_claim_observations', serializeClaimObservation],
  sources: ['rm_sources', serializeSource],
  evidence: ['rm_evidence', serializeEvidence],
  relations: ['rm_claim_relations', serializeClaimRelation],
} as const;

type Table = keyof typeof TABLES;
interface StatementCacheEntry {
  delete: ReturnType<Database['prepare']>;
  insert: ReturnType<Database['prepare']> | null;
}
const statementCache = new WeakMap<Database, Map<Table, StatementCacheEntry>>();
function replace(db: Database, table: Table, value: Record<string, unknown> | undefined, id: string, claimIdOverride?: string): void {
  const [name, serializer] = TABLES[table];
  let statements = statementCache.get(db)?.get(table);
  if (statements === undefined) {
    const cache = statementCache.get(db) ?? new Map<Table, StatementCacheEntry>();
    statements = { delete: db.prepare(`DELETE FROM ${name} WHERE id = ?`), insert: null };
    cache.set(table, statements);
    statementCache.set(db, cache);
  }
  statements.delete.run(id);
  if (value === undefined) return;
  const claimId = claimIdOverride ?? (typeof value.claimId === 'string' ? value.claimId : undefined);
  const row = (serializer as (value: never, claimId?: string) => Record<string, unknown>)(value as never, table === 'observations' ? claimId : undefined);
  const columns = Object.keys(row);
  statements.insert ??= db.prepare(`INSERT INTO ${name} (${columns.join(',')}) VALUES (${columns.map((c) => `@${c}`).join(',')})`);
  statements.insert.run(row);
}

export function syncKnowledgeReadModelBatch(db: Database, events: readonly EventEnvelope[], state: ProjectionState): void {
  if (events.length === 0) return;
  const current = db.prepare("SELECT last_applied_seq, status FROM rm_state WHERE model_name='knowledge'").get() as { last_applied_seq: number; status: string } | undefined;
  let dirty = current?.status === 'dirty' && current.last_applied_seq > 0;
  for (const event of events) {
    const impact: ReadModelImpact = READ_MODEL_IMPACT[event.eventType](event, state);
    if (impact.dirty) { dirty = true; continue; }
    if (dirty) continue;
    for (const id of impact.claimIds ?? []) replace(db, 'claims', state.claims.get(id) as unknown as Record<string, unknown> | undefined, id);
    for (const id of impact.observationIds ?? []) replace(db, 'observations', state.claimObservations.get(id) as unknown as Record<string, unknown> | undefined, id, state.observationToClaimId.get(id));
    for (const id of impact.sourceIds ?? []) replace(db, 'sources', state.sources.get(id) as unknown as Record<string, unknown> | undefined, id);
    for (const id of impact.evidenceIds ?? []) replace(db, 'evidence', state.evidence.get(id) as unknown as Record<string, unknown> | undefined, id);
    for (const id of impact.relationIds ?? []) replace(db, 'relations', state.claimRelations.get(id) as unknown as Record<string, unknown> | undefined, id);
  }
  const finalSeq = events[events.length - 1]?.seq;
  db.prepare("UPDATE rm_state SET last_applied_seq=?, status=?, updated_at=? WHERE model_name='knowledge'").run(finalSeq, dirty ? 'dirty' : 'ready', new Date().toISOString());
}
