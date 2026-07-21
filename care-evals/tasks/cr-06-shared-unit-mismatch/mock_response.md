**Bottom line** — Not mergeable: the two callers of `computeInvoiceTotals` disagree on units, and
one renders amounts 100× too large.

**Intent** — Add a shared `computeInvoiceTotals` (returns minor units / paise) and two consumers: the
print totals block and a compact summary card.

**Worth deciding**
- **Correctness — `InvoiceSummaryCard` does not divide by 100.** The helper's contract returns
  **minor units**; `PrintInvoiceTotals` honors it (`totals.total / 100`), but `InvoiceSummaryCard`
  passes `totals.total` straight to `formatCurrency`, so "Amount due" renders **100× too large**
  (paise shown as rupees). It is inconsistent with `PrintInvoiceTotals`; add the `/ 100`.

**Optional / FYI** — the minor-unit contract is easy to misuse across call sites; a helper returning
a display-ready value (or a shared formatter) would remove the footgun.

**Out of scope** — the shape of `formatCurrency`, styling.
