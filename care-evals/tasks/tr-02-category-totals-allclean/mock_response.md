Triaged 4 findings against the diff. The change is sound — nothing to address.

| F# | verdict | missed_by | reason |
| --- | --- | --- | --- |
| F1 | decline | none | False positive: `amountMinor` is an integer minor unit and `/ 100` is display-only inside `formatCurrency` — there's no float accumulation on money. Standard, correct. |
| F2 | decline | none | False positive: `currency` is not read inside the `useMemo` callback (only `lines` is), so `[lines]` is the correct dependency array — adding `currency` would be a spurious dep. |
| F3 | decline | none | False positive: the first read of a category is before any `set`, so `byCategory.get(category)` returns `undefined` — the `?? 0` seed is required, not dead. |
| F4 | defer | none | Scope creep: a module-wide `useCategoryTotals` hook + shared formatter + tests across all billing views is a broad refactor beyond this change. Needs a human/design decision. |

Address: 0 · Decline: 3 · Defer: 1. Sound as-is.
