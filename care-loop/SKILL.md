---
name: care-loop
description: Autonomous PR loop for the CARE frontend (care_fe) — plan → gate-first implement (+ optional e2e) → review → gate + push → address bot reviews until clean or capped. Use for "run the loop", "take this task to a PR", "drive this until reviews pass", "care-loop <task>". One human gate at the plan step; pushing is authorized by plan approval.
user-invocable: true
argument-hint: "<task or issue> [trivial|standard|complex] [thorough]"
---

# CARE Loop (orchestrator — router)

Drive a task from plan to a bot-reviewed, CI-green PR, **gate-first** (`tsc` + lint + build drive
the inner loop; e2e is an optional parallel track — it becomes test-first when a fast unit layer
lands), with **one human gate** — the plan approval at Step 1, which also **authorizes pushing**
for this task (satisfying the standing never-push-before-approval rule). After that gate the loop
runs autonomously.

This file is the **router**: it holds the pipeline table, the human gate, and the Step-7 loop
logic. Every mechanic lives in a guide under `guides/`. **Spawn each subagent with only its role
guide + [working-agreement.md](./guides/working-agreement.md) +
[token-discipline.md](./guides/token-discipline.md) — nothing else.** The subagent's verbose reads
stay in its context; only its summary returns.

_Installed homes (both symlink this whole folder, so `guides/` + `_.sh`resolve through either):*`~/.claude/skills/care-loop`and`~/.agents/skills/care-loop`. Run state lives in `runs/`inside
this folder (gitignored) — durable across reboots, and past runs stay available for iterating on
the loop itself. The **named judgment agents** in`agents/`are additionally symlinked per file
into`~/.claude/agents/`(Claude variants) and`~/.copilot/agents/`(Copilot`.agent.md`variants — bodies generated from the Claude files with`sync-agents.sh`; edit the Claude body and
regenerate). **`install.sh` creates/refreshes every symlink + executable bit** (idempotent);
**`install.sh --check`\*\* verifies them (and that the Copilot variants haven't drifted) without
mutating — run it on a new machine before the first loop.

Test stack — Playwright E2E only; inner loop runs target spec(s) only.

## Pipeline + dispatch (one table)

| Step | What                                                                                                                                    | Spawned role                                          | Model                        | Guide                                               |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------- | --------------------------------------------------- |
| 0    | **Resume** — only when a run dir already exists: reconcile `state.json` against ground truth, pick the true re-entry step.              | orchestrator                                          | —                            | [00-resume.md](./guides/00-resume.md)               |
| 1    | **Plan** — recon → interview → draft → follow-up. _Human gate._                                                                         | **`care-planner`** (named agent)                      | Opus 4.8 — frontmatter-bound | [01-plan.md](./guides/01-plan.md)                   |
| 2    | **Tests (when they pay)** — vitest when available; today: orchestrator records the skip inline for `trivial`, no spawn.                 | Spec author                                           | Opus design / Sonnet write   | [02-tests.md](./guides/02-tests.md)                 |
| 3    | **Implement** — two parallel makers: implement-to-green + optional e2e.                                                                 | Implementer + E2E author                              | Sonnet (Opus if complex)     | [03-implement.md](./guides/03-implement.md)         |
| 4    | **Review, ours** — `/care-review`; apply "worth deciding" findings.                                                                     | **`care-reviewer`** (named agent)                     | Opus 4.8 — frontmatter-bound | [04-review.md](./guides/04-review.md)               |
| 4.5  | **Test-grade** — grade specs against criteria; no-spec mode grades the diff.                                                            | **`care-test-grader`** (named agent; checker ≠ maker) | Opus 4.8 — frontmatter-bound | [04.5-test-grade.md](./guides/04.5-test-grade.md)   |
| 4.8  | **UX-validate** — static diff lens + live browser across 3 viewports; gates on `Broken` findings. Skipped when no `.tsx` files changed. | **`care-ux-validator`** (named agent)                 | Opus 4.8 — frontmatter-bound | [04.8-ui-validate.md](./guides/04.8-ui-validate.md) |
| 5    | **Gate + push** — `run_gate.sh` → open/update PR → post staged replies + UI screenshots → token-free bot/CI wait.                       | Gate + push                                           | Sonnet / script              | [05-gate-push.md](./guides/05-gate-push.md)         |
| 6a   | **Collate + triage** — verdict list from bots + CI + our review.                                                                        | **`care-triager`** (named agent)                      | Opus 4.8 — frontmatter-bound | [06a-triage.md](./guides/06a-triage.md)             |
| 6b   | **Apply verdicts** — implement `address` items + stage thread replies.                                                                  | Apply verdicts                                        | Sonnet 4.6                   | [06b-apply.md](./guides/06b-apply.md)               |

Model picks are single-sourced in [models.md](./guides/models.md); host enforcement in
[hosts.md](./guides/hosts.md). Shared context:
[governance.md](./guides/governance.md) (scope + anti-thrash),
[observability.md](./guides/observability.md) (run-dir schema, log markers, `watch-agents.sh`).

## Effort tiers (set at Step 1, confirmed at the gate)

The Step-1 classification is a **three-tier effort knob** — one decision that sets every
downstream dial, instead of per-step vibes. The user can pass a tier at invocation (the engineer
usually knows how complex the change is); the planner confirms or corrects it in the consolidated
ask. The orchestrator records it in `state.json` (`"tier"`).

| Knob                   | `trivial`                              | `standard`                 | `complex`                                |
| ---------------------- | -------------------------------------- | -------------------------- | ---------------------------------------- |
| Recon (Step 1)         | skim the target file(s)                | quick Explore              | thorough Explore                         |
| Interview (Step 1)     | fold into the consolidated ask         | checklist-driven, uncapped | exhaustive + mandatory follow-up round   |
| Tests (Steps 2–3)      | skip (recorded)                        | e2e optional               | e2e track on                             |
| Implementer (Step 3)   | Sonnet 4.6                             | Sonnet 4.6                 | Opus 4.8                                 |
| Review (Step 4)        | single lens                            | full `/care-review`        | `/care-review`; `thorough` if also large |
| UX-validate (Step 4.8) | static + probes only (no live browser) | full live judge            | full live judge                          |
| Poll timeout (Step 5)  | 900s                                   | 900/1800s by size          | 1800s                                    |
| Round cap (Step 7)     | 3                                      | 5                          | 5                                        |

**Escalation valve (one-way):** if the `standard` implementer fails to reach a green gate after
**two** attempts, or triage shows the same area churning, escalate implementation to **Opus 4.8**
for the rest of the run and note it in `loop.log`. Never downshift mid-run.

## Model enforcement (structural — the orchestrator is a router, never a judge)

This section is the **single normative statement** of the enforcement doctrine — `models.md` owns
the per-phase picks and `hosts.md` the Copilot mechanics; both point here rather than restating it.
The model tiers ([models.md](./guides/models.md)) are **enforced, not advisory** — a Sonnet
plan/review/triage is a defect, not a cheaper option. Enforcement is **structural**, so it holds
whatever model the session happens to be on:

- **The orchestrator never does judgment work inline. Period.** Whatever the session model, the
  orchestrator only routes: spawns roles, relays the interview, runs scripts, writes state. Then
  the session picker being on Sonnet doesn't matter — judgment never executes on it.
- **Every judgment step — 1 Plan, 4 Review, 4.5 Test-grade, 4.8 UX-validate, 6a Triage — runs as
  its NAMED agent:** `care-planner`, `care-reviewer`, `care-test-grader`, `care-ux-validator`,
  `care-triager`
  (installed in the hosts' agent dirs; canonical files in `agents/` here). **The agent file's
  frontmatter binds Opus and the harness applies it** — a bare spawn of the named agent cannot
  inherit the session model. Spawn by name; do not re-specify the model.
  **Fallback only** (a named agent doesn't resolve on this host): a generic spawn with an
  **explicit** Opus 4.8 model arg ([hosts.md](./guides/hosts.md)). A generic spawn with **no**
  model arg inherits the session model — that is the bug that caused two live Sonnet-planned
  runs; never do it. Drafting the plan in the orchestrator's own turn **is** doing judgment
  inline, even if it "feels like part of the conversation."
  _(Step 1 stays interactive via relay: the `care-planner` spawn returns batched questions → the
  orchestrator asks the user → a second `care-planner` spawn folds the answers into the final
  artifacts. Two Opus spawns is the designed cost — [01-plan.md](./guides/01-plan.md).)_
- **You cannot change the session model** — the picker is the user's control, so never claim to
  "upshift" or plan to. If the named agents don't resolve **and** the host can't spawn with an
  explicit model arg, **stop and ask the user to switch the picker to Opus** before continuing.
- **Optional hard gate (Claude Code):** `hooks/assert-judgment-agent.py` is a shipped, opt-in
  `PreToolUse` hook that denies a judgment-guide spawn under the wrong agent name (install
  snippet in its header). Copilot has no hook layer — its ceiling is frontmatter + attestation.
- **Disclose at the human gate (the backstop):** the consolidated ask **must include a
  `Planned by: <model>` line**, taken from the planner's self-identification (the planner writes
  `planned-by: <model>` into `baseline.md` — [01-plan.md](./guides/01-plan.md)). The gate is the
  one moment a human always reviews; `Planned by: Sonnet` (or the line missing) = reject the plan.
- **Mechanical steps (2 write, 3 implement `trivial`/`standard`, 5, 6b)** run on Sonnet 4.6 by
  design; `complex` implementation and the escalation valve use Opus per the tier table.
- **Audit:** log the executing model per step to `loop.log` (`step N: model=<m>`) — wrong-tier runs
  become visible without a debug-log autopsy.

## The human gate (Step 1 — the only regular checkpoint)

**One consolidated ask.** Present plan + push authorization + test approach in a **single**
interaction so the user answers once, e.g.: _"**Planned by: Opus 4.8.** Approve this plan? It
authorizes the loop to push commits and open/update a PR on `origin` (ohcnetwork/care_fe). Tests:
[recommended spec(s)] — or skip (trivial change)?"_ The **`Planned by:` line is mandatory** — it
comes from the planner spawn's self-identification ("Model enforcement" above); if it's missing or
says Sonnet, the plan is rejected. **No approval → no loop.** After approval, don't re-ask
permission to push each round.

**User amendments:** if the user modifies the plan during approval, the planner **rewrites the
artifacts** (`criteria.md`, `baseline.md`, `decisions.md`) before Step 2. Approval applies to the
revised artifacts, not the originals.

**Trivial changes:** when Step 1 classifies `trivial` and the user confirms the test skip, the
**orchestrator records the skip inline** (PR body note: _"Tests skipped — trivial change."_) — no
Step-2 spawn needed.

## Worktree-first (immediately after plan approval)

Every loop runs in its **own git worktree** — the main checkout stays free for the user, and
concurrent loops on different tasks don't collide. Right after the plan is approved (the approval
covers this; it's mechanical), the **orchestrator** creates the worktree + branch in one step:

```
git worktree add ../care_fe-<branch-flat> -b <branch> develop
```

- **The loop always creates the branch** — there is no "user already made it" path. Plan mode
  never needs a branch; it exists from here on, well before the Step-5 push. `-b` failing means
  the branch already exists = a double-started or already-run task → **surface the error and
  stop** (this is the duplicate-task guard; no separate check).
- `<branch-flat>` flattens `/` → `-` for the **directory** name only; the branch keeps its real
  name (`eng-648/generic-autocomplete` → dir `care_fe-eng-648-generic-autocomplete`).
- **Fast setup** (APFS clone of node_modules + reconcile + gitignored env):
  ```
  cp -c -R ../care_fe/node_modules ./ 2>/dev/null || cp -R ../care_fe/node_modules ./ 2>/dev/null || npm ci
  npm install                          # reconcile against this branch's lockfile
  cp ../care_fe/.env* ./ 2>/dev/null || true
  ```
- **Every subsequent step, agent, and script runs with cwd inside the worktree** — the bundled
  scripts derive the run dir (and everything else) from the main `.git`, so they resolve to the
  same run dir from here or the main checkout. The main checkout is **read-only** after Step-1
  recon. Record the worktree path in `state.json` (`"worktree"`).
- **Shared e2e is serialized, not parallelized:** the backend on :9000 and the Playwright DB are
  singletons across worktrees, so spec runs go through `pw-lock.sh` (built into `run_gate.sh` /
  `preflight.sh`). A long Playwright-stage wait means another loop holds the lock — not a hang.
- **Cleanup after merge:** write the terminal step to `state.json` **first** (`"step": "merged"` —
  else the fleet view `cat runs/*/state.json` shows the loop stuck at its last step), then
  `git worktree remove ../care_fe-<branch-flat>`. The exit report gains a reminder line (also
  suggest `git branch -d <branch>` once the PR is merged).

## Stateless rounds

At the top of each round the orchestrator **re-derives where it is from the run dir**
(`<skill-dir>/runs/<repo>-<branch-flat>/` — repo from the main `.git` (`git-common-dir`, stable
from inside a worktree), branch with `/` flattened; never an ad-hoc name), never from conversation
scrollback. Step 1 persists directly to this slug using the **planned** branch (no post-hoc `mv` —
the branch is created at approval, above). **`state.json` is the resume anchor** — the orchestrator
rewrites it at every step transition; `loop.log` is narrative only. This lets the conversation be
compacted aggressively (directly attacking the ~240K re-read) and lets a crashed/restarted session
resume mid-loop instead of starting over. Run-dir schema:
[observability.md](./guides/observability.md).

**Bracket every side effect with `state.json` writes — always via `write-state.sh`, never by
hand** (hand-written state drifted in every live run; the script validates schema + step
vocabulary and carries unset fields forward, so a transition is one call:
`write-state.sh -s 6b-applying`). Write an **`-ing` in-progress marker** _before_ each mutating
action and the settled value _after_ — `3-implementing`, `6b-applying`, `5-committing`,
`5-pushing`, `5-replying`. A crash then leaves an unambiguous "was mid-X" marker
(`resume-probe.sh` + [00-resume.md](./guides/00-resume.md) key on it) instead of a stale
start-of-step anchor. The write is tiny; do it every time.

## Resume (crashed or re-invoked mid-loop)

**On invocation, before Step 1: if a run dir + `state.json` already exist for this repo+branch (or
the user says "resume"), run [00-resume.md](./guides/00-resume.md) first** — reconcile the anchor
against ground truth (`resume-probe.sh`) and re-enter at the true step, rather than trusting a
possibly-stale `state.json` or restarting from scratch. No run dir → fresh Step 1. The crash itself
isn't auto-detected (it's an external host death); re-invoking is what triggers the safe reconcile.

## Step 7 — Loop or stop

Return to Step 4 (re-review the new diff) → 4.5 (grade) → 5 (gate **re-runs the affected specs =
regression guard**, then push) → 6, until one of:

**Round counter.** Round 1 is the initial pass (Steps 1→6). The orchestrator increments `round`
**exactly once per loop-back**, at the moment it re-enters Step 4 from Step 7 — including a
4.5/4.8 → Step 3 → back-to-4 loop-back (those are the same iteration continuing, so the bump still
happens only on the return to Step 4, not per sub-loop): `write-state.sh -s 4 -r <n+1>`. No bump on
the first entry to Step 4. This is the number the round cap below is counted against.

**Exit (success):** affected specs green **and** no graded spec is `Wrong` **and** no criterion
unmet (no-spec mode) **and** zero unresolved actionable bot comments **and** every
addressed/declined thread has a posted reply **and** CI green **and** our review has no "worth
deciding" findings **and** no **`Broken`** UI finding from Step 4.8 **and**, if Greptile
publishes a confidence score, it's **≥ 4/5** (max is not
required — correctly declining a false positive can hold the score below max forever). _(Uncovered
criteria and Weak/Missing specs are listed, not blocked.)_

