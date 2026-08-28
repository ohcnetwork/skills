**Bottom line** — Not mergeable: a tier-boundary off-by-one renders `0Y 11mo` instead of `1Y` at the 12-month boundary.

**Intent** — Render a patient age string; the "12 months to 16 years" tier shows years+months with 0 months suppressed (so `1Y` at exactly one year).

**Worth deciding**
- **Correctness — computed-tier boundary off-by-one.** The tier is gated on `totalDays >= 364` but
  displays `years = diff('years')`, which is still `0` at 364 days. So a 364-day-old renders
  `0Y 11mo` where the spec requires `1Y`. Gate on the shown unit — `years >= 1` — not the raw day
  count.

**Optional / FYI** — none.

**Out of scope** — the months+days fallback tier for ages under one year.
