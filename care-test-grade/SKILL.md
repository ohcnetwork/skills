---
name: care-test-grade
description: Grade the tests for a CARE frontend (care_fe) change — do the specs actually assert the acceptance criteria, or are they green but wrong (trivially-passing, asserting the wrong thing, or rubber-stamping the implementation)? A maker/checker split for tests; can run standalone or as care-loop Step 4.5. Use for "grade the tests", "are these specs any good", "do the tests cover the acceptance criteria", "are these tests green but wrong". Suggests fixes; blocks only on Wrong.
user-invocable: true
argument-hint: "[spec path(s)] — reads criteria from state dir when loop-invoked"
---

# CARE Test Grade (checker lens)

**Premise: green ≠ correct.** Agent-written specs can pass while asserting the wrong thing, missing
the acceptance criteria, or passing trivially. This skill is the **checker** half of a maker/checker
split for tests: given acceptance criteria + the code's intent + the spec(s), it grades whether the
specs actually hold the change honest. The grader must be a **different** agent than the one that
wrote the specs (checker ≠ maker).

## Working agreement (applies throughout)

Suggest first, don't edit. Smallest possible fix per finding. Judge the *spec*, not the
implementation — a code bug is routed out, not patched in a test. New/edited test code reads like
the specs around it (`playwright` skill conventions, `CLAUDE.md`).

## Step 1 — Gather the three inputs (triangulate)

1. **Acceptance criteria = ground truth.**
   - **Loop-invoked** (a run dir `<care-loop skill dir>/runs/<repo>-<branch>/` exists — see
     care-loop's `guides/observability.md`): read `<run-dir>/criteria.md` (persisted by care-loop
     Step 1). Do not re-derive them.
   - **Standalone:** take the criteria the user gives; if none, ask for them (what the user can
     *do/see*). Don't invent criteria from the code — that's the circularity this skill exists to
     catch.
2. **Code-reconstructed intent = cross-check.**
   - **Loop-invoked:** read `<run-dir>/intent.md` (written by `care-diff-review` at
     Step 4). Reuse it — no second reconstruction.
   - **Standalone:** reconstruct a light intent from the diff, or invoke `care-diff-review`.
3. **The spec(s)** under grade — the Playwright spec(s) (and vitest once it lands). Loop-invoked:
   the specs from Step 3.

Grade **only when specs exist** — the e2e track is optional, so "no specs" is not a failure here.

## Step 2 — Grade each acceptance criterion

For every criterion, assess:

- **Coverage** — ≥1 spec asserts it. (Absent → *Missing*.)
- **Assertion strength** — the spec fails if the behavior is wrong; no trivially-green asserts
  (e.g. asserting an element exists when the criterion is about its *value/state*).
- **Faithfulness** — exercises the real user flow, not a shortcut (seeding state directly, asserting
  on an implementation detail the user never sees).
- **Correctness** — no spec contradicts the criteria or asserts unrelated behavior.
- **Edge / negative cases** — the criterion's failure/empty/boundary path, where it has one.

**Verdict per criterion — one of:**

| Verdict | Meaning | Disposition |
|---|---|---|
| **Covered** | asserted, strong, faithful | — |
| **Weak** | covered but the assertion is thin or unfaithful | advisory |
| **Missing** | no spec asserts it | advisory |
| **Wrong** | a spec contradicts the criteria or asserts unrelated behavior (rubber-stamps the implementation) | **blocks** |

Give the **minimal fix** for every non-Covered verdict.

### Anti-circularity (the core check)

- A spec that matches the **code** but not the **criteria** = rubber-stamping the implementation →
  flag (this is what makes it *Wrong* or *Weak*, not *Covered*).
- A **criteria-vs-code divergence** = the *implementation* may be wrong, not the test → route to
  review / confirm with the user; **do not** "fix" it by editing the spec to match the code.

## Step 3 — Report & gate

Lead with the per-criterion verdict table, then the fixes.

**Only `Wrong` blocks.** A spec that contradicts the criteria or asserts unrelated behavior blocks;
everything else (`Missing` / `Weak` / faithfulness) is **advisory** — partial specs are legitimate
(blocking on `Missing` would let one partial spec trigger a full-coverage gate while zero specs skip
it entirely — a perverse incentive).

- **Standalone:** present the table + fixes; don't edit until approved.
- **Loop-invoked (Step 4.5):** `Wrong` specs loop back to the Step-3 E2E author to fix (bounded by
  the convergence guard); advisory findings go in the round summary / PR body. Success adds: *no
  graded spec is `Wrong`; uncovered criteria are listed.* Return the table + block/advisory split to
  the orchestrator — do not confirm with the user.
