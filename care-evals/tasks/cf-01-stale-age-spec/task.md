---
id: cf-01-stale-age-spec
skill: care-ci-fix
tier: maker
kind: stale-spec
args: develop
---

# cf-01 — CI red on a stale e2e assertion (the common case)

The change intentionally reformats patient age from the abbreviated `25 Y` to the spelled-out
`25 years` (AC1). Bots are clean; remote CI is red because a Playwright spec still asserts the OLD
string — a **stale assertion**, the single most common autonomous-convergence blocker (the motivating
run in `PLAN-ci-fix.md` §0).

- **F1** — `patientRegistration.spec.ts:352` asserts `toHaveText('25 Y')`; the app now renders
  `25 years`. The acceptance criteria confirm the new value is intended → **test-stale**: update the
  spec's expected value, do NOT touch the source.

Ground truth: [expected.json](./expected.json). The one gradeable signal is the classification — get
`test-stale` (fix the test) rather than `code-wrong` (which would revert an intended change).

Self-contained: `change.diff`, `failures.md`, `criteria.md` are inlined by the runner — no live
care_fe checkout needed (classification is judged from the diff + annotations + criteria).
