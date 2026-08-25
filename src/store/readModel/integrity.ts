import { getDb } from '../db.js';
import type { ProjectionState } from '../projectionState.js';
import type { KnowledgeReadModelStatus } from './types.js';
import { serializeClaim, serializeClaimObservation, serializeClaimRelation, serializeEvidence, serializeSource } from './serializers.js';

export function getKnowledgeReadModelStatus(): KnowledgeReadModelStatus {
  const db = getDb();
  if (db === null) throw new Error('Database is not initialized');
  const row = db.prepare("SELECT model_version, last_applied_seq, status FROM rm_state WHERE model_name='knowledge'").get() as { model_version: number; last_applied_seq: number; status: 'ready' | 'dirty' } | undefined;
  if (row === undefined) throw new Error('Knowledge read-model state is missing');
  return { version: row.model_version, lastAppliedSeq: row.last_applied_seq, status: row.status };
}


export function verifyKnowledgeReadModel(state: ProjectionState): { matches: boolean; mismatches: string[] } {
  const db = getDb();
  if (db === null) throw new Error('Database is not initialized');
  const expected: Record<string, Map<string, Record<string, unknown>>> = {
    rm_claims: new Map([...state.claims].map(([id, value]) => [id, serializeClaim(value)])),
    rm_claim_observations: new Map([...state.claimObservations]
      .filter(([id]) => state.observationToClaimId.has(id))
      .map(([id, value]) => [id, serializeClaimObservation(value, state.observationToClaimId.get(id) ?? '')])),
    rm_sources: new Map([...state.sources].map(([id, value]) => [id, serializeSource(value)])),
    rm_evidence: new Map([...state.evidence].map(([id, value]) => [id, serializeEvidence(value)])),
    rm_claim_relations: new Map([...state.claimRelations].map(([id, value]) => [id, serializeClaimRelation(value)])),
  };
  const mismatches: string[] = [];
  for (const [table, values] of Object.entries(expected)) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const actual = new Map(rows.map((row) => [String(row.id), row]));
    if (actual.size !== values.size) mismatches.push(`${table}: count expected ${String(values.size)}, got ${String(actual.size)}`);
    for (const [id, expectedRow] of values) {
      const actualRow = actual.get(id);
      if (actualRow === undefined) {
        mismatches.push(`${table}: missing row ${id}`);
        continue;
      }
      for (const [column, expectedValue] of Object.entries(expectedRow)) {
        const actualValue = actualRow[column];
        if (column === 'payload_json') {
          if (actualValue !== expectedValue) mismatches.push(`${table}: payload mismatch ${id}`);
        } else if (actualValue !== expectedValue) {
          mismatches.push(`${table}: row ${id} column ${column} expected ${JSON.stringify(expectedValue)} got ${JSON.stringify(actualValue)}`);
        }
      }
    }
    for (const id of actual.keys()) if (!values.has(id)) mismatches.push(`${table}: unexpected row ${id}`);
  }
  return { matches: mismatches.length === 0, mismatches };
}
