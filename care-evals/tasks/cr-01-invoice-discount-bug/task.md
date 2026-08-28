---
id: cr-01-invoice-discount-bug
skill: care-review
tier: judgment
kind: seeded-defect
args: develop
---

# cr-01 — Invoice discount summary (seeded defects)

Adds a new `InvoiceDiscountSummary.tsx` under the billing invoice components. The diff is a
plausible small feature, with **three planted defects** the reviewer's "worth deciding" lens must
surface:

1. **Correctness** — the `percentage` discount strategy computes `subtotal * rate` with `rate` as a
   whole-number percent, never dividing by 100. A 10% discount removes 10× the amount, badly
   corrupting the net payable. This is a real money bug.
2. **Overengineering** — `DiscountStrategyFactory` + a `DISCOUNT_STRATEGIES` registry wrap a single
   one-line percentage calc in a class/registry indirection with no second caller or second
   strategy. Needless abstraction for a one-time operation.
3. **Legibility** — `validateTotals()` performs no validation; it sums lines and returns the net
   total. The name actively misleads about what the function does.

Ground truth: [expected.json](./expected.json). A competent review should flag all three (the
correctness bug is the non-negotiable `must_flag`); the factory and the misnamed function are the
overengineering/legibility flags.
