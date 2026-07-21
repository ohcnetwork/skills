---
id: cr-07-age-tier-boundary
skill: care-review
tier: judgment
kind: seeded-defect
args: develop
source_run: care_fe-format-patient-age (PR #16578)
source_report: care-loop-doctor/diagnoses/2026-07-20-care_fe-format-patient-age.md
---

# cr-07 — Patient age tier boundary (computed-unit off-by-one)

Verbatim MRE of a real escape: in the `format-patient-age` run the reviewer (care-reviewer-r1)
flagged double-space suffixes and magic numbers but **missed** the tier-boundary off-by-one that
Greptile/Copilot caught. **One planted defect**:

1. **Correctness (computed-tier boundary off-by-one)** — the years+months tier is *gated* on a raw
   day count (`totalDays >= 364`) but *displays* `years = diff('years')`, which is still `0` at 364
   days. So a 364-day-old renders `0Y 11mo` where the spec ("12 months to 16 years") requires `1Y`
   (0 months suppressed). The gate should be on the shown unit — `years >= 1` — not `totalDays >= 364`.

This is the class the reviewer lens missed in the live run. Distinct from cr-04 (a simple pager
offset): here the gate and the displayed unit are *different units*, so the boundary only misfires
for the sub-year calendar edge. Ground truth: [expected.json](./expected.json).
