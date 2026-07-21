# Care Loop & Care Loop Doctor — Complete Architecture Guide

**Document covers:** care-loop headless orchestrator (loopd), care-loop-doctor diagnostic system, data flows, workflow, and design principles.

**Status:** Implemented (loopd built 2026-07-14; doctor v2 active 2026-07-14; end-of-run auto-doctor default-on 2026-07-20).

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Design Philosophy](#design-philosophy)
3. [Orchestrator (loopd) Architecture](#orchestrator-loopd-architecture)
4. [The FSM & Workflow](#the-fsm--workflow)
5. [Data Model & Evidence Contract](#data-model--evidence-contract)
6. [Care Loop Doctor](#care-loop-doctor)
7. [Component Reference](#component-reference)
8. [Key Decisions](#key-decisions)

---

## System Overview

### What is care-loop?

**care-loop** is an autonomous CI/bot-feedback loop for frontend code changes in the CARE EMR. It orchestrates a sequence of judgment agents (planner, reviewer, test-grader, triager) and mechanical helpers (implement, gate, push) to:

1. Recon a change request and plan the approach
2. Implement the change via code and UI specs
3. Review the diff against multiple lenses (intent, approach, UX)
4. Validate tests and UI against acceptance criteria
5. Commit and push to create a PR
6. Wait for CI/bot feedback in rounds
7. Triage feedback and apply fixes until convergence

It operates **headless** (detached from VS Code) and is designed to be **fully autonomous** after human plan approval — no nudges, no re-entry, no status checks.

### What is care-loop-doctor?

**care-loop-doctor** is a diagnostic tool that:

1. Reads a completed loopd run's structured trace (journal, skill results, state)
2. Judges it against a rubric (8 dimensions of loop health)
3. Generates a report with findings and evidence pointers
4. Tracks improvements across runs in a durable backlog
5. Applies improvements to loop files behind one human gate

It does NOT run or control the loop; it diagnoses post-run behavior and surfaces patterns. It runs in
two modes: **interactive** (human invokes it against a run dir, inline edits behind one gate) and
**autonomous end-of-run** (loopd auto-invokes it after every run — see [Autonomous End-of-Run Mode](#autonomous-end-of-run-mode-auto-doctor)).

---

## Design Philosophy

The core challenge: **the old architecture fused orchestration with VS Code's chat turn**, causing three failure classes:

1. **No autonomous re-entry** — CI/bot waits park the loop for manual "status check" nudges
2. **Host death kills orchestrator** — VS Code OOM under two concurrent loops
3. **Router doing mechanical work** — cheap (Sonnet) models silently dropped the state/observability contract

### Response: Six design principles

| #   | Principle                             | Why                                                            | Fix class                                               |
| --- | ------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | **No LLM in control loop**            | Every scheduling decision is plain code over validated inputs  | Router drift (IMP-3/7), Sonnet contract collapse        |
| 2   | **Model never writes state**          | Orchestrator is sole writer of `state.json` and journal        | State drift by construction                             |
| 3   | **Waits are blocking calls**          | `poll-pr.sh` blocks a thread; when it returns, next line runs  | Manual nudges (IMP-5), "status check?" prompts          |
| 4   | **Crash-only design**                 | Recovery is always journal-replay + ground-truth reconcile     | VS Code OOM class (IMP-6/9)                             |
| 5   | **Judgment pinned, mechanical cheap** | SDK pins each agent's model; orchestrator code is free         | IMP-1 (Sonnet plans), IMP-7 (mechanical non-compliance) |
| 6   | **Explainable from journal alone**    | No VS Code archaeology needed; doctor reads journal + sidecars | IMP-11 (reconstruction tax), IMP-2 (stale anchors)      |

---

## Orchestrator (loopd) Architecture

### Process Model

**One orchestrator process per run**, cwd = the run's worktree, launched detached:

```bash
tmux new -d -s care-<slug> care-loopd start …
# OR
nohup care-loopd start … &
```

**Concurrency** between runs is solved by:

- **Worktree isolation** (each run gets its own git worktree via `git worktree add -b`)
- **Global `pw-lock` mutex** (for shared Playwright backend)
- **Per-run lockfile** (`<run-dir>/.orchestrator.lock`, atomic mkdir, steal stale locks)

**In-process layout:**

- FSM runs on main thread (state machine is single-threaded)
- Agent spawns and blocking waits run inline (sequential loop)
- No async framework — only what SDK does internally
- Steps 4a/4b/4c _could_ fan out as three parallel SDK calls but v1 runs sequentially

### Runner: OpenCode + GitHub Copilot

Headless spawn via long-lived `opencode serve` HTTP server + typed `@opencode-ai/sdk` client:

- **Auth:** GitHub Copilot device code (zero setup; uses existing subscription)
- **Agents:** Ported from `agents/claude/` to opencode agents (markdown frontmatter or `opencode.json`)
- **Model pin:** Each role gets a `model:` declaration (`github-copilot/claude-opus-4.8` for judgment, `claude-sonnet-4.6` for maker)
- **Tool allowlist:** Reviewer/triager/test-grader get read-only (`bash: deny` except `git diff`/`grep`/logs); implementer gets `edit: allow` + scoped bash
- **Hard deny-list:** `git push --force`, `git reset --hard`, `rm -rf`, credential reads (glob patterns)
- **Structured output:** JobResult@1 schema validated at the runner; retries baked in

### The FSM: Steps, Owners, Transitions

```
Step  │ Owner              │ Does                              │ Success → │ Failure →
──────┼────────────────────┼─────────────────────────────────────────────────────────────
1     │ care-planner       │ Recon, interview, draft plan      │ GATE      │ escalate/abort
GATE  │ Human via adapter  │ Answer questions, approve plan    │ 2         │ abort
2     │ Orchestrator       │ Worktree + branch, clone modules  │ 3         │ abort
3     │ Implementer        │ Code + specs per plan             │ 4a        │ retry ×R → escalate
4a    │ care-reviewer      │ /care-review lenses on diff       │ 4b        │ block → 3
4b    │ care-test-grader   │ Grade specs vs criteria           │ 4c        │ Wrong → 3
4c    │ care-ux-validator  │ Playwright UI validation          │ 5         │ block → 3
5     │ Orchestrator       │ Full gate, commit, push, pr       │ 5-waiting │ gate red → 3
5-    │ Orchestrator       │ BLOCKING poll-pr.sh until CI green│ 6a        │ timeout → checkpoint
6a    │ care-triager       │ Collate feedback → verdicts.md    │ 6b or 7   │ defer → checkpoint
6b    │ Implementer        │ Apply verdicts, stage replies     │ 5         │ retry → escalate
7     │ Orchestrator       │ Exit report, cleanup reminder     │ —         │ —
```

**Round loop:** `5 → 5-waiting-ci → 6a → 6b → 5 …` until:

- `6a` yields zero address items AND
- CI is green AND
- Bot threshold met (≥4/5 Greptile-style)

OR **STOP** fires (budget, escalation exhausted) → checkpoint.

**Transition function contract:** `next = transition(step, inputs)` where inputs = validated JobResult | exit code + summary line | budget state. Pure, table-driven, unit-testable; every call appends a `decision` event to journal.

---

## The FSM & Workflow

### Step 1: Plan (care-planner, judgment tier)

**Role:** Agree the approach with the user and produce the plan the rest of the loop runs on.

**Input:** The change request (a git branch or diff).

**Output:**

- `baseline.md` — scope, files, approach (cites real paths from recon)
- `criteria.md` — acceptance criteria (what "done" looks like)
- `decisions.md` — settled design decisions + dev credentials (if UI-touching)
- `ui-surfaces.md` — UI breakpoints to validate (if UI-touching)
- `PlannerPayload` (structured):
  - `tierRequired`: judgment/mechanical
  - `plannedBy`: model that ran the plan
  - `questions?`: batched interview Q&A if needs_input
  - `modelPinSatisfied`: was the planner run on the configured judgment engine?

**Interview gate (GATE):**

- Human answers batched questions (or approves if no questions)
- Plan approval **authorizes everything downstream** (with Scope Governor as tripwire)
- No plan = no push

### Step 2: Setup (orchestrator)

- Create worktree: `git worktree add -b <branch> <run-dir> <base>`
- Clone node_modules if needed
- Copy environment

### Step 3: Implement (implementer, maker tier)

**Role:** Code + UI specs per plan.

**Input:**

- `plan.md`, `criteria.md`, `baseline.md`
- Git branch ready to edit

**Output:**

- Code changes
- Modified files
- `loop.log` entry showing what was changed

**Retry policy:** Up to 2 retries on failure, escalates to stronger model on second failure.

### Steps 4a–4c: Judgment gates

**4a — Review (care-reviewer, judgment tier)**

- Applies `/care-review` lenses: `care-diff-review` (intent/legibility) + `care-technical-review` (approach) + `care-ux-review` (static mode only) when `.tsx` touched
- Verdict: `pass` | `findings` (non-blocking) | `blocked` (blocks round)
- Blocked → loop back to Step 3 with findings
- Findings → documented in `declined.md`, then proceed

**4b — Test-grade (care-test-grader, judgment tier)**

- Grades implementation against test specs in `criteria.md`
- Verdict: `pass` | `wrong` (incomplete implementation)
- Wrong → back to Step 3 with grade

**4c — UX-validate (care-ux-validator, judgment tier)**

- Playwright MCP: drive the app, check UI against `ui-surfaces.md`
- Checks: overflow, truncation, mobile responsiveness (375/768/1280px), touch targets, A11y
- Verdict: `pass` | `overflow` | `responsive-fail`
- Fail → back to Step 3 with findings

### Step 5: Gate + Push (orchestrator)

- Full `run_gate.sh` (build, type-check, tests)
- Commit if dirty
- Push if ahead
- `gh pr create` (round 1)
- Post screenshots + replies

On gate failure → loop back to Step 3.

### Step 5-waiting-ci (orchestrator)

**Blocking poll:** `poll-pr.sh -s -c <sha>` until CI green or timeout. Re-invoke on timeout (no max).

### Step 6a: Triage (care-triager, judgment tier)

**Input:** Pre-digested bot feedback from `collect-feedback.sh` + `feedback.md`.

**Output:**

- `verdicts.md` — per-item verdict list:
  ```
  item | verdict | class | missed_by | reason
  ─────┼─────────┼───────┼───────────┼────────
  (repeating rows, one per bot finding)
  ```
- Tallies: `addressCount`, `declineCount`, `deferCount`

**Verdicts:**

- **address** → implementer will fix in round+1
- **decline** → documented, move on
- **defer** → escalate to human checkpoint

Zero address items + CI green + threshold met → Step 7 (done).
Address items → Step 6b.
Defer-to-human → checkpoint (6a outcome journaled; loop exits for human input).

### Step 6b: Apply (implementer, maker tier)

- Apply verdicts from `verdicts.md`
- Stage replies
- Loop back to Step 5 (next round)

### Step 7: Done (orchestrator)

- Exit report
- Cleanup reminder

---

## Data Model & Evidence Contract

### The Journal — Single Source of Truth

`<run-dir>/journal.jsonl`, append-only, one JSON object per line, `fsync` after each append, hash-chained (previous line's sha256 for tamper/truncation detection):

```jsonc
{
  "seq": 41,
  "ts": "2026-07-15T14:22:33.123Z",
  "run_id": "care_fe-eng-729-…",
  "event": "step.exit",
  "step": "4a",
  "round": 1,
  "data": {
    "reason_code": "review_findings_applied",
    "result": "skills/care-reviewer-r1.result.json",
  },
  "cost_cum": { "usd_est": 3.41 },
  "prev": "sha256:…",
}
```

**Event vocabulary:**

- `run.start` / `run.resume` / `run.end`
- `step.enter` / `step.exit`
- `gate.asked` / `gate.answered`
- `spawn.start` / `spawn.result` / `spawn.invalid` / `spawn.retry` / `spawn.escalate`
- `skill.invoke` / `skill.result`
- `helper.exec` (bash calls)
- `decision` (FSM transition + inputs)
- `push`, `ci.wait` / `ci.done`, `checkpoint.written`, `budget.stop`, `plan.approved`

**Derived views** (regenerable from journal):

- **`state.json`** — snapshot projection, same schema as today (sole writer: `state.ts`)
- **`loop.log`** — human narrative, one line per event
- **Doctor input** — journal + JobResults directly

### The JobResult Schema — Worker Boundary

Transport: opencode structured output (schema-validated at runner).

```jsonc
{
  "schema": "care-loop/jobresult@1",
  "role": "care-reviewer",                    // enum: care-reviewer, implementer, care-triager, care-test-grader, care-ux-validator
  "run_id": "care_fe-eng-729-…",
  "round": 1,
  "terminal_state": "done",                   // done | needs_input | blocked | failed
  "verdict": "pass",                          // role-specific: pass | findings | wrong | overflow | …
  "reason_code": "review_findings_applied",   // machine-readable for FSM + doctor
  "artifact": "skills/review-r1.md",          // human-readable output
  "artifact_sha256": "…",
  "questions": null,                          // needs_input only
  "evidence": ["src/…/PrintInvoice.tsx:88"],
  "model_used": "claude-opus-4-8",            // agent self-report + cross-check vs SDK metadata
  "model_pin_satisfied": true,                // opencode report, not self-report
  "cost": {"input_tokens": 0, "output_tokens": 0, "usd_est": 0.0},
  "duration_ms": 12345,
  "started_at": "…",
  "ended_at": "…",
  "payload": {                                // role-specific findings/tallies
    "findings": […],
    "missed_items": […]
  }
}
```

**Guarantee model:**

- **State integrity:** impossible by construction (only `state.ts` writes state)
- **Agent compliance:** NOT impossible by construction (LLM is fallible) — but **loud, journaled, retried** (detect-and-retry) instead of silently absorbed
  - Invalid/missing after retries = spawn failure → escalation ladder
  - Retry ×2, then escalate implementer → heavier model or judgment → human checkpoint

### Skill Methodology Injection

Reviewer, planner, and triager prompts source their methodology from canonical files (via named HTML-comment regions) to prevent drift:

| Role            | Source                                                                                     | Region                                            | Strategy                                          |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------- |
| `care-reviewer` | `care-diff-review/SKILL.md` + `care-technical-review/SKILL.md` + `care-ux-review/SKILL.md` | `name="default"` (static mode only for ux-review) | Read at process start, compose into system prompt |
| `care-planner`  | `care-planner/SKILL.md`                                                                    | `name="default"`                                  | Read at process start, compose into system prompt |
| `care-triager`  | `care-triager/SKILL.md`                                                                    | `name="default"`                                  | Read at process start, compose into system prompt |

Regions are marked with HTML comments:

```markdown
<!-- care-loop:methodology name="default" -->

… reusable methodology core …

<!-- /care-loop:methodology -->
```

This prevents:

- Paraphrase drift (methodology stays in one place)
- Dead prose ("do X" instructions that no longer apply to loopd)
- Host-specific mechanics bleeding into headless spawns

### Model Selection

`care-loop/models.json` configures the engine per role:

```json
{
  "provider": "github-copilot",
  "tiers": {
    "judgment": "claude-opus-4.8",
    "maker": "claude-sonnet-4.6"
  },
  "roles": {
    "reviewer": "claude-opus-4.8",
    "planner": "claude-opus-4.8",
    "triager": "claude-opus-4.8",
    "implementer": "claude-sonnet-4.6"
  }
}
```

Tiers + optional per-role override allows:

- Local models via `models.local.json` (same structure)
- Decoupled from skill methodology (which says "judgment tier", not "specific model")
- Plan gate enforces: planner must run on the configured judgment engine, checked via `modelPinSatisfied` (opencode's report)

---

## Care Loop Doctor

### Evidence Contract

A loopd run dir is self-contained and self-identifying. The doctor reads:

| Tier  | Source                                                                                  | What it gives                                                                         |
| ----- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **J** | `journal.jsonl` + `skills/<role>-r<N>.result.json` sidecars + `state.json` + `loop.log` | Timeline, verdicts, models, durations, findings, CI rounds, checkpoints, crash signal |
| **C** | Plan artifacts + `feedback.md` + `gate/*.log`                                           | Ground truth (acceptance criteria, scope baseline, bot feedback, helper output)       |

Both are **always present** for a loopd run.

**No more Tier A/B** (chat sessions) — they never existed for headless runs, and pre-loopd runs are already diagnosed.

### Rubric (8 Dimensions, All Exact Reads)

| #   | Dimension                 | Evidence                                                     | Red flags                                                                            |
| --- | ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | **Model-tier compliance** | `skill.result.model` per spawn + sidecar `modelPinSatisfied` | judgment spawn on wrong tier; planner gate fired                                     |
| 2   | **Termination & resume**  | `run.end` outcome + `-ing` markers in `state.json` at death  | missing `run.end`; torn tail; stale resume                                           |
| 3   | **Token economy**         | `cost_cum.usd_est` from journal; `durationMs` per spawn      | high cost/duration; retry/escalate counts                                            |
| 4   | **Pipeline adherence**    | `step.enter/exit` sequence + `helper.exec` before `push`     | out-of-order steps; gate → push without proper order                                 |
| 5   | **Output validity**       | `spawn.invalid` events (JobResult schema failures)           | recurring invalid output per role                                                    |
| 6   | **Bot-round efficiency**  | `ci.wait`/`ci.done`; `round` increments; triager tallies     | `budget.stop max_rounds` (capped); repeated timeouts; addressCount not trending down |
| 7   | **Cross-run trends**      | Read `IMPROVEMENTS.md` + recent reports FIRST                | re-observed finding bumps `seen:`; `applied` entry recurs = regression               |
| 8   | **Escape attribution**    | `verdicts.md` `class × missed_by` rows                       | same `class × missed_by` pair recurring (skill fix needed)                           |

**Era note:** IMP-1 through IMP-13 are pre-loopd and mostly **structurally obviated**. Don't re-propose edits against deleted guides.

### Workflow

1. **Gather** — list `care-loop/runs/*/` with `journal.jsonl`; explicit path wins
2. **Read** — `loop.log` (narrative) + `state.json` (outcome); grep journal for specifics; open sidecars for detail
3. **Analyze** — apply rubric (dim 7 first, then 1–8); every finding carries evidence pointer (journal seq or sidecar path)
4. **Report + Backlog** — write `diagnoses/<date>-<slug>.md`; merge into `IMPROVEMENTS.md` (fingerprinted; re-observations bump `seen:`)
5. **Gate + apply** — consolidated ask, split by apply-authority:
   - **Apply-now:** methodology regions, lens skills, `models.json`, doctor's own files (all markdown/config)
   - **Propose-only:** `orchestrator/src/*.ts` (tested code; propose as a patch, do NOT auto-apply)

### Apply Scope

Post-cut, improvements land on:

- **Methodology** → `care-planner/SKILL.md` / `care-triager/SKILL.md` marked regions or lens skills (doctor applies directly)
- **Model routing** → `models.json` (doctor applies directly)
- **Behavior** → `orchestrator/src/*.ts` (doctor proposes as a patch; author applies + `npm test`)

### Autonomous End-of-Run Mode (auto-doctor)

Every completed loopd run auto-invokes the doctor (default-on; `--no-doctor` / `CARE_DOCTOR=0` to opt
out). The autonomous flow diagnoses the run, applies **eval-covered** skill edits, verifies them with
orchestrator tests + affected care-evals, and opens a **self-improvement PR** carrying the diagnosis.
It is best-effort: any throw is journaled (`doctor.error`) and swallowed — the loop's real outcome is
never affected.

**Deterministic scaffold, LLM core.** The doctor LLM is invoked ONLY for judgment (diagnose + edit
skill prose + author fixtures) via an injected `spawnDoctor` seam. Every side-effect — git branch,
running tests/evals, the coherence check, `gh pr create`, journaling — is orchestrator-owned and
deterministic. Risky verbs (git/gh/npm) stay off the autonomous agent. Code lives in
`orchestrator/src/auto-doctor.ts` (pure decision logic, fake-testable) + `auto-doctor-wiring.ts` (real
seams); the PR lands on the **skills** repo (`ohcnetwork/skills`), not the care_fe worktree.

**Apply authority is tiered by eval coverage** — a control we can't measure with a fixture must not
auto-merge:

| Target                                                                            | Eval coverage                            | Authority                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| `care-review`, `care-test-grade`, `care-ux-review`, `care-triager`, `care-ci-fix` | ✅ cr-\* / tg-\* / ux-\* / tr-\* / cf-\* | Auto-apply, gated by affected-eval regression + `npm test` |
| `care-diff-review`, `care-technical-review` (lenses)                              | ⚠️ indirect (via cr-\*)                  | Auto-apply only if it keeps the cr numbers green           |
| `care-planner`                                                                    | ❌ not diff-graded                       | Propose-only — unverifiable ⇒ draft PR                     |
| `models.json`                                                                     | ✅ via the eval it re-pins               | Auto-apply, gated by an eval on the new pin                |
| `orchestrator/src/*.ts`                                                           | n/a (computational)                      | Propose-only always — a human owns it                      |

Red / coherence-fail / unverified-tier edits route to a **draft** PR; no edits → report-only commit,
no PR. Journal events: `doctor.start` / `doctor.apply` / `doctor.coherence` / `doctor.verify` /
`doctor.pr`. See [PLAN-auto-doctor.md](care-loop/PLAN-auto-doctor.md) for the full design (sensor-type
framing, recurrence gate on fixtures, coherence gate).

---

## Component Reference

### Orchestrator Directory Layout

```
care-loop/orchestrator/
  src/
    cli.ts                # Entry point, args, run dispatch
    fsm.ts                # FSM table + transition function
    state.ts              # State projection + validation (sole writer)
    journal.ts            # Append-only, hash-chained log
    render.ts             # loop.log narrative renderer
    runner.ts             # opencode SDK spawn wrapper
    plan.ts               # Step 1 + plan gate
    skill-log.ts          # JobResult sidecar writer ("SKILL SELF-IMPROVEMENT" header)
    default-wiring.ts     # Seams: orchestrator calls into helpers + SDK
    ci-round.ts           # Steps 5-waiting-ci + 6a + 6b feedback loop
    gate-terminal.ts      # Gate adapter (tty vs checkpoint)
    front-terminal.ts     # Terminal output + status
    budget.ts             # Cost ledger, caps, STOP
    resume.ts             # Startup recovery + decision table
    skill-source.ts       # Load methodology regions from skill files
    models-config.ts      # Load model selections from models.json
    auto-doctor.ts        # End-of-run self-improvement stage (pure decision logic)
    auto-doctor-wiring.ts # Real seams for the auto-doctor (git/tests/evals/gh/spawn)
  test/
    *.test.ts             # FSM table tests, journal replay, resume decision tests
  package.json
  tsconfig.json
```

### Key Helpers (bash)

- `run_gate.sh` — full build + test gate before push (memory-heavy, subprocess)
- `poll-pr.sh` — blocking CI poll until green
- `collect-feedback.sh` — pre-digest bot feedback into `feedback.md`
- `preflight.sh` — pre-run checks
- `pw-lock.sh` — global Playwright mutex

### Skill Files

- **Judgment lenses** (methodology source):
  - `care-diff-review/SKILL.md` — intent/legibility lens
  - `care-technical-review/SKILL.md` — approach/simplicity lens
  - `care-ux-review/SKILL.md` — UI validation (static + live modes)
- **Role skills** (methodology source):
  - `care-planner/SKILL.md` — planning methodology
  - `care-triager/SKILL.md` — triage methodology

### Doctor Directory Layout

```
care-loop-doctor/
  SKILL.md              # User-facing doc (workflow, evidence, non-goals)
  rubric.md             # 8 dimensions, exact-read evidence, red flags
  diagnoses/
    <date>-<slug>.md    # Report per run (findings, evidence, healthy signals)
    IMPROVEMENTS.md     # Durable backlog (fingerprinted, cross-run)
```

---

## Key Decisions

### Why build instead of adopt (Bernstein)?

**Bernstein** (Apache-2.0 Python scheduler) is the closest prior art: deterministic, crash-recovery, ledger/replay journal. But:

- **Fit vs shape mismatch:** Bernstein is fan-out (one goal → N parallel tasks); care-loop is one-task-repeated-in-rounds (iteration against feedback)
- **Two documented limits** are care-loop's signature features:
  - No interactive interview (care-loop needs it; costs ~70% of Bernstein wrapper)
  - No bot-review round loop (care-loop needs it; costs the other ~30%)
- **Reversal trigger:** if care-loop turns fan-out (many tickets auto-dispatched in parallel), Bernstein becomes worth revisiting

### Why opencode + Copilot over Claude Agent SDK?

**REVISION 2026-07-13:**

1. **Cost/access** — drive judgment spawns on existing GitHub Copilot subscription (device-code OAuth, "zero setup") vs metered Anthropic API key
2. **Native headless** — `opencode serve` (HTTP/OpenAPI) + `opencode run` exactly match the off-chat-turn runtime the design calls for
3. **Schema boundary for free** — opencode's `session.prompt({ format: { type:"json_schema", schema } })` returns `structured_output` with built-in retries + validation; the JobResult v1 seam is enforced-and-retried by the runner
4. **Capability parity** — per-role `model` pin, `permission` allow/ask/deny, session fork/resume for interviews, SSE events for §11 cloud path

### Why TypeScript for the orchestrator?

- **Native to loopd's home context** — JavaScript/Node already runs the CI hooks, `run_gate.sh`, Playwright
- **Typed client available** — `@opencode-ai/sdk` is typed; JSON schema validation via `ajv`
- **SSE first-class** — structured output and event streaming are built-in (important for the cloud path)

### Why inject methodology instead of native skill tool?

**Strategy 2 (inject at process start)** vs Strategy 1 (native skill tool, two turns):

- Strategy 1 costs ~2× latency/turn and re-opens the hang surface (agentic turn with tools back on)
- Strategy 2 reads the same file once at startup, composes into system prompt, one structured turn
- **Lenses have no includes** — no progressive-disclosure advantage to the skill tool
- **Same applies to reads** — both `readFileSync` and the skill tool source the same file; neither stays stale relative to it
- Reserve Strategy 1 only if a lens later grows `{file:}` includes

### Why single-writer state?

Only `state.ts` writes `state.json`. Agents produce artifacts + typed results; orchestrator is the sole writer of durable state. This:

- **Prevents drift by construction** — no agent prose accidentally modifying state
- **Makes resume exact** — replay journal, project state.json, compare to ground truth, reconcile contradictions

---

## Future Directions (Not in v1)

### Event-driven / cloud mode (§11)

Designed-for but not built. The headless local design is one config flip from event-triggered:

- **Trigger + Dispatcher** — webhook (e.g. Jira ticket) → queue → provision worktree, launch loopd
- **Waits become suspend-and-resume-on-event** — journal a checkpoint, exit; webhook fires loopd resume
- **Identity flips** — local = push as user; cloud = GitHub App installation token (care-loop[bot])
- **Sandbox + tool allowlists replace per-command approval** — headless doesn't autorun by default; replaced by ephemeral container, runner's deny-list, least-privilege token, egress limits

All infrastructure in place; need: webhook receiver, token issuer, cloud provisioning.

### Parallel fan-out (steps 4a–4c)

Currently sequential; could run review, test-grade, ux-validate in parallel (checker ≠ maker, no shared context).

### Skill-specific evals (care-evals)

Offline eval harness (`care-evals/`) exercises reviewer/triager against pre-authored ground-truth diffs (seeded defects + controls) with no PR/CI in the way. Measures:

- Valid JobResult rate (>90% pass threshold)
- Severity calibration (blocked vs findings)
- False-positive count

Before/after delta verifies skill edits; standing rule: no skill change lands without an eval delta.

---

## Appendix: Run Directory Structure

```
care-loop/runs/<owner>-<branch>/
  journal.jsonl                           # Hash-chained event log
  state.json                              # Snapshot projection
  loop.log                                # Human narrative
  .orchestrator.lock                      # Per-run lockfile (pid + atomic)

  # Plan stage
  task.md                                 # Change request
  criteria.md                             # Acceptance criteria
  baseline.md                             # Scope, files, approach + planned_by
  decisions.md                            # Settled design decisions + dev creds
  ui-surfaces.md                          # UI breakpoints to validate (if tsx)

  # Feedback stage
  feedback.md                             # Pre-digested bot feedback per round
  verdicts.md                             # Triager verdict list (per-item class × missed_by)

  # Skill results (sidecars)
  skills/
    care-planner-r0.input.json            # What the skill saw
    care-planner-r0.result.json           # JobResult envelope
    care-reviewer-r1.input.json
    care-reviewer-r1.result.json
    care-test-grader-r1.input.json
    care-test-grader-r1.result.json
    care-ux-validator-r1.input.json
    care-ux-validator-r1.result.json
    care-triager-r1.input.json
    care-triager-r1.result.json
    implementer-r1.input.json
    implementer-r1.result.json
    …

  # Gate stage helper output
  gate/
    implementer.log                       # Step 3 helper logs
    push.log                              # Step 5 push + gate logs
    questions-r<N>.md                     # Interview questions (checkpoint gate)
    answers-r<N>.md                       # Human's answers (checkpoint gate)

  # Git artifacts
  .git/
  worktree-ref                            # Symbolic ref to the main worktree
```

---

**End of Architecture Document**

For updates to this guide, check `PLAN-orchestrator-architecture.md` for design-of-record details, and the repo's as-built change log for what actually shipped.
