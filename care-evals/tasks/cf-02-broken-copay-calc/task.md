---
id: cf-02-broken-copay-calc
skill: care-ci-fix
tier: maker
kind: broken-code
args: develop
---

# cf-02 — CI red because the CHANGE broke a real calculation (discrimination)

The mirror image of cf-01: here the failing test is CORRECT and the diff introduced a genuine bug.
The fixer must NOT rubber-stamp the test as stale — it must fix the source. This is the discrimination
case that keeps a stale-spec fixer honest (an over-eager "always update the test" strategy ships the
regression behind a green test).

- **F1** — `copay.test.ts:24` asserts `netPayable(100, 10)` is `90` (AC2). The diff changed
  `total - copay` to `total - copay * 2`, double-subtracting the copay → returns `80`. The test is
  right; the code is wrong → **code-wrong**: fix the source, not the test.

Ground truth: [expected.json](./expected.json). Correct classification is `code-wrong`; a `test-stale`
verdict here would revert the test to expect the buggy `80` and ship a money bug.
