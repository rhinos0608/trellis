// owned by Worker 3 — entities, claims, evidence, contradictions, queries

export { graphEventHandlers } from './projectionHandlers.js';
export type {
  MergeCandidate,
  EntityResolutionOptions,
} from './entityResolution.js';
export {
  findMergeCandidates,
  mergeEntities,
  defaultThresholdForType,
} from './entityResolution.js';
export type {
  ClaimClusteringOptions,
  ClaimClusteringResult,
} from './claimClustering.js';
export { clusterClaims } from './claimClustering.js';
export type { PlannedClaimObservation } from './claimReconciler.js';
export { planClaimObservation } from './claimReconciler.js';
export { detectContradictions } from './contradictionDetection.js';
export type { ContradictionDetectionResult } from './contradictionDetection.js';
export { assessEvidenceAlignment } from './evidenceAlignment.js';
export type { AssessableFinding } from './evidenceAlignment.js';
export {
  getClaimsByFamily,
  getEvidenceForClaim,
  getContradictionsByFamily,
  getGapsByFamily,
  getEntityById,
  findEntityByLabel,
} from './queries.js';
