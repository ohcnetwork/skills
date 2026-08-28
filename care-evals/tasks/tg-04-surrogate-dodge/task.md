---
id: tg-04-surrogate-dodge
skill: care-test-grade
tier: judgment
kind: seeded-wrong
args: specs/issueInvoice.spec.ts
---

# tg-04 — Issue-invoice specs (seeded-wrong: presence-instead-of-value, blocks)

Guards the **IMP-10 escape class** (see care-loop-doctor IMPROVEMENTS.md) as an offline regression:
a criterion demands a specific value the *local fixture backend does not produce* (a server-assigned
**invoice number**), so the spec author dodged it — asserting only that *an* invoice-number element
is **present**, never its value, to land a green "number-independent" spec that no longer verifies
the criterion.

**Grading decision this fixture encodes (2026-07-17):** a **presence-instead-of-value** assert is
`Wrong`, not `Weak` — it verifies nothing the criterion claims (the green `toBeVisible()` would
survive even if the number were absent or garbage), so it **blocks** and the spec must be rewritten.
This aligns the suite with what capable models already do (Haiku and Sonnet both graded this `Wrong`)
and with the skill's sharpened Weak-vs-Wrong line. The IMP-10 twist: because the value is
fixture-unproducible, the *real* fix isn't a spec tweak — it routes **back to the plan** to restate
the criterion against a value the fixture yields.

Graded against three acceptance criteria ([criteria.md](./criteria.md), intent in
[intent.md](./intent.md)):

- **AC1** (status badge flips Draft → Issued) → **Covered**: asserts the badge text.
- **AC2** (the issued invoice **number** is displayed) → **Wrong**: asserts only that the
  invoice-number element is visible, never its value — it does not verify the criterion's claim.
  This is the one that must **block**.
- **AC3** (final total = subtotal + tax − discount) → **Covered**: asserts the real total value.

Ground truth: [expected.json](./expected.json). Success = `{AC1: Covered, AC2: Wrong, AC3: Covered}`
and **block = true**. A grader that calls AC2 `Covered` was fooled by the green presence check; one
that calls it `Weak` under-rated a spec that verifies nothing the criterion claims.
