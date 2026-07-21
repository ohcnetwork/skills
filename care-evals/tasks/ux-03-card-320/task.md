---
id: ux-03-card-320
skill: care-ux-review
tier: judgment
kind: seeded-defect
args: develop
---

# ux-03 — Appointment card (breaks on small phones) · GAP PROBE

`w-[360px]` + `px-6` **fits at 375px but overflows a 320px device** (older/smaller Android + iPhone
SE-class). The skill's static rubric explicitly targets **375px**, so it may not reason about sub-375
devices — this fixture probes that gap. A `hit` requires the review to flag the small-device (<375)
breakage specifically, not just "fixed width". Ground truth: [expected.json](./expected.json).
