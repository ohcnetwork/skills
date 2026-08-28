---
id: ux-04-bp-wizard
skill: care-ux-review
tier: judgment
kind: seeded-defect
args: develop
---

# ux-04 — Record-BP wizard (navigation burden) · GAP PROBE (hospital context)

Splits one blood-pressure reading (systolic/diastolic/pulse) into a **4-screen wizard** — 4 screens
+ 4 taps for what is one short form. Layout/a11y are clean; the defect is pure **workflow
inefficiency**: in a hospital, every extra screen per vitals entry is time taken from patient care.
The current skill rubric is layout/overflow/a11y only — **no workflow-efficiency check** — so this is
expected to be MISSED until the skill is extended. Ground truth: [expected.json](./expected.json).
