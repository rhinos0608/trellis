import { describe, it, expect } from 'vitest';
import { ROLLBACK_CLASS } from '../../src/store/eventTypes.js';
import { EVENT_CODECS } from '../../src/store/eventSchemas/registry.js';
import { decodeEventPayload } from '../../src/store/eventValidation.js';
import {
  EventTypeUnknownError,
  EventVersionUnsupportedError,
  EventPayloadInvalidError,
} from '../../src/store/eventErrors.js';
import { jsonValue } from '../../src/store/eventSchemas/common.js';

// ── Registry integrity ────────────────────────────────────────────────

describe('EVENT_CODECS registry integrity', () => {
  it('has an entry for every key in ROLLBACK_CLASS (covers all event types)', () => {
    for (const eventType of Object.keys(ROLLBACK_CLASS)) {
      expect(
        EVENT_CODECS,
        `Missing EVENT_CODECS entry for ${eventType}`,
      ).toHaveProperty(eventType);
    }
  });

  it('has an entry for every TrellisEventType union member', () => {
    // Belt-and-suspenders: check actual count matches union size
    const legacyTypes = [
      'RUN_STARTED', 'RUN_COMPLETED', 'RUN_FAILED', 'PROJECTION_REBUILT',
      'NODE_ADDED', 'NODE_RELABELED', 'NODE_METADATA_UPDATED',
      'EXTRACTION_CONFIDENCE_REVISED', 'EDGE_ADDED', 'EDGE_REMOVED',
      'RELATIONSHIP_STRENGTH_REVISED', 'CONTRADICTION_FLAGGED',
      'ENTITY_MERGED', 'ENTITY_SPLIT', 'CLAIM_EXTRACTED', 'EXTRACTION_FAILED',
      'SOURCE_ADDED', 'SOURCE_CHANGED', 'SOURCE_RETRACTED',
      'FAMILY_CLASSIFIED', 'FAMILY_CREATED', 'FAMILY_RELATED',
      'FAMILY_RELATION_REMOVED', 'FAMILY_RENAMED', 'FAMILY_MERGED',
      'RUN_ROLLED_BACK',
    ];
    const newTypes = [
      'FAMILY_RESOLVED', 'THREAD_CREATED', 'THREAD_RESOLVED',
      'SOURCE_READ', 'CLAIM_ACCEPTED', 'EVIDENCE_LINKED',
      'CONTRADICTION_IDENTIFIED', 'CONTRADICTION_RESOLVED',
      'GAP_OPENED', 'GAP_RESOLVED', 'SYNTHESIS_COMPLETED', 'RUN_CANCELLED',
      'RUN_QUEUED', 'RUN_STARTING', 'RUN_RUNNING', 'RUN_PROGRESS',
      'RUN_HEARTBEAT', 'RUN_CANCELLATION_REQUESTED', 'RUN_INTERRUPTED',
      'CLAIM_MERGED', 'CLAIM_SPLIT', 'CLAIM_RETRACTION_SET',
      'CLAIM_RELATION_CURATED', 'EVIDENCE_STANCE_OVERRIDDEN',
    ];
    const all = [...legacyTypes, ...newTypes];
    expect(all.length).toBe(50);
    for (const t of all) {
      expect(EVENT_CODECS, `Missing: ${t}`).toHaveProperty(t);
    }
  });

  it('versions are contiguous from 1 through latestVersion for every codec', () => {
    for (const [eventType, codec] of Object.entries(EVENT_CODECS)) {
      for (let v = 1; v <= codec.latestVersion; v++) {
        expect(
          codec.versions,
          `${eventType} missing version ${v}`,
        ).toHaveProperty(String(v));
      }
      // No extra versions beyond latestVersion
      const versionKeys = Object.keys(codec.versions).map(Number);
      expect(
        versionKeys.every((k) => k >= 1 && k <= codec.latestVersion),
        `${eventType} has out-of-range version`,
      ).toBe(true);
    }
  });

  it('every version < latestVersion has upcast; latestVersion does not require one', () => {
    for (const [eventType, codec] of Object.entries(EVENT_CODECS)) {
      for (let v = 1; v < codec.latestVersion; v++) {
        expect(
          codec.versions[v]!.upcast,
          `${eventType} v${v} (non-latest) missing upcast`,
        ).toBeDefined();
      }
      // latestVersion: no assertion needed (may or may not have upcast)
    }
  });
});

