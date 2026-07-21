---
id: ux-01-medrow-overflow
skill: care-ux-review
tier: judgment
kind: seeded-defect
args: develop
---

# ux-01 — Medication order row (overflow) · IN SCOPE

A billing row on a fixed `w-64` flex container renders a free-text medication `name` (can be long)
with **no `truncate`/`min-w-0`/overflow guard**. Long drug names escape the container and push the
price out — a `Broken` overflow. Squarely in the skill's static overflow rubric; validates the
pipeline. Ground truth: [expected.json](./expected.json).
