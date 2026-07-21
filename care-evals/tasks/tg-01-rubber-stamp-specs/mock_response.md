Graded the invoice-discount spec against the four acceptance criteria.

| AC# | verdict | note |
|---|---|---|
| AC1 | Covered | asserts `net-payable` reads `950.00` after applying 10% — the real value. |
| AC2 | Weak | checks the value but via a loose `-100` substring — also matches `-1000.00`/`-100.50`, so it could pass on an incorrect amount. Faithful but fragile. |
| AC3 | Wrong | the spec asserts a 150% discount *is applied* (`net-payable` → `-450.00`), which contradicts the criterion (over-100 must be rejected and the net left unchanged). Rubber-stamps a buggy implementation. |
| AC4 | Missing | no spec asserts the no-discount case (net = subtotal + tax). |

**Fixes**
- AC2: assert `getByTestId("discount-row")` has text `-100.00`.
- AC3: replace with an assertion that entering `150` shows an inline validation error and
  `net-payable` is unchanged. Do NOT "fix" it by matching the code — the implementation is what's
  wrong here; route to review.
- AC4: add a case asserting net equals subtotal + tax when no discount is applied.

**Disposition** — **AC3 is `Wrong` → blocks.** AC2 (`Weak`) and AC4 (`Missing`) are advisory.
