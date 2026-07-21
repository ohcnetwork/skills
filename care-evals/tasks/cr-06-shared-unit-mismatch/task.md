---
id: cr-06-shared-unit-mismatch
skill: care-review
tier: judgment
kind: seeded-defect
args: develop
---

# cr-06 — Shared totals helper, inconsistent callers (the Haiku-vs-Opus discriminator)

A 3-file diff: a shared `computeInvoiceTotals()` whose JSDoc says it returns **minor units (paise)**,
consumed by two new components:

- `PrintInvoiceTotals.tsx` — **correct**: `formatCurrency(totals.total / 100, …)` with a comment.
- `InvoiceSummaryCard.tsx` — **BUG**: `formatCurrency(totals.total, …)` — omits the `/ 100`, so it
  renders the amount **100× too large** (paise shown as rupees).

**One planted defect, catchable only by cross-referencing the two call sites against the helper's
documented unit contract.** Each file is locally plausible — `InvoiceSummaryCard` just formats a
number; the bug exists only relative to the helper's contract that the *other* caller honors. This is
care-review's "regression in the other usages of a shared component/util" lens, and the
blast-radius reasoning is the thing that should separate a strong model from a weak one.

Ground truth: [expected.json](./expected.json). Critical `must_flag` = the summary-card unit mismatch.
