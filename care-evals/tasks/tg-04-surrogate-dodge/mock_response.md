Graded the issue-invoice spec against the three acceptance criteria.

| AC# | verdict | note |
|---|---|---|
| AC1 | Covered | asserts `status-badge` reads `Issued` after clicking Issue — the real user-visible value. |
| AC2 | Wrong | asserts only that `invoice-number` is *visible*, never its value. The criterion is about the displayed **number**; a presence check verifies nothing the criterion claims — it would stay green even if the number were absent or garbage. Presence-instead-of-value → the assertion must be rewritten to check the number. |
| AC3 | Covered | asserts `final-total` reads `950.00` (`subtotal + tax − discount`) — the real computed value. |

**Fixes**
- AC2: the criterion isn't gradeable against the local fixture as written — the numbering service
  isn't seeded, so no number exists to assert. Route back to the plan: either seed the numbering
  service so the number can be asserted, or restate the criterion around a value the fixture produces
  (e.g. the invoice enters the Issued state and is addressable by its id). Do not leave a
  presence-only assert standing in for a value assertion.

**Disposition** — **AC2 is `Wrong` → blocks.** The spec must be rewritten (and the criterion likely
restated at the plan; see IMP-10).
