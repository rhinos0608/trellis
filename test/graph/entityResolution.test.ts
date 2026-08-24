import { describe, it, expect } from 'vitest';
import {
  findMergeCandidates,
  mergeEntities,
  defaultThresholdForType,
} from '../../src/graph/entityResolution.js';
import type { CanonicalEntity } from '../../src/graph/types.js';

function makeEntity(
  overrides: Partial<CanonicalEntity> & { id: string; label: string },
): CanonicalEntity {
  return {
    entityType: 'package',
    canonicalLabel: null,
    aliases: [],
    extractionConfidence: 0.9,
    firstSeenRunId: 'run-1',
    lastUpdatedRunId: 'run-1',
    metadata: {},
    ...overrides,
  };
}

describe('entityResolution', () => {
  describe('defaultThresholdForType', () => {
    it('returns 0.75 for person', () => {
      expect(defaultThresholdForType('person')).toBe(0.75);
    });
    it('returns 0.75 for org', () => {
      expect(defaultThresholdForType('org')).toBe(0.75);
    });
    it('returns 0.85 for other types', () => {
      expect(defaultThresholdForType('package')).toBe(0.85);
      expect(defaultThresholdForType('sdk')).toBe(0.85);
    });
  });

  describe('findMergeCandidates', () => {
    const existing: CanonicalEntity[] = [
      makeEntity({ id: 'e1', label: 'React', entityType: 'package', aliases: ['reactjs'] }),
      makeEntity({ id: 'e2', label: 'Vue.js', entityType: 'package' }),
      makeEntity({
        id: 'e3',
        label: 'Anthropic',
        entityType: 'org',
        aliases: ['Anthropic PBC'],
        canonicalLabel: 'Anthropic',
      }),
    ];

    it('finds exact label match (case-insensitive)', () => {
      const candidates = findMergeCandidates('react', 'package', [], existing);
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.intoId).toBe('e1');
      expect(candidates[0]!.confidence).toBe(1.0);
    });

    it('finds alias match', () => {
      const candidates = findMergeCandidates('reactjs', 'package', [], existing);
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.intoId).toBe('e1');
      expect(candidates[0]!.confidence).toBe(0.95);
    });

    it('finds match via new entity aliases', () => {
      const candidates = findMergeCandidates('Vue', 'package', ['vue.js'], existing);
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.intoId).toBe('e2');
      expect(candidates[0]!.confidence).toBe(0.95);
    });

    it('skips entities of different type', () => {
      const candidates = findMergeCandidates('anthropic', 'package', [], existing);
      expect(candidates.length).toBe(0);
    });

    it('finds org match with high Jaccard', () => {
      const candidates = findMergeCandidates('Anthropic', 'org', [], existing);
      expect(candidates.length).toBe(1);
      expect(candidates[0]!.intoId).toBe('e3');
    });

    it('returns empty for no-match label', () => {
      const candidates = findMergeCandidates('completely-unrelated', 'package', [], existing);
      expect(candidates.length).toBe(0);
    });

    it('uses LLM callback when provided and label is similar', () => {
      const candidates = findMergeCandidates('ReactJS', 'package', [], existing, {
        llmJudgesSameEntity: () => true,
      });
      expect(candidates.length).toBeGreaterThanOrEqual(1);
    });

    it('returns no candidates when LLM says different', () => {
      const candidates = findMergeCandidates('React.js Library', 'package', [], existing, {
        llmJudgesSameEntity: () => false,
      });
      // LLM says no → should not match even though Jaccard is decent
      expect(candidates.length).toBe(0);
    });
  });

  describe('mergeEntities', () => {
    it('merges aliases from absorbed entity', () => {
      const survivor = makeEntity({ id: 's1', label: 'React', aliases: ['reactjs'] });
      const absorbed = makeEntity({
        id: 'a1',
        label: 'React.js',
        aliases: ['react-js'],
        canonicalLabel: 'React',
      });
      const merged = mergeEntities(survivor, absorbed);
      expect(merged.aliases).toContain('reactjs');
      expect(merged.aliases).toContain('react-js');
      expect(merged.aliases).toContain('React.js');
    });

    it('updates lastUpdatedRunId', () => {
      const survivor = makeEntity({ id: 's1', label: 'X', lastUpdatedRunId: 'run-1' });
      const absorbed = makeEntity({ id: 'a1', label: 'Y', lastUpdatedRunId: 'run-2' });
      const merged = mergeEntities(survivor, absorbed);
      expect(merged.lastUpdatedRunId).toBe('run-2');
    });
  });
});
