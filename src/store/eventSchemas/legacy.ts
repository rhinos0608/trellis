/**
 * Zod schemas for legacy extraction-lifecycle event types
 * ported from search-mcp that are not covered by graph/workspace/research.
 *
 * These have no call sites in the current Trellis codebase — the schemas
 * are permissive (`z.json()`) until concrete shapes are identified.
 */
import { z } from 'zod';

/** Legacy raw per-passage extraction — audit_only, not queryable. */
export const claimExtractedPayload = z.json();

/** Legacy extraction failure — audit_only. */
export const extractionFailedPayload = z.json();
