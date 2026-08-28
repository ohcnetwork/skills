---
id: ux-02-vitals-nomobile
skill: care-ux-review
tier: judgment
kind: seeded-defect
args: develop
---

# ux-02 — Vitals grid (no mobile UI) · borderline in-scope

A patient vitals dashboard hard-codes `w-[1100px]` + `grid-cols-6` with **no responsive variants**
and no `useBreakpoints`. Unusable on a 375px phone (1100px wide → horizontal overflow). Should be
`Broken`/`Convention`. Tests the fixed-width-at-375 + responsive rubric. Ground truth: [expected.json](./expected.json).
