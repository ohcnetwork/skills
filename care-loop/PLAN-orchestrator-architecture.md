# `care-loopd` — the headless deterministic orchestrator (plan of record)

> **Status: DECIDED 2026-07-12 — build.** The single active plan for moving care-loop off the VS Code
> chat turn onto a headless deterministic loop. Self-contained: §0 is the decision + prior-art record
> (adopt-vs-build), §1–10 the implementation-ready design, §11 the event-driven/cloud future. Carries
> its own abort criterion (§10 phase 2). Judgment content (guides, agents) is reused unchanged — this
> document is only the control plane.

> **REVISION 2026-07-13 — runner changed: opencode + GitHub Copilot (supersedes the Claude Agent SDK
> choice in §0/§4).** The _design_ is unchanged — every design principle, the FSM, journal,
> single-writer state, resume table, gate, and budget are runner-agnostic and stand as written. Only
> the **runner** swaps, because the plan deliberately kept it behind the §3 JobResult boundary. Why:
> (1) **cost/access** — drive judgment/mechanical spawns on the existing **GitHub Copilot
> subscription** (opencode's Copilot provider, device-code OAuth, "zero setup") instead of a metered
> Anthropic API key; (2) **native headless** — `opencode serve` (HTTP/OpenAPI) + `opencode run` are
> exactly the off-the-chat-turn runtime §0 argues for, retiring the terminal-wedge / host-death class
> the doctor just re-confirmed (IMP-6/9/13, 2026-07-13-eng648-729); (3) **the §3 boundary comes for
> free** — opencode's `session.prompt({ format: { type:"json_schema", schema } })` returns a
> schema-validated `structured_output` with built-in `retryCount` + `StructuredOutputError`, i.e. the
> JobResult v1 seam is enforced-and-retried by the runner instead of a hand-rolled file-hash check.
> **Capability parity confirmed** (opencode docs, 2026-07-13): per-role `model: provider/model` pin +
> `permission` allow/ask/deny (incl. bash-glob deny-list) via JSON/markdown agents; session
> fork/resume for the planner interview; `event.subscribe()` SSE + `prompt_async` for §11.
> **Orchestrator language — DECIDED 2026-07-13: TS/Node on `@opencode-ai/sdk`** (typed client,
> native structured output, SSE events first-class; the `opencode serve` HTTP path stays available
> for the CLI/subprocess fallback). §9's package layout is therefore a TS package (`.ts` files); §4
> is written for opencode either way. Bernstein reversal trigger (fan-out) is unaffected.

## 0. Decision & prior art (why build, not adopt)

**The current architecture is the bug.** Orchestration lives inside a VS Code Copilot chat turn, and
three observed failures all trace to that fused runtime: (a) **no autonomous re-entry** — CI/bot waits
park the loop for a manual "status check" (doctor IMP-5); (b) **host death kills the orchestrator** —
VS Code OOM under two concurrent loops (IMP-6/9); (c) **the router doing mechanical work** — the cheap
Sonnet tier silently dropped the state/observability contract (IMP-3/7 regression, 2026-07-12). These
are architectural, not prose-fixable — the last several doctor IMPs were band-aids on this seam.

**Adopt-first was evaluated seriously, then declined on arithmetic — not preference.** Bernstein
(`chernistry/bernstein`, Apache-2.0) is the closest prior art: a deterministic Python scheduler with
worktree-per-task, crash recovery, and a ledger/replay journal. It fits care-loop's _spine_ but not
its _shape_. Bernstein is a **fan-out** engine (one goal → N parallel tasks); care-loop is **one task
iterated in rounds** against external feedback (bots/CI/humans). Its two documented limits —
**one-shot plan approval** (no interactive interview) and **`BLOCKED`-with-manual-resume** (no
bot-review round loop) — are precisely care-loop's two signature features, so both wrappers land on
_our_ side of the seam: the **interview gate runs before** Bernstein (= our runner + gate) and the
**bot-review loop runs after** it (= our fsm + journal + resume). We would own ~70% of `care-loopd`
anyway, plus a framework dependency and the seam between them, while Bernstein kept only "implement
this list in a worktree" — one SDK call. No best-case spike outcome (its only unknowns were the
`pre_merge` hook and a `pw-lock` hook) can flip that, so the spike was superseded and we build.
**Reversal trigger:** if care-loop ever turns fan-out (many tickets auto-dispatched in parallel),
Bernstein's shape fits and this is worth revisiting.

