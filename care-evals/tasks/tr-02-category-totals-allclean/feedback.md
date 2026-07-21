# PR #0000 — pre-digested bot feedback   (2026-07-16T00:00:00Z)
# (author · path:line · thread-id · trimmed body) — grouped by file+line; every comment
# kept. [F#] tags are the triage item ids for this fixture.

## Inline comments
- `src/pages/Facility/billing/invoice/components/InvoiceCategoryTotals.tsx:38`
  - **coderabbitai[bot]** (thread 6001)  [F1]
      `amountMinor / 100` performs floating-point division on monetary values, which will accumulate
      rounding drift. Money should never be divided with JS floats — use a decimal library or keep it
      in minor units end-to-end.

- `src/pages/Facility/billing/invoice/components/InvoiceCategoryTotals.tsx:24`
  - **greptile-apps[bot]** (thread 6002)  [F2]
      The `useMemo` dependency array `[lines]` is missing `currency`. Since the component reads
      `currency`, this memo can go stale when the currency changes. Add `currency` to the deps.

- `src/pages/Facility/billing/invoice/components/InvoiceCategoryTotals.tsx:27`
  - **Copilot** (thread 6003)  [F3]
      `byCategory.get(line.category) ?? 0` — the `?? 0` is dead code. Once a category is in the map,
      `get` returns a number, so the nullish fallback never fires. Remove it for clarity.

## Summary comments
- **greptile-apps[bot]** (comment 6004)  [F4]
      Consider extracting a reusable `useCategoryTotals` hook and a shared totals formatter used across
      the entire billing module, with unit tests, so every invoice/statement view shares one grouping
      implementation instead of re-deriving totals per component.
