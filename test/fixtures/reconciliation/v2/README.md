# Reconciliation Evaluation Corpus v2

Versioned gold-label corpus for the claim reconciler (`src/graph/claimReconciler.ts`,
`reconcilerVersion: 4`). Supersedes v1 corpus with stricter supersession semantics.

## Changes from v1

- **Supersession scope tightened**: `supersedes` now requires the observation to
  explicitly reference the existing claim's `objectText` (or an equivalent lineage
  token). Observations with replacement wording but no object reference fall through
  to `new_claim`.
- `polarity-supersedes-retraction-notice` relabeled — replacement text now
  explicitly references the prior object `claim reconciliation`, satisfying
  stricter v4 supersession lineage requirement. Classified as `supersedes`.
- `polarity-supersedes-explicit-object-lineage` added as replacement case
  using "replaces claim reconciliation with improved approach" to test
  supersession with clear prior-object-lineage reference.
- New adversarial case `polarity-adversarial-unrelated-replacement`: unrelated-topic
  observation with replacement wording + newer date but no reference to the prior
  claim's subject or object — must classify as `new_claim`.

## Schema

- `schemaVersion` / `labelPolicyVersion`: 1 / 2 (`labelPolicyVersion` raised to
  reflect the changed supersedes labeling rules rather than JSON shape changes).
- Pair corpus: `cases/*.json` — 44 cases (43 carried from v1 + 1 adversarial).
- Structure mirrors v1; sequence scenarios are NOT duplicated because scenario
  golden projections depend on exact state serialization which differs by
  reconciler version.

## Label policy — classification definitions (v4)

Same as v1 except:
- `supersedes` — replacement verb plus strictly newer temporal position AND
  same subject/predicate scope AND the observation's assertion text must
  reference the existing claim's objectText when non-empty.
