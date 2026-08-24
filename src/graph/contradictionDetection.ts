/**
 * Contradiction detection — rule-based contradiction discovery from claim
 * pairs.  Ported from search-mcp's contradictionGenerator.ts
 * generateFromEvidencePool().
 *
 * Produces Contradiction rows by detecting:
 * 1. Date/version conflicts — claims mentioning different years/versions for same topic
 * 2. Benchmark/numerical conflicts — claims with significantly different numbers
 * 3. Release date conflicts — differing reported release dates
 *
 * The LLM-based detection from contradictionDetector.ts is NOT ported here
 * because it requires the LLM client — callers can wire that in separately.
 * This module provides the deterministic, always-available rule-based path.
 */

import type { Claim, Contradiction } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract a claim's core topic for grouping. */
function extractClaimTopic(claimText: string): string {
  const stopWords = new Set([
    'this',
    'that',
    'these',
    'those',
    'with',
    'from',
    'which',
    'their',
    'have',
    'been',
    'were',
    'they',
    'what',
    'about',
    'would',
    'could',
    'should',
    'there',
    'being',
    'while',
    'where',
    'after',
    'before',
    'other',
    'such',
    'more',
    'very',
    'also',
    'than',
    'then',
    'when',
    'into',
    'over',
    'most',
    'some',
    'each',
    'both',
    'through',
  ]);

  const words = claimText
    .toLowerCase()
    .split(/[^\w']+/)
    .filter((w) => w.length > 3 && !stopWords.has(w) && !/^\d+$/.test(w));
  return words.slice(0, 4).join(' ');
}

function extractYears(text: string): number[] {
  const yearPattern = /\b(20\d{2})\b/g;
  const years: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = yearPattern.exec(text)) !== null) {
    const y = parseInt(match[1] ?? '0', 10);
    if (y >= 2020 && y <= 2040) years.push(y);
  }
  return [...new Set(years)];
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((v) => set.has(v));
}

function extractVersions(text: string): string[] {
  const versionPatterns = [
    /\bv(\d+(?:\.\d+)+)\b/gi,
    /\bversion\s+(\d+(?:\.\d+)*)\b/gi,
    /\b(GPT[-\s]?\d+(?:\.\d+)?)\b/gi,
    /\b(Claude\s+\d+(?:\.\d+)?)\b/gi,
    /\b(Gemini\s+\d+(?:\.\d+)?)\b/gi,
    /\b(Llama\s+\d+(?:\.\d+)?)\b/gi,
    /\b(Stable\s+Diffusion\s+\d+(?:\.\d+)?)\b/gi,
    /\biOS\s+(\d+(?:\.\d+)*)\b/gi,
    /\bandroid\s+(\d+(?:\.\d+)*)\b/gi,
    /\bReact\s+(\d+(?:\.\d+)*)\b/gi,
    /\bNode\.?js\s+(\d+(?:\.\d+)*)\b/gi,
    /\bPython\s+(\d+(?:\.\d+)*)\b/gi,
    /\bTypeScript\s+(\d+(?:\.\d+)*)\b/gi,
    /\bKubernetes\s+(\d+(?:\.\d+)*)\b/gi,
    /\bDocker\s+(\d+(?:\.\d+)*)\b/gi,
  ];
  const versions: string[] = [];
  for (const pattern of versionPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      versions.push((match[1] ?? match[0]).toLowerCase());
    }
  }
  return [...new Set(versions)];
}

function extractMetrics(text: string): { value: number; unit: string }[] {
  const patterns = [
    /\b(\d+(?:\.\d+)?)\s*(%|percent)/gi,
    /\b(\d+(?:\.\d+)?)\s*(ms|milliseconds?)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(GB|gb|MB|mb|KB|kb|TB|tb)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(GHz|ghz|MHz|mhz|Hz|hz)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(GBps|gbps|MBps|mbps|Gbps|gbps)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*(billion|million|trillion)\b/gi,
    /\baccuracy\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*%/gi,
    /\b(?:achieve[sd]?|reached?|scored?)\s+(\d+(?:\.\d+)?)\s*%/gi,
    /\b(\d+(?:\.\d+)?)\s*(?:billion|B)\s+(?:parameters?|params?)\b/gi,
    /\bcontext\s+(?:window|length)\s+(?:of\s+)?(\d+(?:\.\d+)?)\s*(?:K|k|tokens?)\b/gi,
  ];
  const metrics: { value: number; unit: string }[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const valMatch = match[1];
      if (!valMatch) continue;
      const value = parseFloat(valMatch);
      const unit = (match[2] ?? 'count').toLowerCase();
      metrics.push({ value, unit });
    }
  }
  return metrics;
}

const RELEASE_DATE_PATTERNS = [
  /\breleased?\s+(?:in\s+)?(20\d{2})\b/i,
  /\blaunche?d\s+(?:in\s+)?(20\d{2})\b/i,
  /\bship(ped|ping)\s+(?:in\s+)?(20\d{2})\b/i,
  /\bavailable\s+(?:in|from|since)\s+(20\d{2})\b/i,
  /\bexpected?\s+(?:in|by|for)\s+(20\d{2})\b/i,
];

