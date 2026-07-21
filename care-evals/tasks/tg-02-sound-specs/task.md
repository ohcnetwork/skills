---
id: tg-02-sound-specs
skill: care-test-grade
tier: judgment
kind: mixed-control
args: specs/userDepartments.spec.ts
---

# tg-02 — User departments pagination specs (mixed control: precision + Weak-not-block)

The **two-sided control** for care-test-grade. Two of its criteria are genuinely sound and must stay
`Covered` (precision — the grader must not manufacture false alarms on healthy specs); one is a
genuine thin assertion that must be caught as `Weak` yet must **not** block (disposition — advisory
findings don't stall healthy work). Graded against three acceptance criteria
([criteria.md](./criteria.md), intent in [intent.md](./intent.md)):

- **AC1** (first page shows exactly 10 rows) → **Covered**: a strong, direct `toHaveCount(10)` on the
  body rows.
- **AC2** (Next advances to a distinct batch) → **Weak**: the spec awaits the refetch (a web-first
  assertion, no snapshot race) and re-checks the count, but verifies distinctness only via the
  **first row's** text — not that the whole batch differs — so a coincidental first-row match could
  pass. "Distinct batch" is intrinsically hard to assert strongly; this is a legitimate `Weak`
  (independently graded `Weak` by both Haiku and Sonnet). Advisory — it does not block.
- **AC3** (page indicator reflects the current page) → **Covered**: asserts `Page 1` then `Page 2`.
  The criterion's "e.g. Page 2 of N" is **illustrative**, not a required sub-assertion — asserting
  "Page 2" faithfully reflects the current page.

A good grader returns `{AC1: Covered, AC2: Weak, AC3: Covered}` and **block = false**. It fails by
over-flagging AC1/AC3 (false alarm), by manufacturing a `Wrong`/block on the merely-thin AC2
(over-reaction that would stall healthy work), or by over-reading AC3's "of N" example as required.

Ground truth: [expected.json](./expected.json). *(History: this was an all-`Covered` precision
control; re-grounded 2026-07-17 when the sharpened Weak-vs-Wrong rubric led two independent models to
correctly flag AC2's first-row-only distinctness check as thin. It now also fills the
"genuine Weak that must not block" slot vacated when tg-04 flipped to a blocking `Wrong`.)*
