---
name: care-test-grade
description: Grade the tests for a CARE frontend (care_fe) change — do the specs actually assert the acceptance criteria, or are they green but wrong (trivially-passing, asserting the wrong thing, or rubber-stamping the implementation)? A maker/checker split for tests; can run standalone or as care-loop Step 4.5. Use for "grade the tests", "are these specs any good", "do the tests cover the acceptance criteria", "are these tests green but wrong". Suggests fixes; blocks only on Wrong.
user-invocable: true
argument-hint: "[spec path(s)] — reads criteria from state dir when loop-invoked"
model: opus # declared judgment tier — honored by the invoker (care-loop agent / care-evals --model), not auto-enforced
---

# CARE Test Grade (checker lens)

**Premise: green ≠ correct.** Agent-written specs can pass while asserting the wrong thing, missing
the acceptance criteria, or passing trivially. This skill is the **checker** half of a maker/checker
split for tests: given acceptance criteria + the code's intent + the spec(s), it grades whether the
specs actually hold the change honest. The grader must be a **different** agent than the one that
wrote the specs (checker ≠ maker).

<!-- care-loop:methodology name="default" -->

## Working agreement (applies throughout)

Suggest first, don't edit. Smallest possible fix per finding. Judge the _spec_, not the
implementation — a code bug is routed out, not patched in a test. New/edited test code reads like
the specs around it (`playwright` skill conventions, `CLAUDE.md`).

## Step 1 — Gather the three inputs (triangulate)

1. **Acceptance criteria = ground truth.**
   - **Loop-invoked** (a run dir `<care-loop skill dir>/runs/<repo>-<branch>/` exists): read
     `<run-dir>/criteria.md` (persisted by care-loop Step 1). Do not re-derive them.
   - **Standalone:** take the criteria the user gives; if none, ask for them (what the user can
     _do/see_). Don't invent criteria from the code — that's the circularity this skill exists to
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

- **Coverage** — ≥1 spec asserts it. (Absent → _Missing_.)
- **Assertion strength** — the spec fails if the behavior is wrong; no trivially-green asserts
  (e.g. asserting an element exists when the criterion is about its _value/state_).
- **Faithfulness** — exercises the real user flow, not a shortcut (seeding state directly, asserting
  on an implementation detail the user never sees).
- **Correctness** — no spec contradicts the criteria or asserts unrelated behavior.
- **Edge / negative cases** — the criterion's failure/empty/boundary path, where it has one.

### Faithfulness — does the spec exercise the real user flow?

**Real flow:** user action (click, type, submit) → app handles it → verify outcome

**Shortcuts (flag as Weak or Wrong):**

- **Seeding state directly** — e.g., `page.goto("…?patientId=123")` instead of searching for the patient or logging in
- **Mocking API responses** without going through the real request (bypasses request/response handling)
- **Asserting on internal state** or implementation details (e.g., `store.userCount === 5`) the user never sees
- **Skipping required interactions** — accepting a consent modal, confirming a destructive action — to speed up the test
- **Testing in isolation** — a feature that depends on authentication skips the login flow

**When shortcuts are justified:**
If a flow is blocked by slow/unreliable backend, clarify in the finding: "Backend pagination is timeout-prone; testing with seeded data until pagination stabilizes." Flag for follow-up testing once the backend is fixed.

### Common interaction patterns — checklist

If the spec touches any of these, verify the full pattern is covered:

**Modals:**

- Opened (trigger + appears) + Closed (Escape key, outside click, close button)
- Focus trap maintained inside modal

**Dropdowns:**

- Open (click / arrow key), Select (click / keyboard arrow + Enter), Close (Escape / outside click)
- Focus management when closed

**Tabs:**

- Select (click / arrow keys), Content updates correctly, Focus stays on tab button

**Forms:**

- Validation pre-submit (error feedback shown in real-time), Submission (happy path + error path with retry)
- Form state resets after successful submit (if applicable)

