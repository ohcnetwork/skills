---
id: tg-01-rubber-stamp-specs
skill: care-test-grade
tier: judgment
kind: seeded-wrong
args: specs/invoiceDiscount.spec.ts
---

# tg-01 — Invoice discount specs (seeded-wrong)

A Playwright spec graded against four acceptance criteria ([criteria.md](./criteria.md)) with the
code intent in [intent.md](./intent.md). The spec is deliberately built so that **each verdict in
the care-test-grade vocabulary appears exactly once**:

- **AC1** (net payable reflects the discount) → **Covered**: asserted on the real net-payable value.
- **AC2** (discount row shows the amount with a leading minus) → **Weak**: asserts the value but
  thinly — a loose `-100` substring that also matches `-1000.00`/`-100.50`, so it could pass on a
  wrong amount. Faithful but fragile (tighten, don't rewrite). *(Contrast tg-04 AC2, a presence-only
  assert that verifies no value at all → `Wrong`.)*
- **AC3** (percent > 100 is rejected, net unchanged) → **Wrong**: the spec instead asserts that a
  150% discount *is applied* and the net drops — it contradicts the criterion (rubber-stamps a
  buggy implementation). This is the one that must **block**.
- **AC4** (no discount → net = subtotal + tax) → **Missing**: no spec asserts it.

Ground truth: [expected.json](./expected.json). Success = the grader reproduces
`{AC1: Covered, AC2: Weak, AC3: Wrong, AC4: Missing}` and returns **block = true** (a `Wrong` is
present).
