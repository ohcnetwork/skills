# Doctor proposal — 2026-07-28 — care_fe-generic-autocomplete-radio
> No changes applied. Read-only diagnosis for cross-run collation.

**Coverage delta (would-be):** 🟢 +1 · 🟡 +2 · 🔴 0

## Proposed changes
### Would auto-apply (eval-covered)
- **care-triager** (care-triager/SKILL.md): In the methodology name="default" region, after the IMP-17 churn rules, add a 'diminishing-returns tail' rule: once the substantive set has landed (a prior round addressed the high/medium items), if a round's only address items are all severity:none|low, verdict them 'defer' with reason 'low-severity tail - batch to a single follow-up round' rather than spawning a fresh implement+push+CI round per item; only re-open a real round when a medium+ item appears. A round whose sole address is one cosmetic/none item is the cap-burning signal. Also: only attribute missed_by:<lens> to a lens that actually ran this pipeline (IMP-21 secondary).
- **care-diff-review** (care-diff-review/SKILL.md): In 'Secondary - correctness', extend the Spec-boundary rule with a selection/identity check: when a diff changes how a selected value is matched against options (string key -> object, ===/reference equality, .find), trace whether post-refetch object identity breaks the match; a selection that won't re-highlight after a refetch is a Broken correctness finding, never 'verify it matches by key.' Guarded by care-evals cr-08.
- **care-test-grade** (care-test-grade/SKILL.md): When hasSpecs:false AND baseline.md contains a non-trivial 'Test-surface contract' section, return verdict:findings ('specs-owed') listing the unasserted criteria instead of a silent pass. no_specs->pass is only correct when the plan owed no tests.

### Human required
- **care-loop/orchestrator/src (ci-round / budget logic)** (orchestrator-code): When budget.stop max_rounds would fire but the last 2-3 rounds' addressCount is monotonically <=1 and trending to 0, auto-resume one final round instead of terminating 'capped'. In this run (address 9->2->2->1->1->0) the round-6 all-decline convergence proves one more round was all that was needed; the current behavior cost a ~38h human-latency manual resume. Apply via orchestrator edit + npm test.
- **care-loop/orchestrator/src (step-4 wiring)** (orchestrator-code): Gate step 4c (care-ux-review) to run when ui-surfaces.md is non-empty; a UI-changing diff must not reach push without the UX/a11y lens. This run skipped 4c (4a->4b->5) on a net-new radio surface, so aria-hidden/title/aria-label a11y items escaped to bots and were mis-attributed to a lens that never ran. Apply via orchestrator edit + npm test.
- **care-planner** (no-eval-coverage): (Advisory, not diff-graded - BS-3) When the plan declares a Test-surface contract with concrete testids/roles for a net-new component, the planner should mark specs as a required deliverable so the test-grader's specs-owed check (IMP-20) has a criterion to grade against.

### Proposed fixtures
- `cr-08-selection-reference-equality` (verbatim, recurred) for care-diff-review
- `tr-05-lowseverity-tail` (class-sibling) for care-triager
- `tg-05-specs-owed-no-specs` (class-sibling) for care-test-grade

## Findings
- **IMP-19** [dim 4] Loop won't converge while one new low-severity bot item drips in per round: address counts 9->2->2->1->1->0 across 6 rounds, hit budget.stop max_rounds, needed a 38h manual resume; ~$1.26 of $2.19 judgment spend on the last four rounds landed only 3 one-line fixes. Distinct mechanism from IMP-17 (that was re-addressing nits; this is one new severity:none item forcing a full push+CI+re-triage round). — _new · tr-* · inferential_
- **IMP-16** [dim 8] Reviewer hedged the reference-equality selection-matching correctness defect as 'Verify GenericAutocomplete matches by key... plausible regression' (care-reviewer-r1 findings[1]) instead of flagging Broken; the same defect drove the high-severity bot-sourced address in triager-r1 (missedBy:none). Partial regression of the 2026-07-20 fix, which covered tier-boundary off-by-ones but not object-identity/selection-matching. — _re-observed (seen: 2) · ⚠️ REGRESSION · cr-* · inferential_
- **IMP-20** [dim 8] care-test-grader passed silently on hasSpecs:false in 1ms for a net-new GenericAutocomplete<T> plus radio path, despite baseline.md declaring a Test-surface contract (role=radiogroup + data-testids). no_specs->pass is only correct when the plan owed no tests. — _new · tg-* · computational_
- **IMP-21** [dim 4] care-ux-review (4c) never ran (no care-ux-review sidecar; decision 4a->4b->5) despite a non-empty ui-surfaces.md and a net-new radio a11y surface; triager attributed aria-hidden/title/aria-label items to missedBy:care-ux-review, a lens that never ran this pipeline. — _new · n/a · computational_
- **IMP-19b** [dim 6] max_rounds cap fired mid-progress (address still trending 2->1->1) and required a ~38h human resume; round-6 all-decline convergence proves one more round was all that was needed. Auto-resume-once when addressCount trends to zero would remove the human latency. — _new · n/a · computational_

