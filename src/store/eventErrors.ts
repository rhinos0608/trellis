/**
 * Typed error classes for event payload validation.
 *
 * Each error carries structured context for diagnostics but NEVER
 * embeds raw payload content (potentially large/sensitive).
 */

export type EventErrorCode =
  | 'EVENT_TYPE_UNKNOWN'
  | 'EVENT_VERSION_UNSUPPORTED'
  | 'EVENT_PAYLOAD_INVALID'
  | 'EVENT_REFERENCE_INVALID'
  | 'STALE_PROJECTION';

export class StaleProjectionError extends Error {
  readonly code: EventErrorCode = 'STALE_PROJECTION';
  constructor(readonly expected: number, readonly actual: number | null) {
    super(`Stale projection: expected seq ${String(expected)}, actual ${String(actual ?? 0)}`);
    this.name = 'StaleProjectionError';
  }
}

export class EventReferenceInvalidError extends Error {
  readonly code: EventErrorCode = 'EVENT_REFERENCE_INVALID';
  constructor(readonly eventType: string, readonly reference: string) {
    super(`Invalid reference for ${eventType}: ${reference}`);
    this.name = 'EventReferenceInvalidError';
  }
}

export class EventTypeUnknownError extends Error {
  readonly code: EventErrorCode = 'EVENT_TYPE_UNKNOWN';
  readonly eventType: string;

  constructor(eventType: string) {
    super(`Unknown event type: ${eventType}`);
    this.name = 'EventTypeUnknownError';
    this.eventType = eventType;
  }
}

export class EventVersionUnsupportedError extends Error {
  readonly code: EventErrorCode = 'EVENT_VERSION_UNSUPPORTED';
  readonly eventType: string;
  readonly storedVersion: number;
  readonly latestVersion: number;

  constructor(eventType: string, storedVersion: number, latestVersion: number) {
    super(
      `Unsupported version ${String(storedVersion)} for event type ${eventType} (latest: ${String(latestVersion)})`,
    );
    this.name = 'EventVersionUnsupportedError';
    this.eventType = eventType;
    this.storedVersion = storedVersion;
    this.latestVersion = latestVersion;
  }
}

export interface ZodIssueSummary {
  path: string;
  message: string;
}

export class EventPayloadInvalidError extends Error {
  readonly code: EventErrorCode = 'EVENT_PAYLOAD_INVALID';
  readonly eventType: string;
  readonly storedVersion: number;
  readonly zodIssues: ZodIssueSummary[];

  constructor(
    eventType: string,
    storedVersion: number,
    issues: ZodIssueSummary[],
  ) {
    super(
      `Invalid payload for ${eventType} v${String(storedVersion)}: ${String(issues.length)} validation issue(s)`,
    );
    this.name = 'EventPayloadInvalidError';
    this.eventType = eventType;
    this.storedVersion = storedVersion;
    this.zodIssues = issues;
  }
}
