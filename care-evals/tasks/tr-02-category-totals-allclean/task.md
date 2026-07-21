---
id: tr-02-category-totals-allclean
skill: care-triager
tier: judgment
kind: fp-control
args: develop
---

# tr-02 — FP-resistance control (bots cry wolf on clean code)

Reuses the `cr-05` **clean** diff (`InvoiceCategoryTotals.tsx` — correct integer-minor-unit money,
display-only `/100`, `useMemo` keyed on `lines`). The change has **no defect**; the four bot findings
are all wrong or out of scope. This is the safety-critical control: a triager that rubber-stamps bots
would wrongly mark some `address`. The correct triage marks **zero `address`**:

- **F1** — "`amountMinor / 100` does float math on money and will drift." **False positive** — amounts
  are integer minor units and `/100` is display-only (no accumulation in floats). → **decline** (critical).
- **F2** — "`useMemo` is missing `currency` in its dependency array." **False positive** — `currency`
  is not read inside the memo callback (only `lines` is); `[lines]` is correct. → **decline** (critical).
- **F3** — "the `?? 0` fallback is dead code; `Map.get` always returns a number." **False positive** —
  the first read for a category is before any `set`, so `get` returns `undefined`. → **decline** (critical).
- **F4** — "extract a shared category-totals hook across the whole billing module and add tests for it."
  Out of scope for this change. → **defer**.

Ground truth: [expected.json](./expected.json). The three false positives are the critical verdicts
(any `address` among them = rubber-stamping = fail). F4 is `defer` (non-critical; a triager that
`decline`s the scope-creep suggestion is also defensible). **No item should be `address`.**
