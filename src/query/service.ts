import type { Database } from 'better-sqlite3';
import type { Claim, ClaimObservation, ClaimRelation, Evidence, Source } from '../graph/types.js';
import type { KnowledgeReadModelStatus } from '../store/readModel/types.js';
import { decodeCursor, encodeCursor, resolveLimit, validateSearchQuery } from './cursor.js';
import { InvalidQueryError, ReadModelUnavailableError } from './errors.js';
import type { ListClaimRelationsInput, ListClaimsInput, ListEvidenceForClaimInput, ListSourcesInput, QueryPage, QueryResult, PageInput } from './types.js';

interface PayloadRow { payload_json: string; }
interface ClaimKeyRow extends PayloadRow { id: string; last_seen_at: string | null; }
interface KeyRow extends PayloadRow { id: string; observed_at: string; last_seen_at: string; }

export function createKnowledgeQueryService(db: Database) {
  function status(): KnowledgeReadModelStatus {
    const row = db.prepare("SELECT model_version, last_applied_seq, status FROM rm_state WHERE model_name='knowledge'").get() as { model_version: number; last_applied_seq: number; status: 'ready' | 'dirty' } | undefined;
    if (!row) throw new Error('Knowledge read-model state is missing');
    return { version: row.model_version, lastAppliedSeq: row.last_applied_seq, status: row.status };
  }

  function requireReady(): KnowledgeReadModelStatus {
    const current = status();
    if (current.status === 'dirty') throw new ReadModelUnavailableError(current);
    return current;
  }

  function getClaim(id: string): QueryResult<Claim | null> {
    const readModel = requireReady();
    const row = db.prepare('SELECT payload_json FROM rm_claims WHERE id = ?').get(id) as PayloadRow | undefined;
    return { data: row ? JSON.parse(row.payload_json) as Claim : null, readModel };
  }

  function getSource(id: string): QueryResult<Source | null> {
    const readModel = requireReady();
    const row = db.prepare('SELECT payload_json FROM rm_sources WHERE id = ?').get(id) as PayloadRow | undefined;
    return { data: row ? JSON.parse(row.payload_json) as Source : null, readModel };
  }

  function listClaims(input: ListClaimsInput = {}): QueryPage<Claim> {
    const readModel = requireReady();
    const limit = resolveLimit(input.limit);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.familyId !== undefined) { conditions.push('c.family_id = ?'); params.push(input.familyId); }
    if (input.threadId !== undefined) { conditions.push('c.thread_id = ?'); params.push(input.threadId); }
    if (input.epistemicStatus !== undefined) { conditions.push('c.epistemic_status = ?'); params.push(input.epistemicStatus); }
    if (input.contradictionState !== undefined) { conditions.push('c.contradiction_state = ?'); params.push(input.contradictionState); }
    const q = validateSearchQuery(input.q);
    if (q !== undefined) { conditions.push('f.rowid = c.rowid AND rm_claims_fts MATCH ?'); params.push(q); }
    if (input.cursor !== undefined) {
      const [lastSeenAt, id] = decodeCursor(input.cursor, 'claims').key;
      if (lastSeenAt === null) { conditions.push('(c.last_seen_at IS NULL AND c.id > ?)'); params.push(id); }
      else { conditions.push('((c.last_seen_at IS NOT NULL AND c.last_seen_at < ?) OR (c.last_seen_at = ? AND c.id > ?) OR c.last_seen_at IS NULL)'); params.push(lastSeenAt, lastSeenAt, id); }
    }
    const from = q === undefined ? 'rm_claims c' : 'rm_claims c, rm_claims_fts f';
    const sql = `SELECT c.id, c.last_seen_at, c.payload_json FROM ${from}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY c.last_seen_at DESC, c.id ASC LIMIT ?`;
    let rows: ClaimKeyRow[];
    try { rows = db.prepare(sql).all(...params, limit + 1) as ClaimKeyRow[]; }
    catch (error) { if (q !== undefined) throw new InvalidQueryError(`Invalid search query: ${error instanceof Error ? error.message : String(error)}`); throw error; }
    const hasNext = rows.length > limit;
    const included = hasNext ? rows.slice(0, limit) : rows;
    const last = included.at(-1);
    return { items: included.map(row => JSON.parse(row.payload_json) as Claim), nextCursor: hasNext && last ? encodeCursor({ v: 1, kind: 'claims', key: [last.last_seen_at, last.id] }) : null, readModel };
  }

  function listSources(input: ListSourcesInput = {}): QueryPage<Source> {
    const readModel = requireReady();
    const limit = resolveLimit(input.limit);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (input.domain !== undefined) { conditions.push('s.domain = ?'); params.push(input.domain); }
    if (input.sourceType !== undefined) { conditions.push('s.source_type = ?'); params.push(input.sourceType); }
    if (input.extractionStatus !== undefined) { conditions.push('s.extraction_status = ?'); params.push(input.extractionStatus); }
    const q = validateSearchQuery(input.q);
    if (q !== undefined) { conditions.push('f.rowid = s.rowid AND rm_sources_fts MATCH ?'); params.push(q); }
    if (input.cursor !== undefined) { const [at, id] = decodeCursor(input.cursor, 'sources').key; conditions.push('(s.last_seen_at < ? OR (s.last_seen_at = ? AND s.id > ?))'); params.push(at, at, id); }
    const from = q === undefined ? 'rm_sources s' : 'rm_sources s, rm_sources_fts f';
    const sql = `SELECT s.id, s.last_seen_at, s.payload_json FROM ${from}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY s.last_seen_at DESC, s.id ASC LIMIT ?`;
    let rows: KeyRow[];
    try { rows = db.prepare(sql).all(...params, limit + 1) as KeyRow[]; }
    catch (error) { if (q !== undefined) throw new InvalidQueryError(`Invalid search query: ${error instanceof Error ? error.message : String(error)}`); throw error; }
    const hasNext = rows.length > limit; const included = hasNext ? rows.slice(0, limit) : rows; const last = included.at(-1);
    return { items: included.map(row => JSON.parse(row.payload_json) as Source), nextCursor: hasNext && last ? encodeCursor({ v: 1, kind: 'sources', key: [last.last_seen_at, last.id] }) : null, readModel };
  }

  function listClaimObservationsForClaim(input: { claimId: string } & PageInput): QueryPage<ClaimObservation> {
    const readModel = requireReady(); const limit = resolveLimit(input.limit); const params: unknown[] = [input.claimId]; let cursor = '';
    if (input.cursor !== undefined) { const [at, id] = decodeCursor(input.cursor, 'claim-observations').key; cursor = ' AND (observed_at > ? OR (observed_at = ? AND id > ?))'; params.push(at, at, id); }
    const rows = db.prepare(`SELECT id, observed_at, payload_json FROM rm_claim_observations WHERE claim_id = ?${cursor} ORDER BY observed_at ASC, id ASC LIMIT ?`).all(...params, limit + 1) as KeyRow[];
    const hasNext = rows.length > limit; const included = hasNext ? rows.slice(0, limit) : rows; const last = included.at(-1);
    return { items: included.map(row => JSON.parse(row.payload_json) as ClaimObservation), nextCursor: hasNext && last ? encodeCursor({ v: 1, kind: 'claim-observations', key: [last.observed_at, last.id] }) : null, readModel };
  }

  function listEvidenceForClaim(input: ListEvidenceForClaimInput): QueryPage<Evidence> {
    const readModel = requireReady(); const limit = resolveLimit(input.limit); const conditions = ['claim_id = ?']; const params: unknown[] = [input.claimId];
    if (input.stance !== undefined) { conditions.push('stance = ?'); params.push(input.stance); }
    if (input.cursor !== undefined) { const [id] = decodeCursor(input.cursor, 'evidence').key; conditions.push('id > ?'); params.push(id); }
    const rows = db.prepare(`SELECT id, payload_json FROM rm_evidence WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT ?`).all(...params, limit + 1) as KeyRow[];
    const hasNext = rows.length > limit; const included = hasNext ? rows.slice(0, limit) : rows; const last = included.at(-1);
    return { items: included.map(row => JSON.parse(row.payload_json) as Evidence), nextCursor: hasNext && last ? encodeCursor({ v: 1, kind: 'evidence', key: [last.id] }) : null, readModel };
  }

  function listClaimRelations(input: ListClaimRelationsInput): QueryPage<ClaimRelation> {
    const readModel = requireReady(); const limit = resolveLimit(input.limit); const direction = input.direction ?? 'either';
    const conditions: string[] = []; const params: unknown[] = [];
    if (direction === 'from') { conditions.push('from_claim_id = ?'); params.push(input.claimId); }
    else if (direction === 'to') { conditions.push('to_claim_id = ?'); params.push(input.claimId); }
    else { conditions.push('(from_claim_id = ? OR to_claim_id = ?)'); params.push(input.claimId, input.claimId); }
    if (input.relation !== undefined) { conditions.push('relation = ?'); params.push(input.relation); }
    if (input.cursor !== undefined) { const [id] = decodeCursor(input.cursor, 'claim-relations').key; conditions.push('id > ?'); params.push(id); }
    const rows = db.prepare(`SELECT id, payload_json FROM rm_claim_relations WHERE ${conditions.join(' AND ')} ORDER BY id ASC LIMIT ?`).all(...params, limit + 1) as KeyRow[];
    const hasNext = rows.length > limit; const included = hasNext ? rows.slice(0, limit) : rows; const last = included.at(-1);
    return { items: included.map(row => JSON.parse(row.payload_json) as ClaimRelation), nextCursor: hasNext && last ? encodeCursor({ v: 1, kind: 'claim-relations', key: [last.id] }) : null, readModel };
  }

  return { status, getClaim, listClaims, listClaimObservationsForClaim, getSource, listSources, listEvidenceForClaim, listClaimRelations };
}

export type KnowledgeQueryService = ReturnType<typeof createKnowledgeQueryService>;