**Lists / Tables:**

- Pagination (prev/next buttons work, page indicator accurate), Sorting (order verified both directions), Filtering (correct items shown)

**Async operations:**

- Loading state shown (spinner / skeleton), Success state (data rendered correctly), Error state (error message + retry shown)

Flag a **Weak** verdict when a pattern is touched but the full interaction isn't tested (e.g., "Modal opens but doesn't test Escape key close"). Flag **Wrong** if a shortcut skips essential user interaction.

**Verdict per criterion — one of:**

| Verdict     | Meaning                                                                                          | Disposition |
| ----------- | ------------------------------------------------------------------------------------------------ | ----------- |
| **Covered** | asserted, strong, faithful                                                                       | —           |
| **Weak**    | covered but the assertion is thin or unfaithful                                                  | advisory    |
| **Missing** | no spec asserts it                                                                               | advisory    |
| **Wrong**   | a spec contradicts the criteria or asserts unrelated behavior (rubber-stamps the implementation) | **blocks**  |

Give the **minimal fix** for every non-Covered verdict.

### Criticality — prioritize the fixes

Not all unmet criteria are equally important. Mark each criterion's criticality so implementers prioritize fixes:

**Critical path:**

- User action (search, submit, confirm, delete) in the main workflow
- Failure means the feature is broken or unusable
- Example: "User can submit the form and see the success message"
- → A `Weak` or `Missing` verdict on a critical path should be highlighted: "Recommend fixing before merge"

**Secondary / edge case:**

- Fallback behavior, error handling, empty states
- Failure means degraded UX, not broken feature
- Example: "Search returns no results → empty state shown"
- → A `Weak` verdict here can ship (good-but-optional fix)

**Polish / rare flow:**

- Uncommon task, nice-to-have, UX quality
- Example: "User can undo the last action"
- → `Missing` verdict can ship; no loopback needed

**Output format:**

```markdown
### Per-criterion verdicts

| Criterion                 | Verdict | Criticality | Finding                                                  |
| ------------------------- | ------- | ----------- | -------------------------------------------------------- |
| User can submit the form  | Weak    | Critical    | Only tests happy path; missing validation error handling |
| Success message appears   | Covered | Critical    | —                                                        |
| Search returns no results | Missing | Secondary   | No spec for empty state (good-to-have)                   |
| Undo last action          | Missing | Polish      | Not in scope for this PR                                 |

### Summary

Critical findings (must fix): 1 (form validation)
Secondary findings (good-to-fix): 1 (empty state)
Polish findings (optional): 1 (undo)
```

This lets implementers fix critical gaps immediately while understanding that secondary/polish gaps can ship.

### Anti-circularity (the core check)

- A spec that matches the **code** but not the **criteria** = rubber-stamping the implementation →
  flag (this is what makes it _Wrong_ or _Weak_, not _Covered_).
- A **criteria-vs-code divergence** = the _implementation_ may be wrong, not the test → route to
  review / confirm with the user; **do not** "fix" it by editing the spec to match the code.

## Step 3 — Report & gate

Lead with the per-criterion verdict table, then the fixes.

**Only `Wrong` blocks.** A spec that contradicts the criteria or asserts unrelated behavior blocks;
everything else (`Missing` / `Weak` / faithfulness) is **advisory** — partial specs are legitimate
(blocking on `Missing` would let one partial spec trigger a full-coverage gate while zero specs skip
it entirely — a perverse incentive).

- **Standalone:** present the table + fixes; don't edit until approved.
- **Loop-invoked (Step 4.5):** `Wrong` specs loop back to the Step-3 E2E author to fix (bounded by
  the convergence guard); advisory findings go in the round summary / PR body. Success adds: _no
  graded spec is `Wrong`; uncovered criteria are listed._ Return the table + block/advisory split to
  the orchestrator — do not confirm with the user.

<!-- /care-loop:methodology -->
