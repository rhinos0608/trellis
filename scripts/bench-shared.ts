/**
 * Shared utilities for Trellis benchmark scripts.
 * Extracted from bench-projection.ts so both bench-projection and
 * bench-performance can reuse the event generator, weights, and handler
 * registry without duplicating code.
 *
 * bench-projection.ts imports from here — its CLI behavior is unchanged.
 */

import { graphEventHandlers } from '../src/graph/projectionHandlers.js';
import { workspaceEventHandlers } from '../src/workspace/projectionHandlers.js';
import type { NewEventInput, EventHandlerRegistry } from '../src/store/index.js';

// ── Constants ──────────────────────────────────────────────────────

export const BATCH_SIZE = 1_000;
export const DELTA_COUNT = 100;

// ── Merged handler registry ────────────────────────────────────────

export const handlers: EventHandlerRegistry = {
  ...graphEventHandlers,
  ...workspaceEventHandlers,
};

// ── Synthetic event generator ──────────────────────────────────────

export type WeightedType = { type: string; weight: number };

export const EVENT_WEIGHTS: WeightedType[] = [
  { type: 'NODE_ADDED', weight: 40 },
  { type: 'CLAIM_ACCEPTED', weight: 15 },
  { type: 'EDGE_ADDED', weight: 10 },
  { type: 'EVIDENCE_LINKED', weight: 10 },
  { type: 'SOURCE_ADDED', weight: 5 },
  { type: 'FAMILY_CREATED', weight: 5 },
  { type: 'FAMILY_CLASSIFIED', weight: 5 },
  { type: 'RUN_STARTED', weight: 5 },
  { type: 'RUN_COMPLETED', weight: 5 },
];

export const SECONDARY_WEIGHTS = EVENT_WEIGHTS.filter(({ type }) =>
  !['NODE_ADDED', 'CLAIM_ACCEPTED', 'SOURCE_ADDED', 'FAMILY_CREATED'].includes(type),
);

export function pickWeighted(rand: number, weights = EVENT_WEIGHTS): string {
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);
  let acc = 0;
  for (const w of weights) {
    acc += w.weight;
    if (rand < acc / totalWeight) return w.type;
  }
  return weights[0]!.type;
}

// Simple seeded PRNG (xorshift32) for deterministic-ish IDs without crypto overhead
let _seed = 123456789;
export function rand(): number {
  _seed ^= _seed << 13;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;
  return ((_seed >>> 0) / 4294967296);
}

export function id(prefix: string, idx: number): string {
  return `${prefix}-${idx}`;
}

/**
 * Generate `count` synthetic events with realistic payloads matching
 * the actual handler shapes. Events reference pre-built pools for
 * referential integrity (edges reference claims, evidence references
 * claims+sources, etc.).
 */
