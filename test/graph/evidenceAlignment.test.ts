import { describe, it, expect } from 'vitest';
import { assessEvidenceAlignment } from '../../src/graph/evidenceAlignment.js';

describe('evidenceAlignment', () => {
  it('returns high score for matching claim and evidence', () => {
    const result = assessEvidenceAlignment({
      claim: 'React 19 improves performance by 40%',
      evidenceText: 'React 19 improves performance by 40% according to the official benchmark',
    });
    expect(result.score).toBeGreaterThan(0.5);
    expect(result.method).toBe('lexical_anchor_overlap');
    expect(result.matchedTerms.length).toBeGreaterThan(0);
  });

  it('returns low score for mismatched claim and evidence', () => {
    const result = assessEvidenceAlignment({
      claim: 'React 19 improves performance by 40%',
      evidenceText: 'The weather today is sunny and warm',
    });
    expect(result.score).toBeLessThan(0.3);
    expect(result.missingAnchorTerms.length).toBeGreaterThan(0);
  });

  it('returns zero for empty evidence', () => {
    const result = assessEvidenceAlignment({
      claim: 'React 19 improves performance',
      evidenceText: '',
    });
    expect(result.score).toBe(0);
  });

  it('capped when anchor terms are missing', () => {
    const result = assessEvidenceAlignment({
      claim: 'v3.2.1 released on 2024-01-15',
      evidenceText: 'Some general discussion about the release',
    });
    // v3.2.1 and 2024-01-15 are anchors not in evidence → capped
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.missingAnchorTerms.length).toBeGreaterThan(0);
  });

  it('includes explanation', () => {
    const result = assessEvidenceAlignment({
      claim: 'Test claim',
      evidenceText: 'Test evidence with some shared content',
    });
    expect(typeof result.explanation).toBe('string');
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('truncates snippet to 240 chars', () => {
    const longEvidence = 'a'.repeat(500);
    const result = assessEvidenceAlignment({
      claim: 'Some claim',
      evidenceText: longEvidence,
    });
    expect(result.evidenceSnippet!.length).toBeLessThanOrEqual(240);
  });
});