// ── decodeEventPayload error paths ────────────────────────────────────

describe('decodeEventPayload — error paths', () => {
  it('rejects unknown event type with EVENT_TYPE_UNKNOWN', () => {
    expect(() => decodeEventPayload('NONEXISTENT_EVENT', 1, {})).toThrow(
      EventTypeUnknownError,
    );
    try {
      decodeEventPayload('NONEXISTENT_EVENT', 1, {});
    } catch (e) {
      expect(e).toBeInstanceOf(EventTypeUnknownError);
      expect((e as EventTypeUnknownError).eventType).toBe('NONEXISTENT_EVENT');
      expect((e as EventTypeUnknownError).code).toBe('EVENT_TYPE_UNKNOWN');
    }
  });

  it('rejects valid event type with unregistered version (99) with EVENT_VERSION_UNSUPPORTED', () => {
    expect(() => decodeEventPayload('NODE_ADDED', 99, {})).toThrow(
      EventVersionUnsupportedError,
    );
    try {
      decodeEventPayload('NODE_ADDED', 99, {});
    } catch (e) {
      expect(e).toBeInstanceOf(EventVersionUnsupportedError);
      expect((e as EventVersionUnsupportedError).storedVersion).toBe(99);
      expect((e as EventVersionUnsupportedError).latestVersion).toBe(1);
      expect((e as EventVersionUnsupportedError).code).toBe('EVENT_VERSION_UNSUPPORTED');
    }
  });
});

// ── Valid payloads — 10+ event types across all domains ───────────────

