import { z } from 'zod';
import { MAX_SEARCH_QUERY_LENGTH } from '../query/cursor.js';

const optionalString = z.string().min(1).optional();
const researchDepth = z.enum(['quick', 'standard', 'deep', 'exhaustive', 'tree']);
export const startRunSchema = z.strictObject({ query: z.string().min(1), strategy: z.enum(['agent', 'pipeline']).optional(), depth: researchDepth.optional(), sessionId: optionalString, threadId: optionalString, familyId: optionalString, idempotencyKey: optionalString, deadlineMs: z.number().int().positive().optional() });
export const retryRunSchema = z.strictObject({ idempotencyKey: optionalString, deadlineMs: z.number().int().positive().optional() });
export const continueSchema = z.strictObject({ depth: z.enum(['quick', 'standard']).optional(), idempotencyKey: optionalString });
const page = { cursor: z.string().min(1).optional(), limit: z.coerce.number().int().positive().max(100).optional() };
export const runsQuerySchema = z.strictObject({ status: optionalString, familyId: optionalString, beforeSeq: z.coerce.number().int().positive().optional(), ...page });
export const claimsQuerySchema = z.strictObject({ familyId: optionalString, threadId: optionalString, epistemicStatus: optionalString, contradictionState: optionalString, q: z.string().max(MAX_SEARCH_QUERY_LENGTH).optional(), ...page });
export const sourcesQuerySchema = z.strictObject({ q: z.string().max(MAX_SEARCH_QUERY_LENGTH).optional(), domain: optionalString, sourceType: optionalString, extractionStatus: optionalString, ...page });
export const observationsQuerySchema = z.strictObject({ ...page });
export const evidenceQuerySchema = z.strictObject({ stance: optionalString, ...page });
export const relationsQuerySchema = z.strictObject({ direction: z.enum(['from', 'to', 'either']).optional(), relation: optionalString, ...page });
export const eventQuerySchema = z.strictObject({ afterSeq: z.coerce.number().int().nonnegative().optional() });
export type StartRunBody = z.infer<typeof startRunSchema>;
