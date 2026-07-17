# care-ci-fix — CI failure fixer for the care-loop

Step 6b CI-fix track: when all bot review feedback has been addressed (6a verdicts clean) but remote
CI is still red, this skill reads the failing check's annotations and decides whether the **test** or
the **code** needs updating, then makes the bounded edit.

<!-- care-loop:methodology name="default" -->

## 1. Classification — the one judgment that matters

You receive:
- The **failing CI checks** with their annotations (file, line, assertion message).
- The **diff** of the change (`<base>...HEAD`).
- The **acceptance criteria** and **decisions** from the approved plan.

For each failing check / annotation, classify it into exactly one category:

### A. Test is stale (most common)
The test asserts the OLD behaviour that the change intentionally replaced. The plan's acceptance
criteria confirm the new behaviour is correct.

**Action:** update the **spec file** to assert the new expected value. Change ONLY the assertion(s)
that fail — do not rewrite surrounding test structure, add new tests, or refactor the spec.

### B. Code is wrong
The test is correct — the change actually broke intended behaviour. The assertion failure reveals a
real bug in the source code.

**Action:** fix the **source file** to satisfy the test's assertion. Minimal edit — do not refactor
or add unrelated improvements.

### C. Infra / flake
The failure is unrelated to the change: network timeout, backend down, CI runner OOM, a flaky test
that fails intermittently regardless of the diff.

**Action:** do NOT edit anything. Return outcome `noop` so the loop hands off to a human rather than
making a spurious edit.

## 2. Decision procedure

1. Read each annotation's `path:line` + `message` (the assertion error).
2. Check whether the annotated file/line is in the diff or is a test that asserts a value the diff
   changed. If yes → likely A or B. If the file is unrelated to the diff → likely C.
3. Cross-reference the plan's **acceptance criteria**: does the new behaviour (what the diff does)
   match the criteria? If the test asserts the old value and the criteria say the new value is
   correct → **A (test stale)**. If the criteria agree with the test → **B (code wrong)**.
4. If no plan context is available, reason from the diff: does the change intentionally alter the
   value the test checks? If yes → A. If the change is unrelated to the assertion → C.

## 3. Guardrails — hard constraints on every edit

- **NEVER edit CI config or workflows** (`.github/**`, `.circleci/**`, `Jenkinsfile`, etc.).
- **NEVER weaken a test to pass**: no `.skip`, `test.fixme`, `test.todo`, `xtest`, `xit`, deleting
  assertions, or wrapping assertions in try/catch. You may ONLY update an assertion's expected value
  to the new intended value, or fix source code.
- **Scope = the failing check's files only.** Edit only the files cited in the annotations or the
  source files directly responsible for the assertion failure. No repo-wide refactors.
- **Plan authority**: if updating the test would contradict the acceptance criteria or decisions
  (the plan says the value SHOULD be X but the test expects X and the code produces Y), do NOT
  change the test — the code is wrong (category B). If you cannot reconcile, return `handoff`.
- **One or two files max.** If the fix requires touching more than two files, return `handoff` —
  the failure is too complex for a bounded automated fix.

## 4. Output contract

Your edit should be the minimal change that makes the failing check pass:
- For category A: update the assertion expected value(s) in the spec file.
- For category B: fix the source code to satisfy the test's assertion.
- For category C: make NO edits.

After editing, stop. The orchestrator handles commit, gate, push, and the next CI round.

<!-- /care-loop:methodology -->
