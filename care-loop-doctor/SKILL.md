---
name: care-loop-doctor
description: Self-diagnosis for care-loop — read a headless loopd run's journal (journal.jsonl + skills/*.json sidecars + state.json + loop.log), judge it against a rubric, persist findings as memory, and apply improvements behind one human gate. Use for "diagnose the loop", "why did the loop do X", "loop retro", "improve care-loop from this run". Standalone — does not run the loop.
user-invocable: true
argument-hint: "[run-dir slug or path]"
---

# CARE Loop Doctor (diagnose → gated self-improvement)

Turn a **loopd** run's on-disk trace into (1) a diagnosis report, (2) durable memory, and (3) — with
**one human gate** — applied improvements to the loop's files. Standalone from the loop; `diagnoses/`
is the seed memory for the eventual self-improving-agent merge.

Diagnosis is **judgment work** — run on a strong model, and record `diagnosed-by: <model>` in the
report header (same honesty rule as the loop's `planned-by:`).

## Evidence — a loopd run dir is self-contained

loopd is headless and writes a first-class, structured trace _built for this skill_
([skill-log.ts] header: "SKILL SELF-IMPROVEMENT"). There is no chat session to reconstruct and no
pairing step — everything is in `care-loop/runs/<repo>-<branch>/`:

| Tier  | Source                                                                                                                | What it gives                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **J** | `journal.jsonl` (hash-chained events) + `skills/<role>-r<N>.result.json` sidecars + `state.json` + `loop.log`         | the exact step/spawn/decision timeline, per-spawn `model_used` + `modelPinSatisfied`, verdicts + reason codes, durations, findings, CI rounds, checkpoints, crash signal (missing `run.end` / torn tail) |
| **C** | plan artifacts (`task.md`/`criteria.md`/`baseline.md`/`decisions.md`/`ui-surfaces.md`) + `feedback.md` + `gate/*.log` | the ground truth the timeline refers to — acceptance criteria, scope baseline, bot feedback, raw helper output                                                                                           |

Both are **always present** for a loopd run. Read `loop.log` first (one line/event, human-rendered
from the journal); grep `journal.jsonl` by `event` for specifics; open the `skills/*.result.json`
sidecars for verdict/model/finding detail. Never needed: a session parser or a `-r` workspace scope
(chat-session forensics is retired — loopd leaves no session, and pre-loopd runs are already
diagnosed).

## Workflow

1. **Gather.** An explicit path/slug in the invocation wins. Otherwise list `care-loop/runs/*/` and
   keep the ones containing `journal.jsonl`. Show what was found.
2. **Read.** `loop.log` (narrative) + `state.json` (final step/outcome); grep `journal.jsonl` by
   `event` for the specifics; open `skills/*.result.json` for verdict/model/findings. No parsing
   script — the journal is one fact per line and `loop.log` is pre-rendered.
3. **Analyze.** Apply [rubric.md](./rubric.md) — dim 7 (trends) **first** (read `IMPROVEMENTS.md` +
   the last 2–3 reports), then the rest. All eight are exact reads (IMP-14 cost +
   IMP-15 verdict list landed 2026-07-14): dim 3 reads `cost_cum`/`cost_usd` from the journal, dim 8
   reads `verdicts.md`'s `class × missed_by` rows. Every finding carries an evidence
   pointer (journal `seq`/event or sidecar path). **escape → fixture:** when a bot caught a real
   defect our reviewer's `findings` missed, the sidecar `skills/care-reviewer-r<N>.input.json` is the
   exact diff it saw — a ready-made `care-evals` fixture; note it so the regression is reproducible
   offline (see `care-evals/SKILL.md`).
4. **Report + Backlog.** Write `diagnoses/<yyyy-mm-dd>-<runslug>.md` (append `-b`, `-c`… on same-day
   rerun — never clobber), then merge findings into `diagnoses/IMPROVEMENTS.md` (one fingerprinted
   entry per distinct issue; re-observations bump `seen:`, never duplicate):

   ```
   # Diagnosis — <date> — <run-dir slug>
   diagnosed-by: <model>
   evidence: journal.jsonl (<n> events) · <sidecars / artifacts cited>

   ## Findings (ranked by impact)
   1. [<rubric dim>] <one-line finding>
      evidence: <journal seq/event or sidecar path>
      proposed edit: <file + section, concrete> | none
   ## Healthy signals
   - <what worked — regressions are detected by these disappearing>
   ```

   Backlog entry shape:

   ```
   ## IMP-<n> · <short title>
   status: open | applied (<date>) | declined (<reason>)
   first-seen: <date> · seen: <count> · dimension: <rubric #>
   evidence: <report file(s)>
   proposed edit: <file + section>
   ```

   An `applied` entry re-observed = flag as regression. A `declined` entry is not re-proposed without
   materially new evidence.

5. **Gate + apply.** Present **one consolidated ask**, edits grouped by target file, each tagged with
   its `IMP-<n>`, and **split by apply-authority**:
   - **Apply-now (behind the gate):** methodology regions in the role skills (`care-planner/SKILL.md`,
     `care-triager/SKILL.md`), the standalone lens files (`care-*-review/SKILL.md`), `care-loop/models.json`,
     and this skill's own files — all markdown/config the doctor can safely edit.
   - **Propose-only:** anything under `care-loop/orchestrator/src/*.ts` is **tested code** — write the
     concrete patch as the finding, tag it "loopd change — apply via an orchestrator edit +
     `npm test`", and **do not auto-apply** it (the doctor can't run the test gate it would need).

   On approval, apply the apply-now edits and mark entries `applied (<date>)`; declined → `declined
(<reason>)`. **No approval → the report + backlog stand; nothing else is touched.** Never edit
   `care_fe` code or `runs/` artifacts.

## Escape → care-evals fixture (closed-loop improvement)

When your diagnosis surfaces an escape (bot caught what your reviewer's findings missed), convert it to a **care-evals fixture** so the regression is caught offline forever.

### Fixture creation workflow

1. **Extract the MRE (minimal reproducible example) from the run:**
   - Diff context: the changed files from the run, with 5 lines before/after each change
   - Bot finding: copy the text from `feedback.md` or the PR review comment
   - Expected verdict: what should your reviewer have flagged? (`blocked` or `findings`?)
   - Why it escaped: one-line explanation (e.g., "logic: null de-reference after conditional that doesn't guarantee non-null")

2. **Create a fixture in `care-evals/fixtures/` (alongside the existing ground-truth tasks):**

   ```json
   {
     "name": "reviewer-escaped-null-deref-2026-07-15",
     "description": "Reviewer missed null de-reference after optional-chain conditional",
     "diff": "<the diff from run's sidecar skills/care-reviewer-r<N>.input.json>",
     "expected_verdict": "blocked",
     "expected_class": "logic",
     "expected_reason": "Function de-references `user.profile.name` without null guard after `if (user?.id) { … }`",
     "source_run": "care_fe-eng-729-…",
     "source_report": "2026-07-15-care_fe-eng-729-….md"
   }
   ```

3. **Run the eval to baseline the current model:**

   ```bash
   cd care-evals
   npm run eval -- --fixture reviewer-escaped-null-deref-2026-07-15 --model claude-opus-4.8
   ```

   Output shows: did the reviewer catch it? What verdict/class did it return?

4. **Record in the doctor's backlog (`care-loop-doctor/diagnoses/IMPROVEMENTS.md`):**

   ```markdown
   ## IMP-N · Reviewer missed null de-reference in conditional path
   status: open
   first-seen: 2026-07-15 · seen: 1 · dimension: 8 (escape attribution)
   evidence: 2026-07-15-care_fe-eng-729-….md
   proposed edit: care-diff-review/SKILL.md — add null-safety check to Logic section
   fixture: care-evals/fixtures/reviewer-escaped-null-deref-2026-07-15.json
   ```

5. **Fix the skill (if needed) and verify the eval delta:**

   Once you've edited the reviewer's methodology, re-run the eval with the updated skill. The fixture now guards the fix — if the skill regresses, the eval fails.

   ```bash
   npm run eval -- --fixture reviewer-escaped-null-deref-2026-07-15 --model claude-opus-4.8 --before-after
   ```

### Why fixtures matter

- **Offline regression detection** — the escape is never forgotten; if the skill regresses, the eval catches it
- **Quantified improvement** — you can measure "before/after fix" delta on the exact diff that escaped
- **Generalization** — the fixture's class (logic, types, a11y, etc.) becomes a seed for other similar defects
- **Speed** — offline eval is much faster than running a full care-loop; you can iterate on skill improvements in minutes, not hours

---

## Non-goals

- Does not run or resume the loop (that's loopd).
- Chat-session / debug-log ingestion is retired (headless loopd leaves none). A pre-loopd run is
  diagnosed only from its existing `diagnoses/` report.
- No scheduler — user-invoked. The self-improving-agent conversion is a future plan that reuses
  `diagnoses/` as memory.