function extractReleaseDates(text: string): number[] {
  const years: number[] = [];
  for (const pattern of RELEASE_DATE_PATTERNS) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const yearMatch = match[2] ?? match[1];
      if (!yearMatch) continue;
      const year = parseInt(yearMatch, 10);
      if (year >= 2020 && year <= 2040) years.push(year);
    }
  }
  return [...new Set(years)];
}

function claimText(c: Claim): string {
  return [c.subjectText, c.predicate, c.objectText].filter(Boolean).join(' ');
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ContradictionDetectionResult {
  contradictions: Contradiction[];
}

/**
 * Detect contradictions between claims using rule-based heuristics ported
 * from contradictionGenerator.ts.
 *
 * @param claims  All claims in the research state.
 * @param runId   The run that produced these detections.
 * @returns       New Contradiction rows to add to state.
 */
export function detectContradictions(
  claims: Claim[],
  runId: string,
): ContradictionDetectionResult {
  const contradictions: Contradiction[] = [];

  if (claims.length < 2) return { contradictions };

  // Build topic groups
  const topicGroups = new Map<string, Claim[]>();
  for (const c of claims) {
    const topic = extractClaimTopic(claimText(c));
    if (!topic) continue;
    const group = topicGroups.get(topic) ?? [];
    group.push(c);
    topicGroups.set(topic, group);
  }

  // Dedup set — avoid duplicate claim-pair contradictions
  const seenPairs = new Set<string>();

  for (const [, group] of topicGroups) {
    if (group.length < 2) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (!a || !b) continue;
        const pairKey = [a.id, b.id].sort().join('||');
        if (seenPairs.has(pairKey)) continue;

        // Check 1: year conflicts
        const aYears = extractYears(claimText(a));
        const bYears = extractYears(claimText(b));
        if (aYears.length > 0 && bYears.length > 0 && !arraysEqual(aYears, bYears)) {
          seenPairs.add(pairKey);
          contradictions.push({
            id: '', // caller assigns ULID
            familyId: a.familyId,
            claimIdA: a.id,
            claimIdB: b.id,
            contradictionType: 'time_version_mismatch',
            resolutionStatus: 'unresolved',
            likelyExplanation: `Claims mention different years (${aYears.join(', ')} vs ${bYears.join(', ')}). May reflect changes over time or conflicting reports.`,
            firstSeenRunId: runId,
          });
          continue;
        }

        // Check 2: version conflicts
        const aVersions = extractVersions(claimText(a));
        const bVersions = extractVersions(claimText(b));
        if (aVersions.length > 0 && bVersions.length > 0 && !arraysEqual(aVersions, bVersions)) {
          seenPairs.add(pairKey);
          contradictions.push({
            id: '',
            familyId: a.familyId,
            claimIdA: a.id,
            claimIdB: b.id,
            contradictionType: 'time_version_mismatch',
            resolutionStatus: 'unresolved',
            likelyExplanation: `Claims reference different versions (${aVersions.join(', ')} vs ${bVersions.join(', ')}). May describe different releases.`,
            firstSeenRunId: runId,
          });
          continue;
        }

        // Check 3: benchmark/numerical conflicts
        const aMetrics = extractMetrics(claimText(a));
        const bMetrics = extractMetrics(claimText(b));
        if (aMetrics.length > 0 && bMetrics.length > 0) {
          for (const m1 of aMetrics) {
            for (const m2 of bMetrics) {
              if (m1.unit !== m2.unit) continue;
              if (m1.value === m2.value) continue;
              const ratio = Math.abs(m1.value - m2.value) / Math.max(m1.value, m2.value);
              if (ratio > 0.3) {
                seenPairs.add(pairKey);
                contradictions.push({
                  id: '',
                  familyId: a.familyId,
                  claimIdA: a.id,
                  claimIdB: b.id,
                  contradictionType: 'benchmark_disagreement',
                  resolutionStatus: 'unresolved',
                  likelyExplanation: `Numerical values differ: ${String(m1.value)}${m1.unit} vs ${String(m2.value)}${m2.unit} (${String(Math.round(ratio * 100))}% difference). May reflect different methodologies.`,
                  firstSeenRunId: runId,
                });
                break;
              }
            }
            if (seenPairs.has(pairKey)) break;
          }
        }

        // Check 4: release date conflicts
        if (!seenPairs.has(pairKey)) {
          const aDates = extractReleaseDates(claimText(a));
          const bDates = extractReleaseDates(claimText(b));
          if (aDates.length > 0 && bDates.length > 0 && !arraysEqual(aDates, bDates)) {
            seenPairs.add(pairKey);
            contradictions.push({
              id: '',
              familyId: a.familyId,
              claimIdA: a.id,
              claimIdB: b.id,
              contradictionType: 'time_version_mismatch',
              resolutionStatus: 'unresolved',
              likelyExplanation: `Release dates conflict: ${aDates.join(', ')} vs ${bDates.join(', ')}. May reflect different release phases or inaccurate reporting.`,
              firstSeenRunId: runId,
            });
          }
        }
      }
    }
  }

  return { contradictions };
}