**Exit (cap):** **max 5 iterations** (**3** for `trivial`) — `Wrong`-spec loop-backs from Step 4.5
**count** against this cap (they are iterations, not free retries). Also apply the **convergence
guard**
([governance.md](./guides/governance.md) §2): after **two** non-converging fix cycles, pause and
reclassify remaining findings before another edit — no speculative fixes.

**Exit (abort):** if a blocker is unresolvable or the user requests it, set `state.json` →
`"step": "aborted"` and emit the report. Any unposted `replies.md` entries are listed in
`Defer-to-human:` so the user can post them manually if desired.

After every round emit a **one-line summary** to `loop.log`: `round N: fixed X, declined Y, deferred
Z; specs <state>; CI <state>; next <action>`.

**All exits emit the same report template:**

```
PR:        <url>
Rounds:    <n> of 5
Outcome:   fixed <X> · declined <Y> · deferred <Z>
Defer-to-human:
  - <item> — <one-line reason>
CI:        <conclusion>
Specs:     <state> (uncovered criteria: <list or none>)
```

One predictable artifact to act on when returning to a finished loop.

_After the report, suggest a retro:_ `/care-loop-doctor` diagnoses this run from the on-disk chat
session + run dir (no manual export needed) and proposes skill improvements. One line, no other
coupling — the doctor is a separate skill.
