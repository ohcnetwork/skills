**Bottom line** — Not mergeable as-is: the discount math is wrong (over-discounts ~10×), and the
diff carries an unnecessary strategy-factory abstraction plus a misleadingly named function.

**Intent** — Add an `InvoiceDiscountSummary` component that shows subtotal, a percentage discount,
tax, and the net payable for an invoice. Confidence: high — the JSX and totals block convey it.

**Worth deciding**
1. **Correctness — discount percent is not divided by 100.** `percentage: (subtotal, rate) =>
   subtotal * rate` treats `rate` as a fraction, but it's a whole-number percent from
   `discountPercent`. A 10% discount subtracts `subtotal * 10`, corrupting the net payable. Fix:
   `subtotal * rate / 100`.
2. **Overengineering — `DiscountStrategyFactory` + `DISCOUNT_STRATEGIES` for one strategy.** A
   class/registry indirection wraps a single one-line percentage calc with no second caller. Inline
   the calc; drop the factory and the registry.
3. **Legibility — `validateTotals` performs no validation.** It sums lines and returns the net; the
   name misleads. Rename to `computeTotals` (or similar).

**Optional / FYI** — none.

**Out of scope** — currency formatting (`formatCurrency` reused as-is).
