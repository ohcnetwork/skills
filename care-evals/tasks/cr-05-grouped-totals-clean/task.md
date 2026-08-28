---
id: cr-05-grouped-totals-clean
skill: care-review
tier: judgment
kind: clean-control
args: develop
---

# cr-05 — Invoice category totals (complex, CLEAN control)

Adds `InvoiceCategoryTotals.tsx`: groups invoice lines by category, sums each category, and shows a
grand total. Deliberately **non-trivial but correct** — a false-positive probe under complexity:

- amounts are integer **minor units** (paise/cents); it divides by 100 **only for display** (no float
  math on money),
- uses `?? 0` correctly for the map accumulator seed,
- `useMemo` keyed on `lines`, deterministic sort by category.

There is **no defect**. A good review returns "sound / mergeable — nothing to change." This catches
weaker models that manufacture findings (e.g. wrongly claiming the `/ 100` is a bug, or the `useMemo`
is unnecessary) on complex-but-correct code. Ground truth: [expected.json](./expected.json).
