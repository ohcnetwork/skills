---
id: tr-03-pricetag-cross-file
skill: care-triager
tier: judgment
kind: cross-file-coupling
args: develop
---

# tr-03 — Cross-file coupling (the verdict lives in the sibling file)

A two-file change: `src/Utils/money.ts` adds `formatMoney(amount, currency)`, and
`src/components/PriceTag.tsx` renders it. Two of the bot findings can **only be verdicted correctly by
reading the OTHER changed file** — the §3 coupling case the fan-out gives every map fork the full diff
to handle:

- **F1** — CodeRabbit, on `PriceTag.tsx`: "`amount` can be `null` → `formatMoney` will crash on
  `.toFixed`." Reading `PriceTag.tsx` alone, this looks plausible. But `money.ts` (the sibling) guards
  `if (!amount) return "—"`, so `null` is handled. **False positive → decline** (critical). A triager
  that only reads the commented file gets this wrong.
- **F2** — Greptile, on `money.ts`: "`if (!amount)` treats `0` as empty, so a `0` amount renders `—`
  instead of the price." Reading `money.ts` alone this is ambiguous (maybe 0 shouldn't display). But
  `PriceTag.tsx`'s prop comment says amount **is 0 for free / fully-discounted items** — so 0 is a
  legitimate value that must render, and `!amount` is a real bug. **Valid → address** (critical). The
  validity is confirmed only by the sibling file.
- **F3** — Greptile summary: "migrate every price display in the app to `PriceTag`." Out of scope for
  this change. **defer**.

Ground truth: [expected.json](./expected.json). F1 (`decline`) and F2 (`address`) are the critical
cross-file verdicts; F3 is scope-creep `defer`. This is the task that fails a triager which judges each
finding against only its own file.
