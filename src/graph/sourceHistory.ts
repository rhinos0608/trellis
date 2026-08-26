/**
 * Read-only derivation of source observation history from the event log.
 * Produces a chronological record of when a source was observed, changed,
 * and read — without any external state.
 */

import type { EventEnvelope } from '../store/eventTypes.js';
import type { ExtractionStatus } from './types.js';

export interface SourceObservationRecord {
  runId: string;
  observedAt: string;
  contentHash?: string;
  extractionStatus?: ExtractionStatus;
  changed: boolean;
}

export function getSourceObservationHistory(
  events: EventEnvelope[],
  sourceId: string,
): SourceObservationRecord[] {
  const relevant = events
    .filter((e) => (e.eventType === 'SOURCE_OBSERVED' || e.eventType === 'SOURCE_READ' || e.eventType === 'SOURCE_CHANGED') && (e.payload as Record<string, unknown>).sourceId === sourceId)
    .sort((a, b) => a.seq - b.seq);

  const records: SourceObservationRecord[] = [];
  let lastWasSourceChanged = false;

  for (const event of relevant) {
    if (event.eventType === 'SOURCE_CHANGED') {
      lastWasSourceChanged = true;
      continue;
    }

    if (event.eventType === 'SOURCE_OBSERVED') {
      const payload = event.payload as {
        runId: string;
        observedAt: string;
        contentHash?: string;
        extractionStatus?: ExtractionStatus;
      };
      records.push({
        runId: payload.runId,
        observedAt: payload.observedAt,
        ...(payload.contentHash !== undefined ? { contentHash: payload.contentHash } : {}),
        ...(payload.extractionStatus !== undefined ? { extractionStatus: payload.extractionStatus } : {}),
        changed: lastWasSourceChanged,
      });
      lastWasSourceChanged = false;
    }
    // SOURCE_READ events are filtered but don't produce records;
    // they reset the changed flag since they're not observations.
    if (event.eventType === 'SOURCE_READ') {
      lastWasSourceChanged = false;
    }
  }

  return records;
}
