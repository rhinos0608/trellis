/**
 * DTOs returned by the ResearchApplicationService.
 *
 * These are transport-independent shapes: the MCP adapter (or any future
 * transport) maps them onto its wire format. They never expose the raw
 * event envelope or internal payload details beyond what lifecycle
 * tracking needs.
 */

/**
 * Run summary. `listRuns` returns the narrow view (core fields + strategy);
 * `getRun` returns the full status view (progress, timestamps, counters).
 */
export interface RunSummaryDto {
  runId: string;
  familyId: string;
  status: string;
  query: string;
  // Full status view (getRun):
  progress?: { phase: string; percent?: number; message?: string } | undefined;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  failedAt?: string | undefined;
  cancelledAt?: string | undefined;
  lastError?: string | undefined;
  entityCount?: number | undefined;
  claimCount?: number | undefined;
  sourceCount?: number | undefined;
  evidenceCount?: number | undefined;
  // Narrow summary view (listRuns):
  strategy?: string | undefined;
}

/** Safe bounded lifecycle event — never the raw event envelope. */
export interface RunEventDto {
  seq: number;
  eventType: string;
  timestamp: string;
  /** Whitelisted subset of the lifecycle payload (see researchService). */
  payload: Record<string, unknown>;
}

export interface RunHistoryDto {
  runId: string;
  events: RunEventDto[];
}

export interface ListRunsInput {
  status?: string | undefined;
  familyId?: string | undefined;
  limit?: number | undefined;
  beforeSeq?: number | undefined;
}

export interface ListRunEventsInput {
  runId: string;
  afterSeq?: number | undefined;
  limit?: number | undefined;
}