describe('decodeEventPayload — valid payloads', () => {
  // 1. NODE_ADDED (graph)
  it('accepts a valid NODE_ADDED payload', () => {
    const result = decodeEventPayload('NODE_ADDED', 1, {
      id: 'e1',
      label: 'React',
      canonicalLabel: null,
      entityType: 'package',
      aliases: ['reactjs'],
      extractionConfidence: 0.9,
      firstSeenRunId: 'run-1',
      lastUpdatedRunId: 'run-1',
      metadata: {},
    });
    expect(result.eventType).toBe('NODE_ADDED');
    expect(result.storedVersion).toBe(1);
    expect(result.latestVersion).toBe(1);
    expect((result.payload as { id: string }).id).toBe('e1');
  });

  // 2. CLAIM_ACCEPTED (graph — from runService.ts call site)
  it('accepts a valid CLAIM_ACCEPTED payload', () => {
    const result = decodeEventPayload('CLAIM_ACCEPTED', 1, {
      id: 'clm_f1',
      familyId: 'fam-1',
      subjectText: 'React 19 improves performance',
      predicate: 'improves performance',
      polarity: 'asserted',
      hedge: 'certain',
      evidenceType: 'study',
      confidence: 0.9,
      canonicalKey: { subject: 'React 19', predicate: 'improves performance' },
      contradictionState: 'none',
      firstSeenRunId: 'run-1',
      lastSeenRunId: 'run-1',
    });
    expect(result.eventType).toBe('CLAIM_ACCEPTED');
    expect((result.payload as { id: string }).id).toBe('clm_f1');
  });

  // 3. EVIDENCE_LINKED (graph — from runService.ts call site)
  it('accepts a valid EVIDENCE_LINKED payload', () => {
    const result = decodeEventPayload('EVIDENCE_LINKED', 1, {
      id: 'evd_f1_src1',
      claimId: 'clm_f1',
      sourceId: 'src-1',
      excerpt: 'test evidence',
      runId: 'run-1',
    });
    expect(result.eventType).toBe('EVIDENCE_LINKED');
  });

  // 4. EDGE_ADDED (graph — from runService.ts call site)
  it('accepts a valid EDGE_ADDED payload', () => {
    const result = decodeEventPayload('EDGE_ADDED', 1, {
      id: 'rel_c1_c2_supports',
      fromClaimId: 'c1',
      toClaimId: 'c2',
      relation: 'supports',
      strength: 'strong',
      score: 0.9,
      runId: 'run-1',
    });
    expect(result.eventType).toBe('EDGE_ADDED');
  });

  // 5. FAMILY_CREATED (workspace — snake_case family_id)
  it('accepts a valid FAMILY_CREATED payload', () => {
    const result = decodeEventPayload('FAMILY_CREATED', 1, {
      family_id: 'fam-1',
      label: 'React Performance',
      description: 'Research on React perf',
    });
    expect(result.eventType).toBe('FAMILY_CREATED');
    expect((result.payload as { family_id: string }).family_id).toBe('fam-1');
  });

  // 6. FAMILY_RESOLVED (workspace — from runService.ts call site)
  it('accepts a valid FAMILY_RESOLVED payload', () => {
    const result = decodeEventPayload('FAMILY_RESOLVED', 1, {
      familyId: 'fam-1',
      query: 'React performance',
      isNew: false,
      score: 0.85,
      method: 'lexical_manifest_overlap',
    });
    expect(result.eventType).toBe('FAMILY_RESOLVED');
  });

  // 7. THREAD_CREATED (workspace — from projectionHandlers.ts)
  it('accepts a valid THREAD_CREATED payload', () => {
    const result = decodeEventPayload('THREAD_CREATED', 1, {
      threadId: 'thr-1',
      familyId: 'fam-1',
      label: 'Benchmarks',
      description: 'Performance benchmarks',
    });
    expect(result.eventType).toBe('THREAD_CREATED');
  });

  // 8. RUN_STARTED (research — from runService.ts call site)
  it('accepts legacy RUN_QUEUED payload without follow-up metadata', () => {
    const result = decodeEventPayload('RUN_QUEUED', 1, {
      runId: 'r1', rootRunId: 'r1', familyId: 'f1', query: 'q', strategy: 'agent', depth: 'standard',
      providerName: 'provider', requestHash: 'hash', retryPolicy: { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1, maxBackoffMs: 2 },
      deadlineAt: '2024-01-01T00:00:00Z', attempt: 1, queuedAt: '2024-01-01T00:00:00Z',
    });
    expect(result.eventType).toBe('RUN_QUEUED');
  });

  it('accepts RUN_QUEUED follow-up metadata', () => {
    const result = decodeEventPayload('RUN_QUEUED', 1, {
      runId: 'r1', rootRunId: 'r1', familyId: 'f1', query: 'q', strategy: 'agent', depth: 'standard',
      providerName: 'provider', requestHash: 'hash', retryPolicy: { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1, maxBackoffMs: 2 },
      deadlineAt: '2024-01-01T00:00:00Z', attempt: 1, queuedAt: '2024-01-01T00:00:00Z',
      followUp: { kind: 'information_gain_v1', targetType: 'gap', targetId: 'g1', sourceRunId: 'source' },
    });
    expect(result.eventType).toBe('RUN_QUEUED');
  });

  it('accepts a valid RUN_STARTED payload', () => {
    const result = decodeEventPayload('RUN_STARTED', 1, {
      runId: 'run_abc123',
      familyId: 'fam-1',
      query: 'React benchmarks',
      strategy: 'agent',
      topic: 'React',
      threadId: 'thr-1',
      sessionId: 'sess-1',
    });
    expect(result.eventType).toBe('RUN_STARTED');
    expect((result.payload as { runId: string }).runId).toBe('run_abc123');
  });

  // 9. RUN_COMPLETED (research — from runService.ts call site)
  it('accepts a valid RUN_COMPLETED payload', () => {
    const result = decodeEventPayload('RUN_COMPLETED', 1, {
      runId: 'run_abc123',
      claimCount: 5,
      sourceCount: 3,
      evidenceCount: 8,
      artifactPaths: ['/tmp/report.md'],
    });
    expect(result.eventType).toBe('RUN_COMPLETED');
  });

  // 10. RUN_FAILED (research — from runService.ts call site)
  it('accepts a valid RUN_FAILED payload', () => {
    const result = decodeEventPayload('RUN_FAILED', 1, {
      runId: 'run_abc123',
      error: 'Provider timeout',
    });
    expect(result.eventType).toBe('RUN_FAILED');
  });

  // 11. ENTITY_MERGED (graph — from rollback.ts call site)
  it('accepts a valid ENTITY_MERGED payload', () => {
    const result = decodeEventPayload('ENTITY_MERGED', 1, {
      survivorId: 'e1',
      mergedIds: ['e2', 'e3'],
      mergedSnapshots: [
        {
          id: 'e2',
          label: 'React.js',
          aliases: ['react-js'],
          metadata: { extra: true },
          claimIds: [],
          evidenceIds: [],
        },
        {
          id: 'e3',
          label: 'ReactJS',
          aliases: [],
          metadata: {},
          claimIds: ['c1'],
          evidenceIds: ['ev1'],
        },
      ],
    });
    expect(result.eventType).toBe('ENTITY_MERGED');
  });

  // 12. CONTRADICTION_IDENTIFIED (graph — from runService.ts call site)
  it('accepts a valid CONTRADICTION_IDENTIFIED payload', () => {
    const result = decodeEventPayload('CONTRADICTION_IDENTIFIED', 1, {
      id: 'con_ic1',
      familyId: 'fam-1',
      claimIdA: 'c1',
      claimIdB: 'c2',
      contradictionType: 'factual_disagreement',
      resolutionStatus: 'unresolved',
      likelyExplanation: 'Different benchmark conditions',
      firstSeenRunId: 'run-1',
    });
    expect(result.eventType).toBe('CONTRADICTION_IDENTIFIED');
  });

  // 13. GAP_OPENED (graph — from runService.ts call site)
  it('accepts a valid GAP_OPENED payload', () => {
    const result = decodeEventPayload('GAP_OPENED', 1, {
      id: 'gap_g1',
      familyId: 'fam-1',
      question: 'What about edge cases?',
      category: 'unanswered_sub_question',
      status: 'open',
      priority: 1,
      firstSeenRunId: 'run-1',
    });
    expect(result.eventType).toBe('GAP_OPENED');
  });

  // 14. RUN_ROLLED_BACK (research — from rollback.ts call site)
  it('accepts a valid RUN_ROLLED_BACK payload', () => {
    const result = decodeEventPayload('RUN_ROLLED_BACK', 1, {
      run_id: 'run_abc123',
    });
    expect(result.eventType).toBe('RUN_ROLLED_BACK');
  });

  // 15. CONTRADICTION_FLAGGED (legacy — permissive z.json())
  it('accepts any payload for legacy CONTRADICTION_FLAGGED', () => {
    const result = decodeEventPayload('CONTRADICTION_FLAGGED', 1, {
      anything: 'goes',
      nested: [1, 2, 3],
    });
    expect(result.eventType).toBe('CONTRADICTION_FLAGGED');
  });
});

