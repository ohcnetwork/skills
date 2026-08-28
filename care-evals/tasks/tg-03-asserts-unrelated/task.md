---
id: tg-03-asserts-unrelated
skill: care-test-grade
tier: judgment
kind: seeded-wrong
args: specs/recordPayment.spec.ts
---

# tg-03 — Record-payment specs (seeded-wrong: asserts the wrong thing)

The **second flavor of `Wrong`**, distinct from tg-01. tg-01's Wrong *rubber-stamps a buggy
implementation* (asserts a value the code produces but the criterion forbids). This one is greener
and sneakier: the spec passes by **asserting adjacent, unrelated behavior** — a success toast — for a
criterion that is about a *recomputed numeric value*. Nothing about the assertion is buggy; it's just
not testing the criterion.

Graded against three acceptance criteria ([criteria.md](./criteria.md), intent in
[intent.md](./intent.md)):

- **AC1** (outstanding balance recomputes to `balance − payment`) → **Wrong**: the spec only asserts
  the "Payment recorded" toast is visible; it never asserts the recomputed balance. The behavior the
  criterion is about is entirely untested — a green spec that would stay green even if the balance
  math were broken. This is the one that must **block**.
- **AC2** (the payment appears in the Payments list with its amount) → **Covered**: asserted on the
  real row text.
- **AC3** (a payment over the balance is rejected, balance unchanged) → **Missing**: no spec.

Ground truth: [expected.json](./expected.json). Success = the grader reproduces
`{AC1: Wrong, AC2: Covered, AC3: Missing}` and returns **block = true**. A grader that calls AC1
`Covered` (fooled by the green toast assertion) or `Weak` (under-rating a total miss of the
criterion) has failed the core check.
