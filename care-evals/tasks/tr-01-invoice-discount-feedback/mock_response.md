Triaged 5 findings against the diff.

| F# | verdict | missed_by | reason |
| --- | --- | --- | --- |
| F1 | address | care-reviewer | Confirmed: `percentage: (subtotal, rate) => subtotal * rate` treats a whole-number percent as a fraction — a real ~10× over-discount. Fix `/ 100`. |
| F2 | address | care-technical-review | Confirmed: `DiscountStrategyFactory` + `DISCOUNT_STRATEGIES` wrap one one-line calc with no second strategy/caller — inline it. |
| F3 | address | care-reviewer | Confirmed: `validateTotals` only sums and returns the net; the name misleads. Rename to `computeTotals`. |
| F4 | decline | none | False positive: `validateTotals(lines, discountPercent)` is ALREADY wrapped in `useMemo(..., [lines, discountPercent])` in the diff. The suggested fix is already present. |
| F5 | defer | none | Scope creep: a shared `DiscountService` refactor across the billing module + e2e for every future discount kind is well beyond this change. Needs a human / separate ticket. |

Address: 3 · Decline: 1 · Defer: 1.
