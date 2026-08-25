export interface KnowledgeReadModelStatus {
  version: number;
  lastAppliedSeq: number;
  status: 'ready' | 'dirty';
}
