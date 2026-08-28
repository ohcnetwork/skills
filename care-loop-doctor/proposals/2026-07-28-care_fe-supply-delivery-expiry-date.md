# Doctor proposal — 2026-07-28 — care_fe-supply-delivery-expiry-date
> No changes applied. Read-only diagnosis for cross-run collation.

**Coverage delta (would-be):** 🟢 0 · 🟡 +1 · 🔴 0

## Proposed changes
### Would auto-apply (eval-covered)
- **care-diff-review** (/Users/jacob/.claude/skills/care-diff-review/SKILL.md): In the loaded methodology name="default" region, section '### Secondary — correctness', INSERT a new paragraph AFTER the existing 'Spec-boundary check' paragraph (currently ending ~L138, before '### Refactor-safety mode'). NEW paragraph verbatim: '**Date-only parsing check.** When a diff formats or compares a date field that the BE serializes as a **date-only** string (`YYYY-MM-DD` — e.g. `expiration_date`, `date_of_birth`, `*_date` without a time), flag any `new Date(str)` / `Date.parse(str)`: those parse date-only strings as **UTC midnight**, shifting the displayed day by one in negative-UTC-offset timezones. The date-only-safe form is `parseISO(str)` (date-fns, parses as local). A `new Date()` on a date-only BE field is a `Broken` correctness finding, not Polish — you can see the field''s shape from the type/usage, so derive it rather than assuming a datetime.' Rationale: reviewer-r1 had `formatDate(new Date(expiry), …)` in the diff, produced 3 co-located findings, but not this one. Eval-covered (cr-*) so it would auto-apply; proposed only in report mode. Guarded by proposed fixture cr-08-date-only-utc-parse.

### Human required
- **care-planner/SKILL.md (planning methodology — NOT diff-graded, BS-3)** (no-eval-coverage): In the planner's approach-authoring guidance, add a one-liner: 'When the approach reuses a date-formatting pattern, confirm the source field''s serialization — date-only BE fields (YYYY-MM-DD, e.g. expiration_date, *_date) must be parsed with `parseISO`, never `new Date`, to avoid a UTC-midnight day shift.' The approved planner-r2 approach (step 2) literally prescribed `formatDate(new Date(value), "dd/MM/yyyy")`, so the reviewer/triager were cleaning up after the plan. Nothing verifies the planner offline (BS-3), so advisory / human-review only.
- **care-triager/SKILL.md (attribution guidance)** (coherence): Add a rule: reserve `missed_by: novel` for causes NOT present in the reviewed diff. If the offending line is in a diff a lens saw (here `new Date(expiry)` was in reviewer-r1.input.json), attribute to that lens (care-reviewer), never `novel` — else the dim-8 escape signal is hidden. tr-* is eval-covered but this is a wording clarification; proposed for review rather than auto-applied in report mode.

### Proposed fixtures
- `cr-08-date-only-utc-parse` (verbatim) for care-diff-review

## Findings
- **IMP-19** [dim 8] Plan prescribed `new Date(expiry)` on a date-only BE string (UTC-midnight day-shift bug); reviewer read the exact diff line and produced 3 co-located findings but never flagged the date-parse defect. CodeRabbit caught it (Major); triager-r1 verdicted address/high but mis-attributed missed_by:novel, hiding both the planner and reviewer miss. Class-sibling of IMP-16 (reviewer under-calling a date/number-correctness trap it had the code for). Correct label: missed_by:care-reviewer. — _new · BS-3 · inferential_
- **IMP-19** [dim 8] Triager wrote missed_by:novel for a defect visible in the reviewed diff, corrupting the dim-8 cross-run escape signal (an escape recorded as un-catchable). `novel` should be reserved for causes not present in the diff a lens saw; here the line was in reviewer-r1.input.json. — _new · tr-* · inferential_

---
Diagnosis — 2026-07-17 — care_fe-supply-delivery-expiry-date

diagnosed-by: Claude Opus 4.8 (github-copilot/claude-opus-4.8)
mode: report / proposal (no-apply — edited nothing)
evidence: journal.jsonl (78 loop.log events) · state.json · verdicts.md · feedback.md · skills/{care-planner-r1/r2, care-reviewer-r1, care-triager-r1/r2, implementer-r1}.{input,result}.json

## Outcome
Clean run.end converged at step 7 after 2 rounds (2026-07-17 05:50 → 06:26, ~36 min wall, mostly CI waits). PR #16579, CI green both rounds, all threads triaged clean (r2: address=0 decline=1). Judgment cost_cum ≈ $0.81 (Opus spawns; Sonnet maker unmetered per rubric dim 3). A textbook trivial-tier run.

