import type {
  ClaimContradictionState,
  ClaimRelationType,
  EpistemicStatus,
  EvidenceStance,
} from '../graph/types.js';
import type { KnowledgeReadModelStatus } from '../store/readModel/types.js';

/** Pagination input shared by all list queries. */
export interface PageInput {
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Default 50, clamped to [1, 100] by resolveLimit(). */
  limit?: number;
}

export interface QueryResult<T> {
  data: T;
  readModel: KnowledgeReadModelStatus;
}

export interface QueryPage<T> {
  items: T[];
  nextCursor: string | null;
  readModel: KnowledgeReadModelStatus;
}

export interface ListClaimsInput extends PageInput {
  familyId?: string;
  threadId?: string;
  epistemicStatus?: EpistemicStatus;
  contradictionState?: ClaimContradictionState;
  q?: string;
}

export interface ListSourcesInput extends PageInput {
  q?: string;
  domain?: string;
  sourceType?: string;
  extractionStatus?: string;
}

export interface ListEvidenceForClaimInput extends PageInput {
  claimId: string;
  stance?: EvidenceStance;
}

export interface ListClaimRelationsInput extends PageInput {
  claimId: string;
  direction?: 'from' | 'to' | 'either';
  relation?: ClaimRelationType;
}
