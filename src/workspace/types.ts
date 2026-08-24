/**
 * Family and thread — Trellis's research workspace model. A Family is a
 * durable research workspace (manifest/threads/runs/claims/evidence/
 * sources/entities/gaps/contradictions/timeline), not a semantic bucket
 * like search-mcp's thin KgFamily ({id,label,description,createdAt,
 * lastActivity,runCount,relatedFamilies}). A Thread is a subdomain scoped
 * to one family. See docs/ARCHITECTURE.md §1 (#6,#7,#8) and §3.
 *
 * Runs/threads/claims/evidence/sources/gaps/contradictions/timeline for a
 * Family are QUERIES scoped by familyId against the tables in
 * graph/types.ts and research/types.ts — not columns on Family itself.
 *
 * Owned by Worker 4 (families + threads). Consumed by research/ (Worker 6,
 * 7 — family resolved BEFORE a run starts), mcp/ (Worker 8).
 */

/** Reused verbatim from search-mcp's KG FamilyRelationType. */
export type FamilyRelationType = 'adjacent' | 'contradicts' | 'parent' | 'child' | 'supersedes';

export interface FamilyRelation {
  relationId: string;
  familyId: string;
  relationType: FamilyRelationType;
  reason?: string;
}

export interface FamilyManifest {
  scopeQuery: string;
  scopeSummary?: string;
  tags?: string[];
}

export interface Family {
  id: string;
  label: string;
  description?: string;
  manifest: FamilyManifest;
  createdAt: string;
  lastActivity: string;
  relatedFamilies: FamilyRelation[];
}

export type ThreadStatus = 'open' | 'resolved' | 'stale';

export interface Thread {
  id: string;
  familyId: string;
  label: string;
  description?: string;
  createdAt: string;
  status: ThreadStatus;
}
