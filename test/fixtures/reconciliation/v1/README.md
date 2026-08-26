# Reconciliation Evaluation Corpus v1

Versioned gold-label corpus for the claim reconciler (`src/graph/claimReconciler.ts`,
`reconcilerVersion: 4`). Every case carries
exactly one gold label with a rationale — there is no alternative-label escape
hatch. The corpus encodes TRUE v2 semantics; if the reconciler changes behavior,
labels are re-adjudicated deliberately, never gamed to pass.

- `schemaVersion` / `labelPolicyVersion`: 1. Bump both together when the label
  policy below changes.
- Pair corpus: `cases/*.json` — 43 cases, 6 per classification
  (contradiction / supersedes / qualification / elaboration / same_claim /
  near_duplicate / new_claim), distributed so each of the hard-case category
  files contains one case of every class.
- Sequence scenarios: `scenarios/*.json` — 6 ordered clustering scenarios with
  per-observation gold cluster + expected outcome, plus an adjacent
  `*.golden.json` full projection snapshot (canonical state +
  `sha256` checksum) replayed deterministically through the graph handler
  registry with fixed envelope ids/seqs/timestamps.

## Changelog

- **v4 (current):** Supersedes now requires the observation to reference the
  existing claim's subject/predicate scope, have a strictly newer temporal
  position, and include prior-object-lineage in the assertion text.
  `polarity-supersedes-retraction-notice` relabeled from `supersedes`
  to `new_claim` — the replacement text never established lineage to the prior
  object `claim reconciliation`. Added compensating case
  `polarity-supersedes-explicit-object-lineage` (supersedes with lineage). See v2
  corpus for the corrected version of the original case.

## Label policy — classification definitions

- `same_claim` — observation joins the matched claim's canonical cluster
  (canonical reuse). Either exact canonical-key identity or lexical score
  >= 0.92 within scope.
- `near_duplicate` — strong lexical overlap (score 0.78–0.92) without
  canonical-key identity or object-superset extension. Creates its own claim.
- `elaboration` — same subject/predicate, objectText a strict superset of the
  existing object. Checked BEFORE near_duplicate.
- `qualification` — narrowing: conditional polarity, hedge downgrade from
  `certain`, or a narrowing keyword (only/unless/when/if/provided/limited
  to/under). Checked BEFORE elaboration/same_claim even at score 1.0.
- `contradiction` — polarity flip or out-of-tolerance numerics WITHIN the same
  scope (same subject/predicate anchors, sufficient object overlap, compatible
  temporal period). Cross-scope flips are NOT contradictions.
- `supersedes` — replacement verb (replaces/supersedes/deprecates/no longer
  supported...) plus a strictly newer temporal position, same subject/predicate
  scope, and the observation's assertion text must reference the existing claim's
  objectText when non-empty. Precedes all similarity branches.
- `new_claim` — no candidate clears the near_duplicate band. Correct rejection.

## The five hard-case categories

1. **Numeric tolerance boundary** — quantifiers within 10% relative tolerance
   stay compatible; beyond it, same-scope readings contradict. Quantifier
   present on only one side scores neutral (0.5), never contradictory.
2. **Temporal scope drift** — different eventDate/version periods block both
   sameKey and scoped contradiction; identical text across periods lands in
   near_duplicate at most. Supersession requires strictly newer periods.
3. **Negation/polarity flips** — only contradictory when scoped; conditional
   observations narrow instead of contradicting; two negations agree.
4. **Hedge-strength and scope weakening** — canonical key identity ignores
   hedge (likely vs certain still reuses); hedge downgrades from `certain`
   elsewhere qualify; loose hedges shift scores by one band only.
5. **Paraphrase/ambiguity** — score bands decide: >=0.92 in scope reuses,
   0.78–0.92 is near_duplicate/elaboration territory, below rejects. Object
   supersets elaborate before they near-duplicate.

## Known recorded tie-breaks

Score ties between candidates are broken by
`claim.id.localeCompare` collation, which ignores punctuation: `claim_g1`
ranks ahead of `claim-1`. Where a scenario depends on this (e.g.
negation-and-qualification step g2), the fixture pins the collation-derived
winner as the expected matched candidate.

## Golden projections

Golden files pin the ENTIRE serialized projection state (canonical ordering,
sorted keys) plus `computeProjectionChecksum()`. They exist to catch
accidental changes to reconciliation-driven projection writes. Deliberate
behavior changes require manually regenerating goldens and reviewing the diff —
there is no `--update-golden` flag by design.
