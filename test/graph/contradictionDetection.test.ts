import { describe, it, expect } from 'vitest';
import { detectContradictions } from '../../src/graph/contradictionDetection.js';
import type { Claim } from '../../src/graph/types.js';

function makeClaim(
  id: string,
  subjectText: string,
  predicate: string,
  objectText?: string,
): Claim {
  return {
    id,
    familyId: 'fam-1',
    subjectText,
    predicate,
    objectText,
    polarity: 'asserted',
    hedge: 'certain',
    evidenceType: 'study',
    confidence: 0.8,
    canonicalKey: { subject: subjectText.toLowerCase(), predicate: predicate.toLowerCase() },
    contradictionState: 'none',
    firstSeenRunId: 'run-1',
    lastSeenRunId: 'run-1',
  };
}

describe('contradictionDetection', () => {
  it('returns empty for fewer than 2 claims', () => {
    const result = detectContradictions([makeClaim('c1', 'A', 'is B')], 'run-1');
    expect(result.contradictions).toEqual([]);
  });

  it('detects year conflict', () => {
    const claims = [
      makeClaim('c1', 'React 19 released', 'in 2024'),
      makeClaim('c2', 'React 19 released', 'in 2025'),
    ];
    const result = detectContradictions(claims, 'run-1');
    expect(result.contradictions.length).toBe(1);
    expect(result.contradictions[0]!.contradictionType).toBe('time_version_mismatch');
    expect(result.contradictions[0]!.resolutionStatus).toBe('unresolved');
    expect(result.contradictions[0]!.familyId).toBe('fam-1');
  });

  it('detects version conflict', () => {
    const claims = [
      makeClaim('c1', 'GPT-4 achieves', '90% accuracy'),
      makeClaim('c2', 'GPT-5 achieves', '90% accuracy'),
    ];
    const result = detectContradictions(claims, 'run-1');
    expect(result.contradictions.length).toBe(1);
    expect(result.contradictions[0]!.contradictionType).toBe('time_version_mismatch');
  });

  it('detects benchmark disagreement', () => {
    const claims = [
      makeClaim('c1', 'Model achieves', '95% on MMLU benchmark'),
      makeClaim('c2', 'Model achieves', '60% on MMLU benchmark'),
    ];
    const result = detectContradictions(claims, 'run-1');
    const benchmark = result.contradictions.find(
      (c) => c.contradictionType === 'benchmark_disagreement',
    );
    expect(benchmark).toBeDefined();
  });

  it('does not flag same year as contradiction', () => {
    const claims = [
      makeClaim('c1', 'React releases', 'in 2024'),
      makeClaim('c2', 'React releases', 'in 2024'),
    ];
    const result = detectContradictions(claims, 'run-1');
    expect(result.contradictions).toEqual([]);
  });

  it('does not flag similar metrics as contradiction', () => {
    const claims = [
      makeClaim('c1', 'Performance improves', 'by 10 percent'),
      makeClaim('c2', 'Performance improves', 'by 11 percent'),
    ];
    const result = detectContradictions(claims, 'run-1');
    expect(result.contradictions).toEqual([]);
  });

  it('deduplicates claim pairs', () => {
    const claims = [
      makeClaim('c1', 'React releases', 'in 2024'),
      makeClaim('c2', 'React releases', 'in 2025'),
    ];
    const result = detectContradictions(claims, 'run-1');
    // Only one contradiction even though the loop processes both orderings
    expect(result.contradictions.length).toBe(1);
  });

  it('sets firstSeenRunId on contradictions', () => {
    const claims = [
      makeClaim('c1', 'React releases', 'in 2024'),
      makeClaim('c2', 'React releases', 'in 2025'),
    ];
    const result = detectContradictions(claims, 'run-99');
    expect(result.contradictions[0]!.firstSeenRunId).toBe('run-99');
  });
});