**Adopted wholesale — the runner:** ~~Claude Agent SDK~~ **opencode + GitHub Copilot** (see REVISION
2026-07-13 above) — headless spawn via `opencode serve`/`run`, per-role model pin + tool allowlist,
unattended permission mode, and a native schema-validated result boundary (§3). **Borrowed patterns (source):** deterministic script
orchestrator · schema-validated worker boundary · hash-chained journal + replay · heavier-model
escalation (Bernstein); BUDGET/STOP loop contract (Loop Engineering); CI-feedback routing (Composio
AO). **Rejected:** Composio AO / AgentWrapper (desktop-supervised, fixed loop); Temporal/LangGraph
(git-state suffices at this scale); Bernstein's compliance chassis (HMAC/JWS/regulatory — off, not
adopted).

## Design principles (each traces to an observed failure)

1. **No LLM in the control loop.** Every scheduling/transition decision is plain Python over
   validated inputs (exit codes, JobResults, git/gh facts). _Fixes: router drift (IMP-3/7), the
   Sonnet-router contract collapse of 2026-07-12._
2. **The model never writes state.** Agents produce artifacts + a typed result; the orchestrator is
   the single writer of `state.json` and the journal. _Fixes: state drift by construction._
3. **Waits are real blocking calls.** `poll-pr.sh` blocks a thread, not a chat turn. When it
   returns, the next line of Python runs. _Fixes: the "status check?" nudge (IMP-5)._
4. **Crash-only design.** The process may die at any instruction; recovery is always
   journal-replay + ground-truth reconcile, never "hope it was between steps." There is no
   graceful-shutdown path to maintain — startup IS the recovery path. _Fixes: the VS Code OOM class
   (IMP-6/9), formalizes PLAN-resume._
5. **Judgment is pinned, mechanical is cheap, and the split is enforced by config, not prose.**
   The SDK pins each agent's model; the orchestrator costs nothing per decision. _Retires IMP-1
   attestation, resolves IMP-7._
6. **Every run is explainable from its journal alone.** The doctor (and a human) must be able to
   reconstruct what happened without chat-session archaeology. _Fixes: IMP-11, the doctor's
   reconstruction tax._

## Component map

```
                                ┌───────────────────────────────────────────┐
                                │  care-loopd  (Python, one process / run)  │
  user / (later: webhook) ────► │                                           │
   `care-loopd start|resume`    │  cli.py      entry, args, tmux hint       │
                                │  fsm.py      step table + transition fn   │
                                │  journal.py  append/verify/replay         │
                                │  state.py    state.json single writer     │
                                │  runner.py   Agent-SDK spawn + JobResult  │
                                │  gate.py     plan-gate adapters (tty/ckpt)│
                                │  shell.py    bash-helper subprocess wrap  │
                                │  budget.py   cost ledger, caps, stop      │
                                └──────┬──────────────┬─────────────────────┘
                                       │              │
                     Claude Agent SDK  │              │  subprocess (unchanged bash)
                     query()+agents{}  │              │  run_gate.sh · poll-pr.sh ·
                     model-pinned      ▼              ▼  pw-lock.sh · preflight.sh ·
                          care-planner / care-reviewer   collect-feedback.sh ·
                          care-test-grader / care-ux-    resume-probe.sh ·
                          validator / care-triager /     post-ui-screens.sh
                          implementer
```

**What is deleted:** the VS Code chat turn as runtime; the LLM router; `write-state.sh`-as-LLM-contract
(retained only for legacy/manual runs). **What is reused verbatim:** every bash helper, every guide as
agent-prompt content, the run-dir artifact set, worktree-first + `pw-lock` (PLAN-worktrees), the
resume decision table (PLAN-resume).

## 1. Process model

- **One orchestrator process per run**, cwd = the run's worktree, launched detached
  (`tmux new -d -s care-<slug> care-loopd start …` is the documented default; plain `nohup` works).
  VS Code is demoted to a viewer (`tail -f` the rendered log, or the editor open on the worktree).
