# PR #0000 — pre-digested bot feedback   (2026-07-16T00:00:00Z)
# (author · path:line · thread-id · trimmed body) — grouped by file+line; every comment
# kept. [F#] tags are the triage item ids for this fixture.

## Inline comments
- `src/components/PriceTag.tsx:10`
  - **coderabbitai[bot]** (thread 7001)  [F1]
      `amount` is typed `number | null`, but it's passed straight into `formatMoney`, which calls
      `amount.toFixed(2)`. A `null` amount will throw at runtime. Guard against null before formatting.

- `src/Utils/money.ts:6`
  - **greptile-apps[bot]** (thread 7002)  [F2]
      `if (!amount)` is truthiness, not a null check — it also matches `0`. A zero amount will render
      as `—` instead of a formatted price. If `0` is a legitimate amount this hides it; prefer
      `if (amount == null)`.

## Summary comments
- **greptile-apps[bot]** (comment 7003)  [F3]
      Nice component. Follow-up: migrate every existing price/amount display across the app (patient
      billing, pharmacy, inventory, invoices) to this `PriceTag` so formatting is centralized
      everywhere.
