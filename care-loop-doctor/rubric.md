# Diagnosis rubric (care-loop-doctor v2 — loopd journal)

Judgment dimensions for a **loopd** run. Each states **what to check** and **which journal/artifact
answers it**. The journal is facts; this file is where meaning gets assigned. Every finding carries
an evidence pointer (a journal `seq`/event, a `skills/*.result.json` sidecar path, or an artifact) —
no vibes-only findings.

**Evidence vocabulary** (see [SKILL.md](./SKILL.md) for the run-dir contract): `journal.jsonl`
events (`run.start/resume/end`, `step.enter/exit`, `spawn.result/invalid/retry/escalate`,
`skill.invoke/result`, `helper.exec`, `decision`, `push`, `ci.wait/done`, `checkpoint.written`,
`budget.stop`, `plan.approved`); `skills/<role>-r<N>.result.json` sidecars (`verdict`, `reasonCode`,
`terminalState`, `modelUsed`, `durationMs`, `payload`, `modelPinSatisfied`); `state.json`;
`loop.log`; plan artifacts (`criteria.md`/`baseline.md`/`decisions.md`); `feedback.md`; `gate/*.log`.

All eight dimensions are now **exact reads** — IMP-14 (per-spawn cost → `cost_cum`) and IMP-15 (the
triager's per-item verdict list → `verdicts.md`) landed 2026-07-14, so dims 3 and 8 read straight off
the journal / `verdicts.md` instead of being blocked.

## 1. Model-tier compliance — EXACT

Did each judgment spawn (plan, review, triage) run on the configured **judgment** engine, and the
implementer on the **maker** engine, per `care-loop/models.json`?

- **Evidence:** `skill.result.model` per spawn + the sidecar `modelUsed`; for the planner,
  `plan.approved.planned_by` + the sidecar `modelPinSatisfied` (the pin is **enforced at the plan
  gate** — a wrong engine aborts `run.end{reason_code:"plan_wrong_tier"}`, [plan.ts:90]).
- **Red flags:** a judgment spawn's `model` ≠ the configured judgment engine; a run aborted
  `plan_wrong_tier` (the guard fired — note the configured vs reported engine). **Known blind spot:**
  the reviewer/triager compute `modelPinSatisfied` but do **not** enforce it (only the planner gate
  does), so a wrong-engine reviewer/triager will NOT abort — check each judgment spawn's `model`
  explicitly rather than trusting that a run completing means the tier held.

## 2. Termination & resume — EXACT (and better than session forensics)

Did the run end cleanly, and if a prior process died, was resume reconciled?

- **Evidence:** presence + `outcome` of the final `run.end` (`converged` / `capped` / `deferred` /
  `aborted` / `push-failed` / `gate-blocked`); a **missing `run.end` or a dropped torn-tail line**
  (`journal.read().truncatedTail`) = crash mid-append; `-ing` step markers in `state.json` at death;
  `run.resume` events and whether the re-entry step matched ground truth vs restarting.
- **Red flags:** no `run.end` with `state.json` at an `-ing` marker (died mid-mutation); a resume
  that redid completed work; a `JournalCorruptionError` (hash-chain break mid-file — tamper/partial
  write, not a clean crash).

## 3. Token economy — EXACT

Was the run efficient?

- **Evidence:** `skill.result.cost_usd` per spawn + the cumulative `cost_cum.usd_est` stamped on each
  costed event (rendered as a `($X.XX)` suffix in `loop.log`); `skill.result.duration_ms` per spawn;
  spawn count vs pipeline steps; `spawn.retry` / `spawn.escalate` counts (wasted work); loop-back
  frequency (same area churning).
- **Red flags:** cumulative cost well above comparable runs; high retry/escalate counts; spawn count
  far above the step count; the same review step looping back repeatedly.
- **Coverage note:** the CLI implementer (Sonnet `opencode run`) reports no usage, so `cost_cum`
  covers the **judgment (Opus) spawns** — the expensive share — not the maker. A run's true total is
  slightly higher than `cost_cum`; don't treat it as exhaustive of the maker.

## 4. Pipeline adherence — EXACT

Were the steps run in order, with their gates, in one commit per round?

- **Evidence:** the `step.enter/exit` sequence (the FSM's actual path) + `decision{from,to}` edges;
  `helper.exec` for `gate-inner`/`gate-full` (exit 0) **before** the `push` event; plan artifacts
  present (`criteria.md`/`baseline.md`/`decisions.md` written at Step 1). Illegal transitions throw
  `FsmError` — out-of-order shows as a surfaced error, never a silent skip.
- **Red flags:** a `push` with no preceding `gate-*` exit-0 helper; a `decision` edge that skips an
  enabled review step; missing plan artifacts; a scope far beyond `baseline.md`'s estimate.

## 5. Output validity — EXACT (reframed from state.json drift)

`state.json` **cannot drift** — [state.ts] is the sole writer and `validateState` throws on bad
keys/types/step. So the old "schema drift" signal is structurally closed. The live signal is now
**JobResult validity**: did a skill return schema-valid structured output?

- **Evidence:** `spawn.invalid` events (a role's output failed `JOBRESULT_SCHEMA` validation) + the
  offending sidecar; retries needed to produce valid output.
- **Red flags:** recurring `spawn.invalid` for one role (its prompt/schema are mismatched — a
  skill-prompt fix); a role that only produced valid output after retries.

## 6. Bot-round efficiency — EXACT

Did the CI/feedback rounds converge?

- **Evidence:** `ci.wait` / `ci.done{conclusion,converged,missing}`; `round` increments
  (`step.enter` round + `state.json`); triager `skill.result` tallies per round
  (`address`/`decline`/`defer`); `checkpoint.written{reason_code}` (`defer_to_human` /
  `ci_red_no_verdicts` / `poll_timeout`); `budget.stop{max_rounds}`.
- **Red flags:** `budget.stop max_rounds` (capped, not converged); repeated `poll_timeout` (bots
  never engaged); `addressCount` not trending toward zero across rounds; `ci_red_no_verdicts`.

## 7. Cross-run trends — do this FIRST

Read `diagnoses/IMPROVEMENTS.md` and the 2–3 most recent reports before analyzing. A re-observed
finding **bumps the existing entry** (`seen:`), never re-derived; an `applied` entry that recurs is a
**regression**; a `declined` entry is not re-proposed without materially new evidence.

**Era note:** IMP-1..IMP-13 are **pre-loopd** (the old fused-runtime loop). Many are **structurally
obviated** by loopd — state drift (IMP-3) → `validateState` can't drift; hand-poll (IMP-5) →
blocking `poll.ts`; model-tier inheritance (IMP-1) → gate-enforced pin. **Do not re-propose their
edits against deleted guides** (`05-gate-push.md`, `hosts.md`, etc.). Treat them as history; new
findings are against loopd (`orchestrator/src`), the methodology regions, the lens skills, or
`models.json`.

## 8. Escape attribution — EXACT

What did the bots catch that our own pipeline should have, and which step keeps missing the same
class?

- **Evidence:** `<run-dir>/verdicts.md` — the triager's per-item verdict list, each row
  `verdict · class · missed_by · source · reason`. `missed_by` names which of our steps
  (`care-reviewer` / `care-technical-review` / `care-ux-review` / `care-test-grade`) should have
  caught the item first (`novel` = un-catchable pre-merge; `none` = not an escape). **Aggregate
  `verdicts.md` across run dirs** — single-run attributions are noisy; the cross-run
  `class × missed_by` pattern is the signal. Cross-check the reviewer's own `payload.findings` (what
  we DID catch) so an own-review finding isn't miscounted as an escape.
- **Red flags:** the same `class × missed_by` pair recurring across runs (e.g. `care-technical-review`
  repeatedly missing a `correctness` class) — a missing check in that lens skill, and a weighted
  IMPROVEMENTS entry; everything attributed `novel` (attribution dodging); an `address`-heavy round
  with no `verdicts.md` (the triager didn't emit items).
- **Output shape:** a finding here names the **target skill file** to improve (e.g. a
  `care-technical-review` methodology check), not another loop rule.
- **escape → fixture:** when a bot caught a real defect our reviewer's `findings` missed, the sidecar
  `skills/care-reviewer-r<N>.input.json` is the exact diff it saw — a ready-made `care-evals` fixture
  (see `care-evals/SKILL.md`).