- **Concurrency between runs** is already solved: worktree isolation + the `pw-lock` global mutex
  for the shared Playwright backend. The orchestrator adds a **per-run lockfile**
  (`<run-dir>/.orchestrator.lock`, pid + mkdir-atomic like `pw-lock.sh`) so a double
  `start`/`resume` can't produce two writers of one journal. Stale lock (dead pid) is stolen.
- **In-process layout:** the FSM runs on the main thread; agent spawns and blocking waits run
  inline (sequential loop — no async framework needed). The only concurrency inside a run is what
  the SDK does internally, plus 4a/4b/4c which MAY fan out as three parallel SDK calls
  (checker-≠-maker means they don't share context anyway); v1 runs them sequentially, fan-out is a
  flagged optimization.
- **Host-safety:** the memory-heavy stages (build, Playwright) stay inside `run_gate.sh` with its
  `NODE_OPTIONS` cap (IMP-6 fix) — the orchestrator inherits that for free by shelling out. Two
  concurrent runs are safe because they are two OS processes with a mutex, not two agents inside
  one editor heap.

## 2. The FSM (steps, owners, transitions)

Step vocabulary is preserved from `write-state.sh --vocab` (compat with existing tooling, doctor,
and human muscle memory). The `-ing` markers become unnecessary — the journal records
`step.enter`/`step.exit` events with finer grain — but are still written to `state.json` for
human/legacy readability.

| step             | owner                                          | does                                                                                               | success →                     | failure →                         |
| ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------- |
| `1` plan         | **care-planner** (judgment)                    | recon, draft criteria/baseline/decisions/ui-surfaces, batched questions                            | GATE (plan gate)              | escalate/abort                    |
| GATE             | **human** via gate adapter                     | answer interview, approve plan                                                                     | `2`                           | abort (nothing pushed)            |
| `2` setup        | orchestrator                                   | worktree + branch (`git worktree add -b`), node_modules clone, env copy                            | `3`                           | abort                             |
| `3` implement    | **implementer** (maker)                        | code + specs per plan; inner `run_gate.sh -n`                                                      | `4a`                          | retry ×R → escalate               |
| `4a` review      | **care-reviewer** (judgment)                   | /care-review lenses on the diff, apply worth-deciding findings, declined.md                        | `4b`                          | block → `3` with findings         |
| `4b` test-grade  | **care-test-grader** (judgment, checker≠maker) | grade specs vs criteria                                                                            | `4c`                          | Wrong → `3` with grade            |
| `4c` ux-validate | **care-ux-validator** (judgment)               | breakpoints/overflow/siblings via ui-surfaces.md                                                   | `5`                           | block → `3` with findings         |
| `5` gate+push    | orchestrator                                   | full `run_gate.sh`, commit if dirty, push if ahead, `gh pr create` (round 1), post screens/replies | `5-waiting-ci`                | gate red → `3` with log tail      |
| `5-waiting-ci`   | orchestrator                                   | **blocking** `poll-pr.sh -s -c <sha>` (tier timeout; re-invoke ×N)                                 | `6a`                          | timeout budget spent → checkpoint |
| `6a` triage      | **care-triager** (judgment)                    | collect-feedback digest → verdicts.md (address/decline — **no defer-to-human**, removed 2026-07-16; out-of-scope is declined-with-reason) | `6b` (address >0) / `7`-check | ci_red_no_verdicts → checkpoint   |
| `6b` apply       | **implementer**                                | apply address verdicts, stage replies.md                                                           | `5` (next round)              | retry → escalate                  |
| `7` done         | orchestrator                                   | exit report, terminal state, worktree-cleanup reminder                                             | —                             | —                                 |

**Round loop:** `5 → 5-waiting-ci → 6a → 6b → 5 …` until 6a yields zero address items AND CI green
AND bot threshold met (the existing ≥4/5 Greptile-style exit), or **STOP** fires (below). All exit
thresholds come from the tier table in SKILL.md, loaded as config — not decided per-run by a model.

**Transition function contract:** `next = transition(step, inputs)` where `inputs` is only
(validated JobResult | helper exit code + parsed summary line | budget state). Pure, table-driven,
unit-testable without any LLM. Every call appends a `decision` event to the journal with its inputs —
this is what makes the run replayable/auditable (Bernstein's property, minus the HMAC ceremony).

## 3. Worker boundary — `JobResult` v1 (the schema-validated seam)

Transport: **opencode structured output — schema-validated at the runner** (REVISION 2026-07-13).
The orchestrator sends the role's task via `session.prompt({ format: { type:"json_schema", schema:
<JobResult@1> } })`; opencode returns the validated object as `structured_output` (with `retryCount`

- a `StructuredOutputError` on repeated failure), so a malformed result is the runner's problem, not
  ours. The agent is ALSO told to write `<run-dir>/agents/<role>-r<round>.result.json` (same bytes) as
  the durable, SDK-independent artifact the journal points at and the doctor reads; the orchestrator
  cross-checks the file against the structured payload. (The original file-transport + independent
  hash-guard remains the fallback for the `opencode run --format json` subprocess path if the language
  decision lands on driving the CLI instead of the SDK.)

```jsonc
{
  "schema": "care-loop/jobresult@1",
  "role": "care-reviewer", // enum, must match the spawned role
  "run_id": "care_fe-eng-729-…",
  "round": 1,
  "terminal_state": "done", // done | needs_input | blocked | failed
  "verdict": "pass", // role-specific enum: pass | findings | wrong | overflow | …
  "reason_code": "review_findings_applied", // machine-readable outcome for the FSM + doctor
  "artifact": "agents/review-r1.md", // the real output (human-readable, as today)
  "artifact_sha256": "…",
  "questions": null, // needs_input only: [{id, q, options?, recommended?}]
  "evidence": ["src/…/PrintInvoice.tsx:88", "gate/tsc.log"],
  "model_used": "claude-opus-4-8", // agent self-report; cross-checked vs SDK metadata
  "cost": { "input_tokens": 0, "output_tokens": 0, "usd_est": 0.0 },
  "started_at": "…",
  "ended_at": "…",
}
```

Validation (jsonschema, vendored — no network): unknown keys rejected, enums enforced,
`model_used` must equal the SDK's reported model AND satisfy the role's pinned tier (belt +
suspenders on IMP-1). **Invalid/missing result = the spawn failed**, regardless of what prose the
agent produced → retry policy applies. `verdict`/`reason_code` vocabularies are defined per role in
one `roles.py` table next to the FSM — the FSM switches ONLY on these, never on artifact prose.

**Guarantee precision (be honest about which class each is):** _state integrity_ is
impossible-by-construction — only `state.py` writes state, and no LLM output can change that. _Agent
compliance_ (writing a valid JobResult) is NOT impossible-by-construction — it is the same class of
problem as write-state.sh-by-LLM: an LLM asked to end with a valid artifact. What the boundary
upgrades is the failure mode: non-compliance is **loud, journaled, and retried** (detect-and-retry)
instead of silently absorbed — the Sonnet-router collapse of 2026-07-12 was dangerous precisely
because it was silent. Do not describe the second guarantee as the first.

## 4. Runner — opencode integration (REVISION 2026-07-13; was Claude Agent SDK)

- **Transport:** the orchestrator talks to a long-lived `opencode serve` (HTTP/OpenAPI) via the
  typed `@opencode-ai/sdk` client (language decision A) or plain HTTP (decision B); one opencode
  **session per spawn**. `opencode run --attach <url>` is the CLI equivalent for a subprocess path.
  The Copilot provider is authed once (`opencode auth login` → GitHub Copilot device code); models
  are addressed as `github-copilot/<model>`.
- **Agents = opencode agents.** The existing [agents/claude/](./agents/claude) role files port to
  opencode agent definitions (markdown frontmatter or `opencode.json` `agent{}`): `model` pinned per
  role (judgment = `github-copilot/`-opus-tier, implementer = configurable cheap tier — safe because
  it owns no contract), `mode: subagent`, and a `permission` block. Prompt body = the role guide, as
  today.
- **Tool allowlist + deny-list via `permission`:** reviewer/test-grader/triager get read-only
  (`edit: deny`, `bash` restricted to `git diff`/`grep`/log globs); implementer gets `edit: allow` +
  scoped `bash`; ux-validator gets the Playwright MCP. The hard deny-list (`git push --force`,
  `git reset --hard`, `rm -rf`, credential reads) is bash-glob `deny` at the global `permission`
  level. **Push is orchestrator code (Step 5), never an agent tool** — unchanged.
- **Result boundary:** each spawn requests JobResult@1 as structured output (§3) and is told to
  also write the `.result.json` artifact. Invalid/missing after opencode's own retries = spawn
  failure → the escalation ladder.
- **The interview uses opencode session resume:** the planner returns `needs_input` + `questions[]`;
  the orchestrator gates; then **forks/continues the same planner session** (`session.fork` /
  `--session <id>`) with the answers, preserving recon context. Session ids are journaled, so the
  interview survives an orchestrator crash.
- **Escalation ladder (Bernstein pattern):** per role `retry: {max: 2, then: escalate}` — re-spawn
  with failure context appended; second failure escalates implementer→heavier `github-copilot/`
  model or judgment→human checkpoint. All ladder decisions journaled with `reason_code`.
- **Host-safety note:** opencode runs the agents; the memory-heavy build/Playwright stages still go
  through `run_gate.sh` (subprocess, `NODE_OPTIONS` cap — IMP-6), so the orchestrator process stays
  light regardless of the language decision.

## 5. Journal — single source of truth

`<run-dir>/journal.jsonl`, append-only, one JSON object per line, `fsync` after each append,
hash-chained (`prev` = sha256 of previous line — tamper/truncation _detection_, no HMAC/signing):

```jsonc
{
  "seq": 41,
  "ts": "…",
  "run_id": "…",
  "event": "step.exit",
  "step": "4a",
  "round": 1,
  "data": {
    "reason_code": "review_findings_applied",
    "result": "agents/care-reviewer-r1.result.json",
  },
  "cost_cum": { "usd_est": 3.41 },
  "prev": "sha256:…",
}
```

Event vocabulary: `run.start|resume|end`, `step.enter|exit`, `gate.asked|answered`,
`spawn.start|result|invalid|retry|escalate`, `helper.exec` (cmd, exit, summary line, log path),
`decision` (transition inputs → output), `push`, `ci.wait|ci.done`, `budget.tick|stop`,
`checkpoint.written`.

Derived views (never hand-written, always regenerable):

- **`state.json`** — snapshot projection of the journal head, same schema as today (single writer:
  `state.py`). Fleet view `cat runs/*/state.json` keeps working unchanged.
- **`loop.log`** — human narrative rendered from events (what the orchestrator used to ask the LLM
  to write).
- **doctor input** — the doctor reads the journal + JobResults directly; chat-log digging demotes
  to a legacy/honesty fallback. Rubric dims 1/3/4/5 (tiers, tokens, pipeline, schema) become exact
  reads instead of inference.

## 6. Resume — startup IS recovery

`care-loopd resume <run-dir>` (and `start` on an existing run dir = resume):

1. Acquire the run lockfile.
2. Read the journal; verify the hash chain; head = last intact entry (a torn final line is
   truncated off — crash-mid-append degrades to the previous entry, Bernstein's property).
3. Run `resume-probe.sh` (ground truth: tree dirty? local ahead? PR head? bots-at-head? CI?
   artifacts present?).
4. Apply the **PLAN-resume decision table** (journal step × ground truth → true re-entry step) —
   now mechanical code instead of guide prose. Contradiction between journal and ground truth →
   journal a `checkpoint` and surface to the human (gate adapter) rather than guess.
5. Idempotency at the edges, as designed: commit only if dirty, push only if ahead, skip threads
   already carrying a `— care-loop 🤖` reply at head, never re-apply an applied verdict.

A crashed **agent** (SDK call died / invalid JobResult) is the same code path as a failed one:
retry ladder. A crashed **orchestrator** is steps 1–5. There is no third case.

**Event-driven invariant (pins the cloud path open, §11):** no state may accumulate in-process across
any wait that isn't already in the journal. Consequence: every blocking wait (CI poll, gate) is
trivially convertible to _checkpoint + exit + resume-on-event_, exercising the exact code path the
`kill -9` acceptance test already proves.

## 7. Gate adapter — the one human seam

`gate.py` exposes `ask(questions) -> answers` and `approve(plan) -> bool` with two adapters:

- **`tty`** (v1 default): the orchestrator prints the batched interview to its terminal and blocks
  on input. Works because the process is ours — no chat turn to yield.
- **`checkpoint`** (v1, also the timeout/defer path): write
  `<run-dir>/gate/questions-r<n>.md`, journal `checkpoint.written`, **exit 0 with a clear
  message**. The human edits `answers-r<n>.md` and runs `care-loopd resume` — the resume path picks
  the answers up and resumes the planner session. This same mechanism serves the CI-round `deferred`
  checkpoints (poll-timeout, ci_red_no_verdicts — external stuck states, NOT the removed
  defer-to-human triage verdict) and (later) becomes the cloud async gate from PLAN-cloud-headless
  (post to Jira/Slack instead of a local file; the state machine is identical).

Authorization boundary is unchanged: **nothing is pushed before plan approval; plan approval
authorizes everything after it** (with the Scope Governor as the standing tripwire, evaluated by
the orchestrator from the diffstat — pure arithmetic, no model).

## 8. Budget & stop — the loop contract (Loop Engineering)

Config (per tier, overridable per run): `max_rounds` (existing cap), `max_wall_clock`,
`max_usd_est` (summed from JobResult.cost), `max_retries_per_step`, `poll_timeout ×
max_poll_reinvokes`. `budget.py` ticks on every journal append; breach → `budget.stop` event →
graceful checkpoint (never a hard kill mid-push: stop is only actioned at FSM boundaries).
STOP-success = 6a-clean + CI green + threshold met; STOP-failure = budget breach or escalation
exhausted → checkpoint with a rendered summary of where and why.

## 9. Config & layout

```
care-loop/
  orchestrator/            # NEW — the python package (self-contained, stdlib + agent-sdk + jsonschema)
    cli.py fsm.py roles.py runner.py journal.py state.py gate.py shell.py budget.py resume.py
    config.toml            # tier table, role→model pins, budgets, deny-list, paths
    tests/                 # FSM table tests, journal replay tests, resume decision-table tests
  agents/claude/*.md       # unchanged — now loaded by runner.py
  guides/*.md              # judgment content, referenced by agent prompts; orchestration prose
                           # progressively deleted as code absorbs it
  *.sh                     # unchanged helpers, called by shell.py
  runs/<slug>/             # run dir as today + journal.jsonl + .orchestrator.lock + *.result.json
```

Decisions locked (previously open): **runner = opencode + GitHub Copilot** (REVISION 2026-07-13) ·
**orchestrator language = TS/Node on `@opencode-ai/sdk`** (DECIDED 2026-07-13 — `orchestrator/` is a
TS package; the `.py` filenames above become `.ts`) · **JobResult = opencode structured output,
`.result.json` artifact retained** · **keep bash helpers** · **tty + checkpoint gates both in v1** ·
**VS Code = viewer only**.

## 10. Build order (each phase independently shippable + testable)

1. **`journal.py` + `state.py` + replay test** — pure, no LLM, no bash. Prove: append/verify/
   project state.json/render loop.log; property test truncation recovery.
2. **`runner.py` + JobResult** — spawn ONE real agent (care-reviewer, opus-tier `github-copilot/`
   model, unattended) **through opencode** (`opencode serve` + a `session.prompt` with the
   JobResult@1 json_schema, on the Copilot subscription) against a real diff from a terminal;
   validate the structured result + the mirrored `.result.json`. _This is the old Phase-0 spike,
   now inside the real skeleton — and the first proof that opencode + Copilot drives a pinned
   judgment agent headlessly._ Prove: headless judgment works end-to-end outside any editor.
   **ABORT CRITERION (the build's own go/no-go):** if unattended spawns can't produce a valid
   JobResult in **≥9/10 runs** across two different roles, STOP and re-evaluate the whole direction
   (including Bernstein) — every downstream phase assumes a reliable runner, and no orchestrator
   design fixes an unreliable one. Decision checkpoint after this phase either way.

   > **Phase 2.5 — `care-evals`, the runner's first consumer + abort-criterion testbed.** The
   > offline eval harness (sibling skill `care-evals/`) shares this exact stage → invoke → collect →
   > JobResult shape (§3–4) and exercises it against pre-authored ground-truth tasks (seeded-defect
   > diffs + clean controls) with **no PR/CI/bots** in the way — so the runner's reliability is
   > measured in isolation before the FSM, gates, and bot rounds pile on. This is where the phase-2
   > **abort criterion** is actually run: `run_eval.py` reports valid-JobResult rate every run, and
   > **≥9/10 across the two roles** is the go/no-go. It doubles as the control arm for skill
   > self-improvement — the doctor discovers escapes, care-evals verifies fixes with before/after
   > deltas, and its **ladder scorecard feeds [`guides/models.md`](./guides/models.md)**, turning the
   > "judgment = Opus" tier table from doctrine into a per-skill empirical result (cheapest model
   > that passes, human-gated). Standing rule once it exists: _no skill edit lands without an eval
   > delta on the same model-id._

3. **`fsm.py` + `shell.py` half-pipe** — steps 2→3→4a→5 on a scratch branch (no PR): worktree,
   implementer, reviewer, gate, commit. Prove: deterministic control flow over mixed
   agent/helper inputs.
4. **CI round-trip** — 5→5-waiting-ci→6a→6b→5 against a real throwaway PR. Prove: **zero nudges**
   through a full bot round (the IMP-5 kill-shot). **Risk concentration lives here:** bot timing,
   Greptile in-place-edited summaries, reply threading, round convergence — exactly where the
   current system accumulated its IMPs. Budget this phase at roughly the cost of phases 1–3 combined.
5. **`gate.py` + `resume.py`** — full pipeline from `1` with tty gate; then kill -9 the process at
   3 random points and `resume` (the crash-only acceptance test).
6. **Cutover + doctor v2** — care-loop SKILL.md gains "headless mode" as default for full runs
   (editor mode stays for interactive/dev); doctor consumes journals; retire `-ing` markers,
   `write-state.sh`-as-contract, and the IMP-5/8/9 prose rules that code now enforces.

**Effort honesty:** "thin" is ~1.5–3k LOC + tests; solo and part-time, phases 1–5 are **1–3 weeks
of focused work, not days** — and phase 4 will find edge cases this paper doesn't show. The phasing
exists so each step ships value even if later phases slip.

## Acceptance criteria (the failures this must make impossible)

- A full run plan→merged-ready converges with **zero human inputs after plan approval** (checkpoint
  paths excepted, and each checkpoint is journaled with a reason).
- `kill -9` at any point → `resume` completes the run with no double-commit/push/reply/apply.
- No `state.json` in any run was written by anything but `state.py`; journal replay reproduces it
  byte-identically.
- Every judgment JobResult's `model_used` satisfies its pin; violations are spawn failures, not
  footnotes.
- The doctor produces a full diagnosis for a headless run **without touching VS Code storage**.

## 11. Event-driven / cloud (future — designed-for, not built)

The headless local design is one config flip from event-triggered; the loop core never changes. What
gets added _around_ it (all orthogonal to the orchestrator itself):

- **Trigger + Dispatcher** — a webhook (e.g. a Jira ticket assigned to the agent) → a queue → provision
  the worktree, write the initial `state.json` + task one-liner, launch `care-loopd`.
- **Waits become suspend-and-resume-on-event** — instead of blocking in-process on `poll-pr.sh`, the
  loop journals a `ci.wait` checkpoint and exits; a PR/CI webhook fires `care-loopd resume`. This is
  the §7 `checkpoint` gate mechanism generalized (local file → Jira/Slack/webhook); the FSM is identical.
- **Identity flips** — local = push as the user (+ co-author trailer); cloud = a **GitHub App
  installation token** (`care-loop[bot]`, per-repo scope, no seat) with the human added as PR
  assignee/reviewer. Clean split exactly where "push as the user" stops making sense.
- **Autonomy without the editor's per-command prompt** — a headless runtime does not autorun by
  default; the interactive safety net is replaced by: an **ephemeral sandboxed container** (throwaway
  per job), the runner's **allow/deny tool lists** (§4), a **least-privilege token**, and **egress
  limits** (GitHub + npm only). Approval is _relocated_, not abolished: the one plan-gate approval
  authorizes everything downstream (SKILL: "pushing authorized by plan approval").

Not on the critical path — the local headless loop is the milestone; this is the graft point once it works.

## Non-goals (v1)

- No trigger/dispatcher/webhook, no GitHub App identity (§11, later — the checkpoint gate is
  deliberately shaped to become its async gate).
- No parallel 4a/4b/4c fan-out, no multi-run scheduler beyond lockfile + pw-lock.
- No HMAC/signing/compliance ceremony — hash-chain for integrity detection only.
- No Copilot-host parity for headless mode: `agents/copilot/` and hosts.md remain for the editor
  host; headless runs are Agent-SDK-only.
