# Diagnosis rubric (care-loop-doctor)

Judgment dimensions for a care-loop run. Each states **what to check** and **which evidence
answers it**. Digests are facts; this file is where meaning gets assigned. Findings must carry an
evidence pointer (digest line / artifact path) — no vibes-only findings.

## 1. Model-tier compliance

Did judgment work (plan, review, test-grade, triage) execute on Opus, and mechanical work on
Sonnet, per `care-loop/guides/models.md`?

- **Evidence:** digest `models:` + `spawns:` lines (Tier B has per-turn models + spawn model args;
  Tier A has per-request `modelId`); `baseline.md` `planned-by:` line; named-agent usage
  (`agent=care-planner` etc. in spawns, vs `(generic)` + `(no model arg)` — the historical bug).
- **Red flags:** judgment-step turns on `claude-sonnet-*`; generic spawns with no model arg;
  missing `planned-by:`; the consolidated ask shown without a `Planned by:` line.

## 2. Termination & resume

Did the session end cleanly, and if a prior session crashed, was the resume reconciled?

- **Evidence:** digest `ending:` (Tier B `DIED MID-TURN`); `state.json` `step` (stale start-of-step
  vs `-ing` markers) vs the trace end; on re-runs, whether `00-resume.md` / `resume-probe.sh` shows
  up early in the session (Tier-A tool invocations / Tier-B tool spans) instead of re-planning or
  re-triaging already-applied work.
- **Red flags:** dirty tree + `await`-step anchor at death; a resumed session that restarted from
  Step 1; `state.json` never updated across a whole session.

## 3. Token economy

Was the loop cheap the way `token-discipline.md` demands?

- **Evidence:** digest input-growth + `top input-token jumps`; spawn count vs pipeline steps;
  Tier-A `top tool invocations` (raw `gh`/test output pulled into context instead of the bundled
  digests); gaps > 5 min between calls (cache expiry) visible in the Tier-A timeline.
- **Red flags:** input jumping by whole-file amounts; judgment agents loading more than their role
  guide; polling done by the model instead of `poll-pr.sh`/`watch-agents.sh`.

## 4. Pipeline adherence

Were the steps run in order with their gates?

- **Evidence:** run-dir artifacts as a checklist — `criteria.md`/`baseline.md`/`decisions.md`
  (Step 1), gate logs before push (`gate/*.log` mtimes vs push time), `verdicts.md` + `declined.md`
  (6a), `replies.md` staged then archived (`replies-r*.posted.md`), worktree recorded, one commit
  per round; Tier-A timeline for step ordering.
- **Red flags:** push with no gate logs; replies posted before a push; 6b edits without a verdict
  list; scope beyond ~2× `baseline.md`'s estimate without a recorded re-approval.

_Installation invariants (cheap check):_ if the loop misbehaved in a way that smells like a wiring
problem (a judgment step ran generic, a script `command not found` / permission denied), run
`care-loop/install.sh --check` — it verifies the symlinks, executable bits, and Copilot-agent sync
in one shot. A gap here is often the real root cause behind a dimension-1 or dimension-4 finding.

## 5. Schema drift

Does `state.json` match the exact schema in `care-loop/guides/observability.md`?

- **Evidence:** the run dir's `state.json` vs the documented keys/types (`repo` = full owner/name,
  `pr` = integer, `head_sha`/`updated_at`/`last_reviewed_sha`/`worktree` present, step values from
  the settled + `-ing` vocabulary).
- **Red flags:** URL in `pr`, missing keys, invented step names, extra ad-hoc keys. (This has
  drifted in every live run so far — check it every time.)

## 6. Bot-round efficiency

Did the feedback rounds converge?

- **Evidence:** `loop.log` round summaries; rounds used vs cap; `poll-pr.sh` timeouts/dropped bots
  (Tier-B tool spans or `loop.log`); `declined.md` — same finding re-litigated across rounds?
  Cross-check `state.json`'s `round` against the count of Step-4a (re-)entries in `loop.log` — they
  must agree (round bumps once per loop-back on re-entry to Step 4a; SKILL.md Step 7).
- **Red flags:** rounds spent on re-declined findings; waits on bots that never engage; the
  convergence guard not firing after two non-converging cycles; `round` out of step with the
  loop.log round summaries (an uncounted round is an unbounded loop; a double-counted one exits early).

## 7. Cross-run trends (do this FIRST, before fresh analysis)

Read `diagnoses/IMPROVEMENTS.md` and the 2–3 most recent reports before analyzing. A re-observed
finding **bumps the existing backlog entry** (`seen-count`), it is not re-derived; an entry marked
`applied` that recurs anyway is a _regression_ finding (the fix didn't hold) — flag it as such; a
`declined` entry is not re-proposed unless the evidence is materially new.

## 8. Escape attribution

What did the bots catch that our own pipeline should have, and which step keeps missing the same
class? Every `address` verdict is an escape; `addressed.md` records 6a's attribution
(`missed-by:`) at judgment time.

- **Evidence:** `<run-dir>/addressed.md` (this run) **aggregated with the `addressed.md` of prior
  run dirs** — single-run attributions are noisy judgment calls; the cross-run pattern is the
  signal. Cross-check a sample against `verdicts.md`/`replies-r*.posted.md` (was the attribution
  plausible?).
- **Red flags:** the same `class` × `missed-by` pair recurring across runs (e.g. `care-review:
approach` repeatedly missing `logic` prop-contract breaks) — that's a checklist line missing in
  the named skill file, and becomes a weighted IMPROVEMENTS entry; everything attributed `novel`
  (attribution dodging); `addressed.md` absent while `verdicts.md` shows `address` items (6a
  skipped the append rule); own-review findings logged as escapes (they aren't).
- **Output shape:** a finding here names the _target skill file_ to improve (e.g.
  `care-technical-review/SKILL.md` gains a prop-forwarding check), not another loop-round rule.