export function generateEvents(count: number, offset: number): NewEventInput[] {
  // Pre-build pools so cross-references work
  let availablePrerequisites = count;
  const familyCount = Math.min(Math.ceil(count * 0.05), availablePrerequisites);
  availablePrerequisites -= familyCount;
  const entityCount = Math.min(Math.ceil(count * 0.4), availablePrerequisites);
  availablePrerequisites -= entityCount;
  const sourceCount = Math.min(Math.ceil(count * 0.05), availablePrerequisites);
  availablePrerequisites -= sourceCount;
  const claimCount = Math.min(Math.ceil(count * 0.15), availablePrerequisites);

  const runId = `run-bench-${offset}`;
  const prerequisiteTypes = [
    ...Array.from({ length: familyCount }, () => 'FAMILY_CREATED'),
    ...Array.from({ length: entityCount }, () => 'NODE_ADDED'),
    ...Array.from({ length: sourceCount }, () => 'SOURCE_ADDED'),
    ...Array.from({ length: claimCount }, () => 'CLAIM_ACCEPTED'),
  ];
  const prerequisiteCount = Math.min(count, prerequisiteTypes.length);
  const remainingCount = Math.max(0, count - prerequisiteCount);
  const eventTypes = [
    ...prerequisiteTypes.slice(0, prerequisiteCount),
    ...Array.from({ length: Math.max(0, remainingCount) }, () => pickWeighted(rand(), SECONDARY_WEIGHTS)),
  ].slice(0, count);

  const events: NewEventInput[] = [];
  for (let i = 0; i < eventTypes.length; i++) {
    const idx = offset + i;
    const ts = new Date(Date.now() + idx).toISOString();
    const evType = eventTypes[i]!;

    let payload: unknown;
    let entityId: string | null = null;
    let entityType: string | null = null;

    switch (evType) {
      case 'NODE_ADDED': {
        const eid = id('ent', idx % entityCount);
        entityId = eid;
        entityType = 'entity';
        payload = {
          id: eid,
          label: `Entity ${idx % entityCount}`,
          canonicalLabel: null,
          entityType: 'protocol',
          aliases: [],
          extractionConfidence: 0.8,
          firstSeenRunId: runId,
          lastUpdatedRunId: runId,
          metadata: { source: 'bench' },
        };
        break;
      }
      case 'CLAIM_ACCEPTED': {
        const cid = id('claim', idx % claimCount);
        const fid = id('fam', idx % familyCount);
        entityId = cid;
        entityType = 'claim';
        payload = {
          id: cid,
          familyId: fid,
          subjectText: `Subject ${idx % claimCount}`,
          predicate: 'is_compatible_with',
          objectText: `Object ${idx}`,
          polarity: 'asserted',
          hedge: 'likely',
          evidenceType: 'study',
          confidence: 0.7,
          canonicalKey: { subject: `s-${idx % claimCount}`, predicate: 'compatible' },
          contradictionState: 'none',
          firstSeenRunId: runId,
          lastSeenRunId: runId,
        };
        break;
      }
      case 'EDGE_ADDED': {
        const fromId = id('claim', idx % claimCount);
        const toId = id('claim', (idx + 1) % claimCount);
        const eid = id('edge', idx);
        payload = {
          id: eid,
          fromClaimId: fromId,
          toClaimId: toId,
          relation: 'supports',
          strength: 'strong',
          score: 0.85,
          runId,
        };
        break;
      }
      case 'EVIDENCE_LINKED': {
        const claimId = id('claim', idx % claimCount);
        const sourceId = id('src', idx % sourceCount);
        payload = {
          id: id('ev', idx),
          claimId,
          sourceId,
          excerpt: `Evidence excerpt ${idx}`,
          runId,
        };
        break;
      }
      case 'SOURCE_ADDED': {
        const sid = id('src', idx % sourceCount);
        entityId = sid;
        entityType = 'source';
        payload = {
          id: sid,
          url: `https://example.com/doc/${idx % sourceCount}`,
          domain: 'example.com',
          sourceType: 'web',
          isPrimary: true,
          extractionStatus: 'extracted',
          contentHash: `hash-${idx % sourceCount}`,
          retrievedAt: ts,
          firstSeenRunId: runId,
        };
        break;
      }
      case 'FAMILY_CREATED': {
        const fid = id('fam', idx % familyCount);
        entityId = fid;
        entityType = 'family';
        payload = {
          family_id: fid,
          label: `Family ${idx % familyCount}`,
          description: `Bench family ${idx % familyCount}`,
        };
        break;
      }
      case 'FAMILY_CLASSIFIED': {
        const eid = id('ent', idx % entityCount);
        const fid = id('fam', idx % familyCount);
        payload = {
          entity_id: eid,
          family_id: fid,
          confidence: 0.9,
        };
        break;
      }
      case 'RUN_STARTED': {
        payload = { runId, familyId: id('fam', 0), query: 'bench query', strategy: 'pipeline' };
        break;
      }
      case 'RUN_COMPLETED': {
        payload = { runId, entityCount: 10, claimCount: 5 };
        break;
      }
      default: {
        payload = {};
      }
    }

    events.push({
      timestamp: ts,
      eventType: evType as NewEventInput['eventType'],
      eventVersion: 1,
      runId,
      batchId: `batch-${Math.floor(idx / BATCH_SIZE)}`,
      actor: 'system',
      entityId,
      entityType,
      payload,
    });
  }
  return events;
}

// ── Helpers ────────────────────────────────────────────────────────

export function tryGC(): boolean {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    return true;
  }
  return false;
}