## Findings (ranked by impact)

1. [dim 8 — escape attribution] The plan PRESCRIBED `new Date(expiry)` on a date-only string, and the reviewer read the exact line without flagging the timezone shift; CodeRabbit caught it. NEW.
   The approved planner-r2 approach (step 2) says: render `formatDate(new Date(value), \"dd/MM/yyyy\")` — reusing the created/dispatched-date pattern. The implementer followed it. `expiration_date` is a date-only string (\"2025-12-31\"); `new Date(\"2025-12-31\")` parses as UTC midnight, shifting the displayed day back one in negative-offset timezones. CodeRabbit flagged it (thread 3600714101, Major); triager-r1 verdicted address/high but attributed missed_by:novel — wrong: the line `formatDate(new Date(expiry), …)` was in reviewer-r1.input.json. The reviewer produced 3 findings on the same cell (IIFE legibility, i18n key, format-string constant) but not the date-parse bug. Two roots: (a) care-planner recommended the defect, (b) care-reviewer missed it; the triager's novel label hid both. Class-sibling of IMP-16 (format-patient-age): reviewer under-calling a date/number-correctness trap it had the code for. IMP-16's Spec-boundary check does not cover date-only-string parsing.
   evidence: skills/care-planner-r2.result.json (approach step 2) · skills/care-reviewer-r1.result.json (3 findings, none date-parse) · skills/care-reviewer-r1.input.json (MRE) · skills/care-triager-r1.result.json (missedBy:novel, severity high) · feedback.md L11

2. [dim 8 — attribution quality] Triager wrote missed_by:novel for a defect visible in the reviewed diff, corrupting the dim-8 cross-run signal. novel should mean not-present-in-the-diff; here the line was right there. Minor; reserve novel for genuinely un-inspectable causes.
   evidence: verdicts.md · triager-r1 item.

## Healthy signals
- Model tier held. planner r1/r2, reviewer r1, triager r1/r2 all on claude-opus-4.8, modelPinSatisfied:true. Maker on Sonnet. No plan_wrong_tier. (dim 1)
- Clean termination, no resume — single process, run.end converged, no torn tail. (dim 2)
- Tight economy — 2 rounds, no retries/escalates, $0.81. address→fix→converge in one round. (dim 3)
- Gate discipline — every push preceded by run_gate.sh exit-0 (seq 31, 57). (dim 4)
- verdicts.md written both rounds with class·missed_by·severity (IMP-15 holding); reply+resolve ran. The real escape was fixed r1 and declined-by-citation r2.
- Reviewer legibility call was fair (inline IIFE Polish note); loop correctly did not loop back on Polish.

## Proposed changes (all propose-only — edited nothing)

Would auto-apply (eval-covered):
A. care-diff-review/SKILL.md '### Secondary — correctness' (methodology name=\"default\" region) — insert a Date-only parsing check after the Spec-boundary paragraph (see skillEdits note). Maps to new IMP-19. Guarded by fixture B.

Fixtures:
B. care-evals/tasks/cr-08-date-only-utc-parse — verbatim MRE from care-reviewer-r1.input.json; expected findings/Broken with must_flag: date-only-utc-parse. First-observation escape with committed verbatim guard (same discipline as IMP-16 cr-07).

Human-required (propose-only):
C. care-planner/SKILL.md — approach note on date-only fields (NOT diff-graded, BS-3; advisory).
D. care-triager/SKILL.md — reserve missed_by:novel for causes not in the reviewed diff (Finding 2).

Backlog delta (proposed, not written):
## IMP-19 · Reviewer misses `new Date()` on date-only BE strings (UTC day-shift); planner prescribed it
status: open · first-seen: 2026-07-17 · seen: 1 · dimension: 8
evidence: this report · care-reviewer-r1.{input,result}.json · care-triager-r1.result.json (mis-labeled novel)
proposed edit: care-diff-review/SKILL.md Date-only parsing check (§A); care-planner note (§C, propose-only); care-triager novel rule (§D)
fixture: care-evals/tasks/cr-08-date-only-utc-parse (§B)
note: class-sibling of IMP-16.

Coverage delta: +1 yellow — cr-08 would extend the cr-* reviewer task set with a date-only-parse guard (flips 🟡→🟢 for the date-correctness sub-class once the before/after delta is measured against a reachable opencode serve).

Nothing was edited. No skill files, IMPROVEMENTS.md, HARNESS-COVERAGE.md, fixtures, or run-dir artifacts were touched; no git/gh/npm/evals were run.