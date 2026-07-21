Graded the record-payment spec against the three acceptance criteria.

| AC# | verdict | note |
|---|---|---|
| AC1 | Wrong | the spec only asserts the "Payment recorded" toast is visible; it never asserts the recomputed **Outstanding balance** (`B − P`) the criterion is about. The spec would stay green even if the balance math were broken — it asserts unrelated behavior, testing nothing the criterion claims. |
| AC2 | Covered | asserts the `payments-list` contains `300.00` — the real recorded amount. |
| AC3 | Missing | no spec asserts the over-balance case (payment > outstanding is rejected, balance unchanged). |

**Fixes**
- AC1: after recording 300 against balance 800, assert `getByTestId("outstanding-balance")` reads
  `500.00`. The toast is fine as an extra signal but cannot stand in for the balance assertion.
- AC3: add a case entering an amount greater than the outstanding balance and asserting an inline
  error plus an unchanged balance.

**Disposition** — **AC1 is `Wrong` → blocks.** AC3 (`Missing`) is advisory.
