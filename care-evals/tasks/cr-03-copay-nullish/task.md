---
id: cr-03-copay-nullish
skill: care-review
tier: judgment
kind: seeded-defect
args: develop
---

# cr-03 — Copay notice (nullish-vs-falsy)

Adds a small `CopayNotice.tsx` that shows the copay a patient owes, falling back to the plan default
when the patient has no override. **One planted defect**, deliberately subtle:

1. **Correctness (`||` vs `??`)** — `const copay = patient.copay || defaultCopay`. The doc comment
   states a copay of **0 means the visit is fully covered** — a legitimate value. Because `0` is
   falsy, `||` discards it and charges the plan default instead. Should be `patient.copay ??
   defaultCopay` (nullish coalescing) so only `undefined`/`null` falls back.

This is a recall probe for subtle correctness — the kind of bug a weaker model waves past. Otherwise
the code is clean; a good review flags exactly this and nothing else. Ground truth:
[expected.json](./expected.json).