// ── Invalid payloads — 5+ event types ────────────────────────────────

describe('decodeEventPayload — invalid payloads', () => {
  it('rejects malformed RUN_QUEUED follow-up metadata', () => {
    expect(() => decodeEventPayload('RUN_QUEUED', 1, {
      runId: 'r1', rootRunId: 'r1', familyId: 'f1', query: 'q', strategy: 'agent', depth: 'standard',
      providerName: 'provider', requestHash: 'hash', retryPolicy: { maxAttempts: 3, autoRetry: false, initialBackoffMs: 1, maxBackoffMs: 2 },
      deadlineAt: '2024-01-01T00:00:00Z', attempt: 1, queuedAt: '2024-01-01T00:00:00Z',
      followUp: { kind: 'wrong', targetType: 'gap', targetId: 'g1', sourceRunId: 'source' },
    })).toThrow(EventPayloadInvalidError);
  });

  it('rejects NODE_ADDED with wrong type for id', () => {
    expect(() =>
      decodeEventPayload('NODE_ADDED', 1, {
        id: 123, // should be string
        label: 'React',
        canonicalLabel: null,
        entityType: 'package',
        aliases: [],
        extractionConfidence: 0.9,
        firstSeenRunId: 'run-1',
        lastUpdatedRunId: 'run-1',
        metadata: {},
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('rejects CLAIM_ACCEPTED missing required field', () => {
    expect(() =>
      decodeEventPayload('CLAIM_ACCEPTED', 1, {
        id: 'clm_1',
        familyId: 'fam-1',
        // missing subjectText, predicate, polarity, etc.
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('rejects RUN_COMPLETED with wrong type for claimCount', () => {
    expect(() =>
      decodeEventPayload('RUN_COMPLETED', 1, {
        runId: 'run-1',
        claimCount: 'five', // should be number
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('rejects FAMILY_CREATED with wrong type for family_id', () => {
    expect(() =>
      decodeEventPayload('FAMILY_CREATED', 1, {
        family_id: 42, // should be string
        label: 'Test',
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('rejects EDGE_ADDED with invalid relation enum value', () => {
    expect(() =>
      decodeEventPayload('EDGE_ADDED', 1, {
        id: 'rel_1',
        fromClaimId: 'c1',
        toClaimId: 'c2',
        relation: 'invalid_relation', // not a valid enum
        strength: 'strong',
        score: 0.9,
        runId: 'run-1',
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('structured Zod issues are accessible on EventPayloadInvalidError', () => {
    try {
      decodeEventPayload('NODE_ADDED', 1, {
        id: 123,
        label: 'React',
        canonicalLabel: null,
        entityType: 'package',
        aliases: [],
        extractionConfidence: 0.9,
        firstSeenRunId: 'run-1',
        lastUpdatedRunId: 'run-1',
        metadata: {},
      });
      expect.fail('Should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EventPayloadInvalidError);
      const err = e as EventPayloadInvalidError;
      expect(err.code).toBe('EVENT_PAYLOAD_INVALID');
      expect(err.eventType).toBe('NODE_ADDED');
      expect(err.storedVersion).toBe(1);
      expect(err.zodIssues.length).toBeGreaterThan(0);
      expect(err.zodIssues[0]!.path).toBeDefined();
      expect(err.zodIssues[0]!.message).toBeDefined();
      // Must NOT contain the raw payload in the message
      expect(err.message).not.toContain('123');
    }
  });
});

// ── Recursive JSON-value schema ───────────────────────────────────────

describe('jsonValue schema (recursive)', () => {
  it('accepts nested objects and arrays', () => {
    const val = {
      str: 'hello',
      num: 42,
      bool: true,
      nil: null,
      arr: [1, 'two', { nested: true }],
      obj: { deep: { deeper: [null, false, 3.14] } },
    };
    expect(jsonValue.parse(val)).toEqual(val);
  });

  it('rejects a function nested inside an object', () => {
    expect(() => jsonValue.parse({ bad: () => {} })).toThrow();
  });

  it('rejects a function nested inside an array', () => {
    expect(() => jsonValue.parse([1, () => {}])).toThrow();
  });

  it('rejects undefined nested inside an object', () => {
    expect(() => jsonValue.parse({ bad: undefined })).toThrow();
  });

  it('rejects undefined nested inside an array', () => {
    expect(() => jsonValue.parse([undefined])).toThrow();
  });

  it('accepts a bare string', () => {
    expect(jsonValue.parse('hello')).toBe('hello');
  });

  it('accepts a bare number', () => {
    expect(jsonValue.parse(42)).toBe(42);
  });

  it('accepts a bare null', () => {
    expect(jsonValue.parse(null)).toBeNull();
  });
});

// ── Fix 1: FAMILY_MERGED required fields ─────────────────────────────

describe('Fix 1: FAMILY_MERGED schema requires mergedSnapshots + reattributedEntityIds', () => {
  it('rejects payload missing mergedSnapshots', () => {
    expect(() =>
      decodeEventPayload('FAMILY_MERGED', 1, {
        survivorFamilyId: 'fam-1',
        mergedFamilyIds: ['fam-2'],
        reattributedEntityIds: [],
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('rejects payload missing reattributedEntityIds', () => {
    expect(() =>
      decodeEventPayload('FAMILY_MERGED', 1, {
        survivorFamilyId: 'fam-1',
        mergedFamilyIds: ['fam-2'],
        mergedSnapshots: [{ id: 'fam-2', label: 'Merged' }],
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('accepts payload with both fields present', () => {
    const result = decodeEventPayload('FAMILY_MERGED', 1, {
      survivorFamilyId: 'fam-1',
      mergedFamilyIds: ['fam-2'],
      mergedSnapshots: [{ id: 'fam-2', label: 'Merged' }],
      reattributedEntityIds: ['ent-1'],
    });
    expect(result.eventType).toBe('FAMILY_MERGED');
  });
});

// ── Fix 2: FAMILY_RELATION_REMOVED rollback payload ──────────────────

describe('Fix 2: compensating FAMILY_RELATED payload', () => {
  it('accepts a realistic compensating FAMILY_RELATED payload with relation_type', () => {
    const result = decodeEventPayload('FAMILY_RELATED', 1, {
      relation_id: 'rollback-rel-1',
      family_a: 'fam-1',
      family_b: 'fam-2',
      relation_type: 'adjacent',
    });
    expect(result.eventType).toBe('FAMILY_RELATED');
  });

  it('rejects a FAMILY_RELATED payload with bogus relation_type', () => {
    expect(() =>
      decodeEventPayload('FAMILY_RELATED', 1, {
        relation_id: 'rel-1',
        family_a: 'fam-1',
        family_b: 'fam-2',
        relation_type: 'not_a_real_type',
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('accepts FAMILY_RELATION_REMOVED with relation_type', () => {
    const result = decodeEventPayload('FAMILY_RELATION_REMOVED', 1, {
      family_a: 'fam-1',
      family_b: 'fam-2',
      relation_type: 'contradicts',
    });
    expect(result.eventType).toBe('FAMILY_RELATION_REMOVED');
  });

  it('rejects FAMILY_RELATION_REMOVED without relation_type', () => {
    expect(() =>
      decodeEventPayload('FAMILY_RELATION_REMOVED', 1, {
        family_a: 'fam-1',
        family_b: 'fam-2',
      }),
    ).toThrow(EventPayloadInvalidError);
  });
});

// ── Fix 3: enum tightening ───────────────────────────────────────────

describe('Fix 3: tightened enum fields reject bogus strings', () => {
  it('RUN_STARTED strategy: accepts valid enum, rejects bogus', () => {
    const valid = decodeEventPayload('RUN_STARTED', 1, {
      runId: 'r1', familyId: 'f1', query: 'test', strategy: 'agent',
    });
    expect(valid.eventType).toBe('RUN_STARTED');
    expect(() =>
      decodeEventPayload('RUN_STARTED', 1, {
        runId: 'r1', familyId: 'f1', query: 'test', strategy: 'bogus',
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('FAMILY_RELATED relation_type: accepts valid enum, rejects bogus', () => {
    const valid = decodeEventPayload('FAMILY_RELATED', 1, {
      relation_id: 'r1', family_a: 'f1', family_b: 'f2', relation_type: 'supersedes',
    });
    expect(valid.eventType).toBe('FAMILY_RELATED');
    expect(() =>
      decodeEventPayload('FAMILY_RELATED', 1, {
        relation_id: 'r1', family_a: 'f1', family_b: 'f2', relation_type: 'bogus',
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('CONTRADICTION_RESOLVED status: accepts valid enum, rejects bogus', () => {
    const valid = decodeEventPayload('CONTRADICTION_RESOLVED', 1, {
      contradictionId: 'c1', previousStatus: 'unresolved', newStatus: 'resolved',
    });
    expect(valid.eventType).toBe('CONTRADICTION_RESOLVED');
    expect(() =>
      decodeEventPayload('CONTRADICTION_RESOLVED', 1, {
        contradictionId: 'c1', previousStatus: 'unresolved', newStatus: 'bogus',
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('GAP_RESOLVED status: accepts valid enum, rejects bogus', () => {
    const valid = decodeEventPayload('GAP_RESOLVED', 1, {
      gapId: 'g1', previousStatus: 'open', newStatus: 'resolved',
    });
    expect(valid.eventType).toBe('GAP_RESOLVED');
    expect(() =>
      decodeEventPayload('GAP_RESOLVED', 1, {
        gapId: 'g1', previousStatus: 'open', newStatus: 'bogus',
      }),
    ).toThrow(EventPayloadInvalidError);
  });

  it('SOURCE_ADDED sourceType: accepts valid enum, rejects bogus', () => {
    const valid = decodeEventPayload('SOURCE_ADDED', 1, {
      id: 's1', url: 'https://example.com', domain: 'example.com',
      sourceType: 'academic', isPrimary: true, extractionStatus: 'pending',
      contentHash: 'abc', retrievedAt: '2024-01-01T00:00:00Z', firstSeenRunId: 'r1',
    });
    expect(valid.eventType).toBe('SOURCE_ADDED');
    expect(() =>
      decodeEventPayload('SOURCE_ADDED', 1, {
        id: 's1', url: 'https://example.com', domain: 'example.com',
        sourceType: 'bogus', isPrimary: true, extractionStatus: 'pending',
        contentHash: 'abc', retrievedAt: '2024-01-01T00:00:00Z', firstSeenRunId: 'r1',
      }),
    ).toThrow(EventPayloadInvalidError);
  });
});

// ── Upcast success path ─────────────────────────────────────────────

describe('decodeEventPayload — upcast success', () => {
  it('applies upcast chain and returns transformed payload', () => {
    const fakeType = 'NODE_ADDED' as const;
    const originalCodec = EVENT_CODECS[fakeType];

    const baseSchema = originalCodec.versions[1]!.schema;
    const fakeCodec = {
      latestVersion: 2,
      versions: {
        1: {
          schema: baseSchema,
          upcast: (payload: unknown) => {
            const p = payload as Record<string, unknown>;
            return { ...p, label: (p.label as string).toUpperCase() };
          },
        },
        2: { schema: baseSchema },
      },
    };
    (EVENT_CODECS as Record<string, unknown>)[fakeType] = fakeCodec;

    try {
      const result = decodeEventPayload(fakeType, 1, {
        id: 'e1', label: 'react', canonicalLabel: null, entityType: 'pkg',
        aliases: [], extractionConfidence: 0.5, firstSeenRunId: 'r1',
        lastUpdatedRunId: 'r1', metadata: {},
      });
      expect(result.storedVersion).toBe(1);
      expect(result.latestVersion).toBe(2);
      expect((result.payload as { label: string }).label).toBe('REACT');
    } finally {
      (EVENT_CODECS as Record<string, unknown>)[fakeType] = originalCodec;
    }
  });
});

// ── Fix 4: upcast gap throws ────────────────────────────────────────

describe('Fix 4: upcast loop throws on version gap', () => {
  it('throws EventVersionUnsupportedError when upcast chain has a gap', () => {
    // Register a temporary fake codec with a version gap
    const fakeType = 'NODE_ADDED' as const;
    const originalCodec = EVENT_CODECS[fakeType];

    // Temporarily replace with a codec that has a gap: v1 → v3 (no v2 upcaster)
    const fakeCodec = {
      latestVersion: 3,
      versions: {
        1: { schema: originalCodec.versions[1]!.schema },
        3: { schema: originalCodec.versions[1]!.schema },
        // No version 2 → gap in upcast chain
      },
    };
    (EVENT_CODECS as Record<string, unknown>)[fakeType] = fakeCodec;

    try {
      // This should throw because v1→v3 has no v2 intermediate codec
      expect(() => decodeEventPayload(fakeType, 1, {
        id: 'e1', label: 'Test', canonicalLabel: null, entityType: 'pkg',
        aliases: [], extractionConfidence: 0.5, firstSeenRunId: 'r1',
        lastUpdatedRunId: 'r1', metadata: {},
      })).toThrow(EventVersionUnsupportedError);
    } finally {
      // Restore original codec
      (EVENT_CODECS as Record<string, unknown>)[fakeType] = originalCodec;
    }
  });
});
