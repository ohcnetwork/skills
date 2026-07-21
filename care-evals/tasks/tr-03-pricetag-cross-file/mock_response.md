Triaged 3 findings; two require reading both changed files.

| F# | verdict | missed_by | reason |
| --- | --- | --- | --- |
| F1 | decline | none | False positive (cross-file): `money.ts` — also in this change — guards `if (!amount) return "—"`, so a `null` amount never reaches `.toFixed`. The crash the bot predicts can't happen; the sibling file handles it. |
| F2 | address | care-reviewer | Valid (cross-file): `if (!amount)` matches `0`, and `PriceTag.tsx`'s prop comment says `amount` is `0` for free / fully-discounted items — so a legitimate `0` renders `—` instead of the price. Real bug; use `if (amount == null)`. |
| F3 | defer | none | Scope creep: migrating every price display across billing/pharmacy/inventory/invoices to `PriceTag` is an app-wide refactor beyond this change. Needs a human / separate ticket. |

Address: 1 · Decline: 1 · Defer: 1.
