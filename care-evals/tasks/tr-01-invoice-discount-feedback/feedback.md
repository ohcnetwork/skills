# PR #0000 — pre-digested bot feedback   (2026-07-16T00:00:00Z)
# (author · path:line · thread-id · trimmed body) — grouped by file+line; every comment
# kept. [F#] tags are the triage item ids for this fixture.

## Inline comments
- `src/pages/Facility/billing/invoice/components/InvoiceDiscountSummary.tsx:20`
  - **coderabbitai[bot]** (thread 5001)  [F1]
      The `percentage` discount strategy computes `subtotal * rate`, but `rate` here is
      `discountPercent` — a whole-number percent (e.g. `10` for 10%). This subtracts `subtotal * 10`,
      about 10× the intended discount, corrupting the net payable. Should divide by 100:
      `subtotal * rate / 100`.

- `src/pages/Facility/billing/invoice/components/InvoiceDiscountSummary.tsx:22`
  - **greptile-apps[bot]** (thread 5002)  [F2]
      `DiscountStrategyFactory` plus the `DISCOUNT_STRATEGIES` registry wrap a single one-line
      percentage calculation behind a class and a resolve() lookup, with no second strategy and no
      second caller. This indirection isn't earning its keep — inline the calculation.

- `src/pages/Facility/billing/invoice/components/InvoiceDiscountSummary.tsx:42`
  - **Copilot** (thread 5003)  [F3]
      `validateTotals` performs no validation — it sums the lines and returns the net payable. The
      name misleads about what the function does; consider `computeTotals`.

- `src/pages/Facility/billing/invoice/components/InvoiceDiscountSummary.tsx:53`
  - **coderabbitai[bot]** (thread 5004)  [F4]
      These totals are recomputed on every render. Wrap `validateTotals(lines, discountPercent)` in a
      `useMemo` so it only recomputes when its inputs change.

## Summary comments
- **greptile-apps[bot]** (comment 5005)  [F5]
      Consider extracting a shared `DiscountService` used across the whole billing module, and adding
      end-to-end tests covering every discount kind (percentage, fixed, tiered, promotional) so the
      new strategy surface is fully exercised before more kinds land.
