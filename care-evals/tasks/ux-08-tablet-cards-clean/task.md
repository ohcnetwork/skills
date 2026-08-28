---
id: ux-08-tablet-cards-clean
skill: care-ux-review
tier: judgment
kind: clean-control
args: develop
---

# ux-08 — Patient summary cards (CLEAN tablet control)

The same KPI-card shape as ux-06, done correctly for the middle band:

- three-up engages at **`lg:grid-cols-3`** (≥1024, where there's room), staying single-column through
  the tablet band;
- the flex parent and text column both carry **`min-w-0`**, with **`truncate` + `title`** on the label
  and value;
- the only fixed child is a modest `w-16` chart.

Correct and responsive across mobile / tablet / desktop — a good review returns a **clean pass**. This
is the false-positive probe for the tablet-band tasks: a review that claims an overflow or sibling
collision at 768/tablet here, or demands `min-w-0`/`truncate`/`lg:` (all already present), is wrong.

Ground truth: [expected.json](./expected.json).
