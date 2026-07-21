---
id: cf-03-flaky-device-list
skill: care-ci-fix
tier: maker
kind: flake-control
args: develop
---

# cf-03 — CI red from a FLAKE unrelated to the change (the "don't edit" control)

The false-positive-avoidance control. The diff is a trivial button-label change on the location form;
the red check is an e2e on the **device list** — a different flow the diff never touches — failing on a
backend `503` / timeout. The fixer must NOT edit anything: classifying this as `test-stale` or
`code-wrong` would produce a spurious edit over a transient infra failure.

- **F1** — `deviceList.spec.ts:88` times out waiting for rows because the device-list request returned
  `503` this run (passed on the prior run at the same SHA). Unrelated to the diff → **infra**: make no
  edit; the loop re-polls or hands off.

Ground truth: [expected.json](./expected.json). Correct classification is `infra` (no edit). This is
the ci-fix analogue of care-review's clean control — the task that catches an over-eager fixer.
