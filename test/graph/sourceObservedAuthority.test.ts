import { describe, it, expect } from 'vitest';
import { graphEventHandlers } from '../../src/graph/projectionHandlers.js';
import { createEmptyProjectionState } from '../../src/store/projectionState.js';
import type { EventEnvelope, SourceObservedPayload } from '../../src/store/eventTypes.js';

const handleSourceObserved = graphEventHandlers.SOURCE_OBSERVED!;

let seq = 0;

function makeSourceObservedEvent(
  overrides: Partial<SourceObservedPayload> & { sourceId: string },
): EventEnvelope<SourceObservedPayload> {
  seq += 1;
  return {
    seq,
    id: `evt_${seq}`,
    timestamp: '2025-01-01T00:00:00.000Z',
    eventType: 'SOURCE_OBSERVED',
    eventVersion: 1,
    runId: 'run_test',
    batchId: null,
    actor: 'system',
    actorId: null,
    entityId: overrides.sourceId,
    entityType: 'source',
    payloadHash: '',
    payload: {
      observedSourceId: 'obs_1',
      canonicalUrl: overrides.url ?? 'https://example.com',
      url: overrides.url ?? 'https://example.com',
      domain: overrides.domain ?? 'example.com',
      sourceType: overrides.sourceType ?? 'web',
      isPrimary: false,
      extractionStatus: 'pending',
      runId: 'run_test',
      observedAt: '2025-01-01T00:00:00.000Z',
      ...overrides,
    },
  };
}

describe('handleSourceObserved authorityClass derivation', () => {
  it('sets authorityClass when payload has none', () => {
    const state = createEmptyProjectionState();
    const event = makeSourceObservedEvent({
      sourceId: 'src_1',
      url: 'https://en.wikipedia.org/wiki/Test',
      domain: 'wikipedia.org',
      sourceType: 'wikipedia',
    });
    handleSourceObserved(event, state);
    const source = state.sources.get('src_1')!;
    expect(source).toBeDefined();
    expect(source.authorityClass).toBe('encyclopedia');
  });

  it('does not overwrite explicit payload authorityClass', () => {
    const state = createEmptyProjectionState();
    const event = makeSourceObservedEvent({
      sourceId: 'src_2',
      url: 'https://example.com',
      domain: 'example.com',
      sourceType: 'web',
      authorityClass: 'official_spec',
    });
    handleSourceObserved(event, state);
    expect(state.sources.get('src_2')!.authorityClass).toBe('official_spec');
  });

  it('backfills authorityClass on existing source that lacks one', () => {
    const state = createEmptyProjectionState();
    // First event: no authorityClass in payload
    const event1 = makeSourceObservedEvent({
      sourceId: 'src_3',
      url: 'https://www.reddit.com/r/react',
      domain: 'reddit.com',
      sourceType: 'reddit',
    });
    handleSourceObserved(event1, state);
    expect(state.sources.get('src_3')!.authorityClass).toBe('forum_social');

    // Second event for same source: still no authorityClass in payload — should be set
    const event2 = makeSourceObservedEvent({
      sourceId: 'src_3',
      url: 'https://www.reddit.com/r/react',
      domain: 'reddit.com',
      sourceType: 'reddit',
    });
    handleSourceObserved(event2, state);
    expect(state.sources.get('src_3')!.authorityClass).toBe('forum_social');
  });

  it('does not overwrite existing source authorityClass on re-observation', () => {
    const state = createEmptyProjectionState();
    const event1 = makeSourceObservedEvent({
      sourceId: 'src_4',
      url: 'https://github.com/user/repo',
      domain: 'github.com',
      sourceType: 'github',
      authorityClass: 'vendor_sdk_docs',
    });
    handleSourceObserved(event1, state);
    expect(state.sources.get('src_4')!.authorityClass).toBe('vendor_sdk_docs');

    // Re-observe without authorityClass — should keep original
    const event2 = makeSourceObservedEvent({
      sourceId: 'src_4',
      url: 'https://github.com/user/repo',
      domain: 'github.com',
      sourceType: 'github',
    });
    handleSourceObserved(event2, state);
    expect(state.sources.get('src_4')!.authorityClass).toBe('vendor_sdk_docs');
  });
});
