import { describe, it, expect } from 'vitest';
import { getSourceObservationHistory } from '../../src/graph/sourceHistory.js';
import type { EventEnvelope, SourceObservedPayload, SourceChangedPayload } from '../../src/store/eventTypes.js';

let seq = 0;

function makeEvent<T>(
  eventType: string,
  payload: T,
  sourceId?: string,
): EventEnvelope {
  seq += 1;
  return {
    seq,
    id: `evt_${seq}`,
    timestamp: '2025-01-01T00:00:00.000Z',
    eventType: eventType as any,
    eventVersion: 1,
    runId: 'run_test',
    batchId: null,
    actor: 'system',
    actorId: null,
    entityId: sourceId ?? (payload as any).sourceId ?? null,
    entityType: 'source',
    payloadHash: '',
    payload,
  };
}

function obs(sourceId: string, overrides?: Partial<SourceObservedPayload>): EventEnvelope {
  return makeEvent('SOURCE_OBSERVED', {
    sourceId,
    observedSourceId: `obs_${sourceId}`,
    canonicalUrl: 'https://example.com',
    url: 'https://example.com',
    domain: 'example.com',
    sourceType: 'web',
    isPrimary: false,
    extractionStatus: 'pending',
    runId: 'run_1',
    observedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }, sourceId);
}

function changed(sourceId: string): EventEnvelope {
  return makeEvent('SOURCE_CHANGED', {
    sourceId,
    oldContentHash: 'old_hash',
    newContentHash: 'new_hash',
  }, sourceId);
}

function read(sourceId: string): EventEnvelope {
  return makeEvent('SOURCE_READ', { sourceId }, sourceId);
}

describe('getSourceObservationHistory', () => {
  it('returns empty for unknown sourceId', () => {
    expect(getSourceObservationHistory([], 'unknown')).toEqual([]);
  });

  it('returns records for SOURCE_OBSERVED events', () => {
    const events = [obs('src_1'), obs('src_1', { runId: 'run_2', observedAt: '2025-01-02T00:00:00.000Z' })];
    const records = getSourceObservationHistory(events, 'src_1');
    expect(records).toHaveLength(2);
    expect(records[0]!.changed).toBe(false);
    expect(records[1]!.changed).toBe(false);
  });

  it('marks changed: true when preceded by SOURCE_CHANGED', () => {
    const events = [obs('src_1'), changed('src_1'), obs('src_1')];
    const records = getSourceObservationHistory(events, 'src_1');
    expect(records).toHaveLength(2);
    expect(records[0]!.changed).toBe(false);
    expect(records[1]!.changed).toBe(true);
  });

  it('excludes events for other sourceIds', () => {
    const events = [obs('src_1'), obs('src_2'), obs('src_1')];
    const records = getSourceObservationHistory(events, 'src_1');
    expect(records).toHaveLength(2);
  });

  it('SOURCE_READ resets changed flag', () => {
    const events = [obs('src_1'), changed('src_1'), read('src_1'), obs('src_1')];
    const records = getSourceObservationHistory(events, 'src_1');
    expect(records).toHaveLength(2);
    expect(records[0]!.changed).toBe(false);
    expect(records[1]!.changed).toBe(false);
  });

  it('sorts by seq even if events arrive out of order', () => {
    const e1 = obs('src_1');
    e1.seq = 5;
    const e2 = obs('src_1');
    e2.seq = 2;
    const records = getSourceObservationHistory([e1, e2], 'src_1');
    expect(records[0]!.runId).toBe('run_1');
    expect(records[1]!.runId).toBe('run_1');
  });

  it('includes contentHash and extractionStatus when present', () => {
    const events = [obs('src_1', { contentHash: 'abc123', extractionStatus: 'extracted' })];
    const records = getSourceObservationHistory(events, 'src_1');
    expect(records[0]!.contentHash).toBe('abc123');
    expect(records[0]!.extractionStatus).toBe('extracted');
  });

  it('handles multiple SOURCE_CHANGED in a row before an observation', () => {
    const events = [obs('src_1'), changed('src_1'), changed('src_1'), obs('src_1')];
    const records = getSourceObservationHistory(events, 'src_1');
    expect(records).toHaveLength(2);
    expect(records[1]!.changed).toBe(true);
  });
});