---
# Diagnosis — 2026-07-28 — care_fe-generic-autocomplete-radio

diagnosed-by: claude-opus-4.8
evidence: journal.jsonl / loop.log (197 events) · state.json · verdicts.md (round 6) · skills/care-{planner,reviewer,test-grader,triager-r1..r6,implementer}.result.json · criteria.md · baseline.md · decisions.md

Outcome: **converged** (PR #16582) — but only after `budget.stop max_rounds` at round 5 and a **~38-hour manual resume** (run.end capped 2026-07-18 20:30 → run.resume 2026-07-20 10:48). Judgment spawns all ran on Opus (dim 1 clean); state is script-shaped (dim 5 clean); no crash/torn tail (dim 2 clean). All problems are in the feedback-round tail (dims 4/6/8) plus one planning/test-surface gap.

## Findings (ranked by impact)

### 1. [dim 4/6] Six rounds to converge; capped + manual resume; ~85% of triage spend moved almost no behavior
Behavioral fixes were essentially complete by end of round 2. Rounds 3–6 each addressed only a single drip-fed new bot item (r3 uncontrolled CommandInput; r4 onSearch('') on close; r5 id={option.key} DOM-id; r6 zero) while re-declining 15–20 already-resolved threads every round. Triager address/decline per round: 9/3 → 2/8 → 2/17 → 1/20 → 1/15 → 0/17. budget.stop max_rounds fired (loop.log:179), run.end capped (180), run.resume 38h later (181). Cumulative usd_est $0.93 (r1) → $2.19 (r6): the four tail rounds cost ~$1.26 to land 3 one-line fixes. Distinct from IMP-17 (that was re-addressing nits; this is one new severity:none item forcing a full push+CI+re-triage round). → IMP-19.

### 2. [dim 6] max_rounds too tight / no auto-resume
Still making real (tiny) progress at round 5 when the cap fired; round-6 all-decline convergence proves ~1 round from done. The 38h gap is pure human latency. → IMP-19 propose-only (auto-resume-once).

### 3. [dim 8] Reviewer hedged two real correctness defects as 'verify…' notes; substantive fixes were bot-driven
care-reviewer-r1 identified reference-equality selection matching and the eager-fetch/showRadio count gate, but filed both as 'Verify…/Confirm…' hedges, not Broken. The actual address-driving verdicts came from the bot pile (triager-r1 items 1 & 3, severity:high, missedBy:none). Re-observation of IMP-16 (applied 2026-07-20): the tier-boundary rule landed but object-identity/selection-matching correctness still gets hedged. Bump seen:2, flag partial regression. Verbatim MRE available in skills/care-reviewer-r1.input.json → fixture cr-08.

### 4. [dim 4/8] care-ux-review (4c) skipped on a UI diff; a11y items escaped and were mis-attributed
No care-ux-review sidecar; decision 4a→4b→5. Triager attributed aria-hidden/title/aria-label items to missedBy:care-ux-review — a lens that never ran. ui-surfaces.md is present and non-empty. → IMP-21.

### 5. [dim 8/4] test-grader passed silently on no_specs for a net-new component
care-test-grader-r1: hasSpecs:false → pass in 1ms for net-new GenericAutocomplete<T> + radio path, despite baseline.md's Test-surface contract (role=radiogroup + data-testids). no_specs→pass is only correct when the plan owed no tests. → IMP-20.

## Healthy signals
- Model tier held: every judgment spawn on Opus; plan.approved by Claude Opus 4.8. Dim 1 clean.
- State script-shaped: integer pr 16582, in-vocab step, owner/name repo, fresh updated_at, head_sha present. IMP-3 holds.
- Clean termination + safe resume: run.end converged; the 38h resume re-entered at step=5 and re-verified CI rather than redoing work. IMP-2 holds.
- Gate discipline: every push preceded by run_gate.sh exit 0; round-1 lint FAIL auto-looped-back to a clean re-gate — IMP-18's eslint --fix pass working.
- Per-item triage was correct: mass declines were right (already-fixed / withdrawn / out-of-scope), each code-cited. The waste is structural (round granularity), not per-item misjudgment.

## Manifest (report/proposal mode — nothing applied)
- Eval-covered edits described concretely (would auto-apply): care-triager (IMP-19 tail rule + IMP-21 attribution note), care-diff-review (IMP-16 selection-equality extension), care-test-grade (IMP-20 specs-owed).
- Propose-only (loopd, needs npm test): budget auto-resume-once; 4c gating on non-empty ui-surfaces.md.
- Fixtures: cr-08 verbatim (trusted, from care-reviewer-r1.input.json); tr-05 + tg-05 class-sibling hypotheses (trust on recurrence).
- New: IMP-19/20/21. Re-observed: IMP-16 (seen:2, partial regression). IMP-17 family related but not re-triggered (triager declined the churn correctly per-item).
- Nothing was written — no skill edits, no IMPROVEMENTS.md/HARNESS-COVERAGE.md mutation, no fixtures, no git.