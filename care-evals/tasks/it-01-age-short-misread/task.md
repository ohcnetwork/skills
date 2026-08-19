---
id: it-01-age-short-misread
skill: care-intent
tier: maker
kind: reconstruct
args: change.diff
---

# it-01 — Age "short" mode: reconstruct the real behavior, not the surface

A two-file diff that _looks_ like "adds a `short` age format": `formatPatientAge` gains a `short`
option and `PatientCard` starts passing `{ short: true }`. The surface reading — "abbreviated age
display" — is wrong in two ways the code makes plain:

1. **short mode returns the bare year count with NO unit** — `return \`${years}\`` (not `${years}Y`).
   So an age that reads `3Y` normally now renders `3`.
2. **for a patient under one year it returns `"0"`** — the `short` branch runs before the
   `months > 0` / `days` fallbacks, so a 3-month-old renders `0`, silently dropping the sub-year
   precision the normal path shows.

This is the care-intent guard: reconstruct what _this_ control flow does, not what the option name
suggests. In the salvage flow this reconstruction is what the human gate checks against a possibly
stale PR description (e.g. one that claims "abbreviated age with unit") — so the reconstruction must
report the real, narrower, slightly-buggy behavior and flag it as worth confirming.

Ground truth: [expected.json](./expected.json). A correct reconstruction states the no-unit behavior
(the non-negotiable `critical_must_flag`) and the infant `"0"` regression; it must NOT assert the
misreadings (keeps a unit / adds localization).
