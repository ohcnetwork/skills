---
id: tr-01-invoice-discount-feedback
skill: care-triager
tier: judgment
kind: mixed-feedback
args: develop
---

# tr-01 — Triage bot feedback on the invoice-discount change

Reuses the `cr-01` seeded-defect diff (a new `InvoiceDiscountSummary.tsx`, whose three planted
defects are already ground-truthed) and layers **five bot findings** on it — a realistic mix the
triager must sort into `address` / `decline` / `defer` by verifying each against the actual code,
not by trusting the bot:

- **F1** — CodeRabbit flags the real money bug: the `percentage` strategy multiplies by `rate`
  without `/100`, over-discounting ~10×. Valid, in-scope, a real correctness defect → **address**
  (critical).
- **F2** — Greptile flags the `DiscountStrategyFactory` + registry as needless abstraction for one
  strategy. Valid overengineering → **address**.
- **F3** — Copilot flags `validateTotals` as misleadingly named (it validates nothing). Valid
  legibility → **address**.
- **F4** — CodeRabbit claims the totals "recompute on every render; wrap in `useMemo`." **Factually
  wrong** — the component already wraps `validateTotals` in `useMemo(..., [lines, discountPercent])`.
  A verifiable false positive → **decline** (critical).
- **F5** — Greptile suggests refactoring the whole billing module onto a shared `DiscountService`
  and adding e2e coverage for every future discount kind. Out of scope for this change → **defer**
  (critical).

Ground truth: [expected.json](./expected.json). `address` on the real bug, `decline` on the
provably-wrong `useMemo` nag, and `defer` on the scope-creep are the three critical verdicts; the
overengineering/legibility items are also `address` but non-critical (a triager that declines them
as "not worth it" is defensible, so they inform accuracy without gating). missed_by attribution is
recorded but not graded in v1 (the FSM branches on verdicts; verdict accuracy is the provable signal).
