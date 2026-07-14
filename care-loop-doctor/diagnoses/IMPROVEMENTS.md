# IMPROVEMENTS — standing backlog (care-loop-doctor memory)

Deduped, fingerprinted findings across diagnoses. Re-observations bump `seen:`, never duplicate.
`applied` entries that recur are regressions — flag in the report and reopen here.

**escape → fixture discipline:** a finding that is a _skill_ miss/false-positive (a review that
missed a real defect, a test-grade that rubber-stamped) is also a `care-evals` fixture candidate —
reproduce it there as a ground-truth task so the regression is caught offline forever, and use the
suite's before/after delta to verify the skill edit that closes it. Backlog entries whose fix is a
skill-prompt change should note the eval task that guards it.

## IMP-1 · Judgment steps inherit the session model (Sonnet plans/reviews)

status: applied (2026-07-11)
first-seen: 2026-07-11 · seen: 2 · dimension: 1 (model-tier)
evidence: 2026-07-11-seed.md (sessions 676b5e29, 47e67a5c)
proposed edit: named care-\* agents with Opus frontmatter (care-loop/agents/) + SKILL.md
"Model enforcement" router-does-no-judgment + `planned-by:` attestation — shipped; positive
control in the re-run baseline. Watch for regression: any judgment turn on Sonnet post-2026-07-11.

## IMP-2 · Mid-turn session death leaves a stale anchor; resume is unsafe

status: applied (2026-07-11)
first-seen: 2026-07-11 · seen: 1 · dimension: 2 (termination/resume)
evidence: 2026-07-11-seed.md (session 7c1e26b1)
proposed edit: 00-resume.md reconcile + resume-probe.sh + `-ing` state markers + per-step
idempotency guards — shipped. Watch: a resumed run that re-triages already-applied work.

## IMP-3 · state.json schema drift (every run so far, including post-fix)

status: applied (2026-07-11) — VALIDATED 2026-07-11, **REGRESSED 2026-07-12 (host-conditional)**
first-seen: 2026-07-11 · seen: 5 · dimension: 5 (schema)
evidence: 2026-07-11-seed.md (both ENG-648 runs' state.json; drift survived the shipped wording);
2026-07-11-a946988c.md (write-state.sh shipped `-rw-r--r--`, the only non-`+x` script);
2026-07-11-a946988c-b.md (ENG-642 wrote state via write-state.sh ×128 → first-ever exactly-compliant
state.json: owner/name repo, integer pr, in-vocab step, no ad-hoc keys — the chmod follow-up worked)
applied edit: bundled `care-loop/write-state.sh` (validates keys/types/step vocabulary, carries
fields forward, atomic write) is now the ONLY documented write path — observability.md manifest +
schema section and SKILL.md's bracket-side-effects rule all point at it. Watch for regression:
any state.json with ad-hoc keys / URL pr / unknown step after this date means the orchestrator
bypassed the script.
follow-up edit (applied 2026-07-11): `chmod +x care-loop/write-state.sh` — it had shipped
non-executable, so the `./write-state.sh` invocation in the guides would fail with permission
denied. Now `-rwxr-xr-x` like the other seven scripts.
REGRESSION (2026-07-12-eng729-559.md): ENG-559 wrote a hand-authored state.json that bypassed
write-state.sh: `pr` as a URL + ad-hoc `pr_number` + placeholder `updated_at:"…T00:00:00Z"` + no
`head_sha`, and left NO run-dir logs (see IMP-9). **ROUTER-CONDITIONAL, not host-conditional**
(first-pass "non-VS-Code host" was a gather error — see IMP-11): both runs were in VS Code, concurrent.
Under the _same_ mid-run crash the divergence tracked the router tier — Opus router (ENG-729):
write-state ×97, run_gate ×238, compliant state + full trail; Sonnet router (ENG-559): write-state
×3, run_gate ×2, hand-managed `pr_number` ×8 → drifted + un-instrumented. The cheap router drops the
mechanical contract (see reopened IMP-7). Fix HOLDS where the contract is followed (Opus).
root: two levers — (a) 05-gate-push.md's "open the PR" block ends at `gh pr create` and never routes
the transition through `write-state.sh -s 5 -p <int>`, so the URL is recorded verbatim; (b) the cheap
router is less reliable at self-disciplining to the script.
proposed edit (NOT yet applied): 05-gate-push.md — after `gh pr create`, capture the **integer** PR
number and immediately `write-state.sh -s 5 -p <PR_NUMBER>` (integer only; never a URL / ad-hoc key).
REGRESSION #2 (2026-07-13-eng648-729.md): ENG-648 (Sonnet router) drifted state AGAIN at the exact
Step-5 transition the pending edit targets — `repo:"care_fe"` (not owner/name), `pr` a **URL** +
ad-hoc `pr_number:16547`, `step:"5-waiting-ci"` (not in vocabulary; canonical `5-await`), and NO
`head_sha`/`last_reviewed_sha`/`updated_at` (write-state ×4 but `pr_number ×6` hand-managed). The
concurrent ENG-729 on the _same_ Sonnet tier wrote a fully compliant state via write-state ×11 — so
drift is variable within-tier (see IMP-7), and the pending 05-gate-push edit + a hard post-create
assertion (integer `pr`, no `pr_number`, in-vocab step, fresh `updated_at`) is now doubly warranted.
seen: 6.

## IMP-4 · 6a fetches raw bot feedback instead of the digest; feedback rounds ran inline

status: applied (2026-07-11)
first-seen: 2026-07-11 · seen: 1 · dimension: 3/4 (token + pipeline)
evidence: 2026-07-11-seed.md (session 7c1e26b1, session-3 turns)
applied edit: 06a-triage.md now explicitly forbids `gh pr view --json reviews` /
`gh api …/pulls/<n>/comments` — collect-feedback.sh first. (Inline-judgment half was already
structurally covered by IMP-1's router rule + named `care-triager` agent.)

## IMP-5 · CI/bot wait hand-polled instead of poll-pr.sh; loop can't self-resume

status: applied (2026-07-11)
first-seen: 2026-07-11 · seen: 1 · dimension: 4/6 (pipeline + bot-round)
evidence: 2026-07-11-a946988c.md (session 7161dfe9: poll-pr.sh=0, `gh pr checks`=8; user forced to
nudge "status?" / "status check?" / "Is the loop not working?"; state stuck at 5-waiting-ci while
CI was already green)
applied edit: 05-gate-push.md "Wait for bots + CI" now carries a hard rule — `poll-pr.sh` is the
ONLY CI/bot wait; never `gh pr checks`/`gh pr view` to poll; re-invoke on timeout (no hand-poll
fallback); the instant it exits 0, proceed straight to Step 6a without waiting for a prompt.
seen: 2 (2026-07-11-a946988c-b.md). Status nuance: **applied but not yet positively controlled** —
the only post-fix ENG-648 evidence (7161dfe9) is an in-flight run still hand-polling (`gh pr checks`
×51, poll-pr.sh ×0, stuck at 5-waiting-ci); ENG-642 IS the CI-wait positive control (poll-pr.sh ×50,
self-resumed to SUCCESS) but still carried 8× residual `gh pr checks`. Watch: a FRESH run must show
poll-pr.sh-only; reopen if `gh pr checks` reappears as an actual poll loop (not a one-shot check).
seen: 4 (2026-07-13-eng648-729.md) — split result on a fresh batch: ENG-729 is a clean positive
control (`poll-pr.sh ×99`, `gh pr checks ×19` non-loop), but ENG-648 REGRESSED to a hand-poll
(`poll-pr.sh ×1`, `gh pr checks ×10`) — same Sonnet-router non-adherence as IMP-3/IMP-7. The fix
holds only on the disciplined path; reinforced by IMP-7's within-tier variance framing.

## IMP-6 · Bare `npm run build` in the integrated terminal OOM-crashes VS Code

status: applied (2026-07-11)
first-seen: 2026-07-11 · seen: 1 · dimension: 2 (termination / host safety)
evidence: 2026-07-11-a946988c.md (session a946988c: `npm run build > /tmp/…` → "The terminal has
been cleaned up", exit 130, reLoad ×2; run-dir gate/ empty; run stuck at 4-review after)
applied edit: run_gate.sh now exports `NODE_OPTIONS=--max-old-space-size=4096` (matching care_fe's
Docker build) before the build stage so node's heap can't balloon and take the host down;
05-gate-push.md + 03-implement.md + hosts.md now state the build runs ONLY through `run_gate.sh`,
never a bare `npm run build` in the integrated terminal.

## IMP-7 · Orchestrator/router model not pinned to the cheap tier

status: declined (2026-07-11 — user; router-on-Opus is cost-only, not a tier violation)
first-seen: 2026-07-11 · seen: 1 · dimension: 3/1 (token + model-tier)
evidence: 2026-07-11-a946988c.md (ENG-642 router all Opus, 71 calls / 673 tool invocations inline;
ENG-648 router on Sonnet — both correctly spawn Opus judgment agents, so this is cost, not a tier
violation)
proposed edit (not applied): models.md/SKILL.md — state the orchestrator SHOULD run on the cheap
tier. Not re-proposed without materially new evidence (e.g. router-on-Opus cost becoming a
recurring, quantified problem).
seen: 2 (2026-07-11-a946988c-b.md) — now quantified: ENG-642 router-on-Opus did **951 mechanical
tool invocations** on the expensive tier for one loop (vs ENG-648's Sonnet router, 532). Surfaced,
still declined; reopen only if this becomes a recurring budget problem.

**REOPENED 2026-07-12 (2026-07-12-eng729-559.md) — new evidence flips the framing.** The decline
rested on "router-on-Opus is cost-only." The concurrent ENG-729/ENG-559 A/B shows the cheap router
has a **correctness cost**, not just Opus a dollar cost: the Sonnet router (ENG-559) dropped the
mechanical contract — write-state ×3 (vs Opus ×97), run_gate ×2 (vs 238), hand-managed `pr_number`
×8 → drifted state + no run-dir trail; the Opus router (ENG-729, 827 invocations) executed it
faithfully and recovered cleanly from the same crash. So the trade-off is "Opus router = costly but
disciplined / Sonnet router = cheap but drifts state & observability," not "both fine."
seen: 3 · dimension now 3/1/5 (token + tier + schema-adherence).
proposed edit (NOT yet applied): models.md / SKILL.md — state that the **router tier affects contract
adherence**; if run on the cheap tier, every state write MUST go through `write-state.sh` and every
gate through `run_gate.sh`. Prefer the disciplined tier for the router until the drift is closed, OR
add a hard post-step assertion that state.json is script-shaped (integer `pr`, no ad-hoc keys, fresh
`updated_at`) and fail loudly otherwise.
seen: 4 (2026-07-13-eng648-729.md) — **within-tier variance sharpens the framing.** This batch ran
BOTH loops on the Sonnet router, yet ENG-729 was fully disciplined (compliant state, poll-pr ×99,
run_gate ×53) while ENG-648 drifted (URL pr + pr_number, hand-poll). So cheap-router drift is
**probabilistic, not deterministic** — a tier preference wouldn't have saved ENG-648 reliably. This
tips the recommendation toward the **hard post-step assertion** arm of the proposed edit (make the
contract un-bypassable) over "prefer the disciplined tier."

## IMP-8 · In-flight runs don't adopt care-loop fixes shipped mid-run

status: applied (2026-07-11)
first-seen: 2026-07-11 · seen: 2 · dimension: 2/4 (termination + pipeline)
evidence: 2026-07-11-a946988c-b.md (ENG-648 session 7161dfe9 ran 14:16→18:14 across the poll-pr.sh /
write-state.sh ship, never adopted them — `gh pr checks` ×51, poll-pr.sh ×0, write-state ×2, stuck at
5-waiting-ci ~4h with pre-fix drifted state.json); prior write-offs in 2026-07-11-seed.md +
2026-07-11-a946988c.md (ENG-642 round-1 was the first instance, dismissed as "authored mid-run").
applied edit: working-agreement.md new section "Mid-run skill changes — a running session keeps the
old contract": re-read the step guide at each round boundary; if a needed helper postdates the run,
prefer 00-resume.md re-entry in a fresh session over limping. Watch for regression: any future run
that keeps hand-polling / hand-writing state after a fix shipped.

## IMP-9 · Un-instrumented run — no run-dir trail (loop.log/agents/gate)

status: open
first-seen: 2026-07-12 · seen: 1 · dimension: 4/2 (pipeline + observability/termination)
evidence: 2026-07-12-eng729-559.md (ENG-559 / Sonnet router reached PR #16543 @ 5-waiting-ci but its
run dir holds only the 5 planner artifacts + a drifted state.json — no `loop.log`, `gate/`, or
`agents/`; unresumable-by-anchor, undiagnosable). **Root is the same cheap-router non-adherence as the
IMP-3 regression + a mid-run VS Code crash** (both concurrent loops resumed via resume-probe; Opus
recovered clean, Sonnet recovered drifted) — NOT a non-VS-Code host (first-pass error, see IMP-11).
Contrast ENG-729's complete trail the same evening.
proposed edit: hosts.md — (a) a host-agnostic invariant: every host writes the run-dir trail
(`loop.log` + `agents/<name>.log` + `gate/*.log`) and state ONLY via `write-state.sh`; a run with no
run-dir instrumentation must be treated as abandoned. (b) caution against running **two loops
concurrently in one VS Code window** — combined build + Playwright memory pressure can OOM the host
(the IMP-6 mechanism at 2×; this batch's crash). observability.md implies (a) in prose; hosts.md
should make both per-host requirements.

## IMP-11 · care-loop-doctor gather scopes Tier-A to the wrong workspace

status: applied (2026-07-12, user-directed "improve doctor loop")
first-seen: 2026-07-12 · seen: 1 · dimension: process (the doctor's own workflow)
evidence: 2026-07-12-eng729-559.md F0 — first pass ran `find-sessions.sh` with no `-r`, defaulting to
the cwd git basename (`skills`), which scanned only the skills-development workspace and MISSED both
loop-driving sessions (they live in the `Desktop/care_fe` workspace `5063bb…`). Produced a wrong
"unpaired / non-VS-Code host" diagnosis with a mis-attributed root cause until re-run with `-r care_fe`.
applied edit: SKILL.md step 1 (Gather) now mandates `find-sessions.sh -r care_fe` with an explicit
warning that the cwd default scopes to the wrong workspace. Applied alongside two sibling doctor
improvements from the same session (not separate IMPs, recorded here):
(1) `digest-session.py` Tier-A digests now emit **marker counts** (helper-script adherence, drift
signals, agent spawns, crash strings) and **silence gaps ≥10 min** — the two analyses previously
hand-rolled ad hoc every doctor run; verified against sessions 65bae31a/3e10e975 (reproduces the
write-state ×89-vs-×3 contrast, pr_number ×8 drift, and the 60-min crash gap in one call).
(2) SKILL.md gains **Tier J** (`journal.jsonl` + `agents/*.result.json`, PLAN-orchestrator-architecture
§5): outranks A/B when present; dims 1/3/4/5 become exact journal reads; chat sessions demote to an
honesty spot-check. Structural retirement of this whole failure class arrives with care-loopd
(doctor v2, architecture §10 phase 6).

## IMP-10 · e2e acceptance criteria assert data the local fixture can't produce

status: open
first-seen: 2026-07-12 · seen: 1 · dimension: 1 (planning/criteria quality)
evidence: 2026-07-12-eng729-559.md (ENG-729 AC11 required asserting the invoice **number**, but the
local fixture backend assigns none — spec L21; the e2e maker burned 3 red spec runs (SPEC 143 /
SPEC2 1 / SPEC3 1) before landing a "number-independent" green (SPEC4) that no longer meets AC11 as
written — a criteria↔fixture mismatch for 4b to reconcile).
proposed edit: 01-plan.md (criteria authoring) — e2e acceptance criteria must be gradeable against
the actual test fixture; don't require asserting server-assigned values the local fixture backend
doesn't produce (e.g. invoice numbers). Assert structural/rendered content instead.

## IMP-12 · PR title uses conventional-commit form, fails the `[ENG-###]` Jira CI check

status: open
first-seen: 2026-07-13 · seen: 1 · dimension: 8/4 (escape + pipeline)
evidence: 2026-07-13-eng648-729.md F1 (ENG-648 pushed `gh pr create --title "feat(ENG-648): add
GenericAutocomplete<T> with radio mode"` → red on care_fe's newly-added Jira PR-title check, which
requires a `[ENG-###]`-shaped title). The guide ALREADY specifies the bracket form
(05-gate-push.md L26 + L34 `[ENG-707] <summary>`), so this is guide-followed-loosely: a strong
conventional-commit prior overrode one buried line and nothing local asserts the shape, so it only
failed remotely. Same step also used inline `--body` instead of `--body-file pr-body.md` + native
PR tool (hosts.md), and left no `pr-body.md` in the run dir.
proposed edit: 05-gate-push.md — promote the title rule to a loud REQUIRED line with regex
`^\[ENG-[0-9]+\] ` + a _wrong_ example (`feat(ENG-648): …` ✗), noting care_fe's Jira CI rejects
anything else; add a one-line post-create assertion (grep the created title against the regex, fail
loudly) so the shape is caught locally, not by red CI. Mechanical contract miss — guard by assertion,
not a care-evals fixture.

## IMP-13 · Long silent gate seeds a real terminal wedge when the model pokes a busy terminal

status: open
first-seen: 2026-07-13 · seen: 1 · dimension: 2 (termination / host safety)
evidence: 2026-07-13-eng648-729.md F3 (ENG-729, the _disciplined_ run). This was a GENUINE wedge, not
cosmetic slowness: _"All terminals seem to be in a weird state… there's a previous command from
run_gate.sh still running (lint)… the output 'nt-invoi' is the end of a previous truncated output"_ →
the model had to _"kill the stuck terminal."_ Two-stage cause: (1) `run_gate.sh`'s `stage()` prints the
stage name with a partial-line `printf '…%-18s '` (no newline) then blocks 1–3 min on a command whose
output goes to a log, so the terminal emits zero bytes and looks dead; (2) control returned to the
model while the gate was STILL running (gate ×53, mostly sync — `isBackground:false` ×168 — so a long
sync gate outran the tool's patience and handed control back), and instead of waiting the model issued
fresh commands into the occupied terminal + opened new ones, which wedged VS Code's shell integration
for real (stale/truncated cross-terminal output). Killing the wedged terminal orphans the running
gate (build/Playwright) and can drop the pw-lock. Silence SEEDS it; poking a busy terminal IS the
wedge. Orthogonal to router discipline (hit the well-behaved run).
proposed edit: (a) run_gate.sh — emit a newline-terminated "→ <stage> running… (~Nm, output → <log>)"
line BEFORE each blocking stage + a separate PASS/FAIL line after, so silence ≠ suspicion; (b) hosts.md
/ working-agreement.md — run the gate as ONE dedicated call and WAIT; never issue another command into
a terminal running the gate, and never open a second terminal to "check" it (that is what wedges shell
integration). If backgrounded, poll ONLY via that same terminal's output, never a parallel command. A
wedged terminal killed = the gate is dead — re-run it cleanly rather than poking.

---

# loopd era (2026-07-14+) — findings against the headless orchestrator

IMP-1..IMP-13 above are **pre-loopd** (the old fused-runtime loop). Many are structurally obviated by
loopd — IMP-3 (state drift) → `validateState` can't drift; IMP-5 (hand-poll) → blocking `poll.ts`;
IMP-1 (model tier) → gate-enforced pin. **Do not re-propose their edits against deleted guides.**
New findings target `orchestrator/src`, the methodology regions, the lens skills, or `models.json`.

## IMP-14 · loopd drops opencode usage — token/cost economy (dim 3) unmeasurable

status: applied (2026-07-14)
first-seen: 2026-07-14 · seen: 0 (raised by the doctor v2 rework) · dimension: 3 (token economy)
evidence: PLAN-doctor-v2.md Gap A — `journal.ts` plumbs `cost_cum` and `render.ts` renders it, but no
producer sets it; the `skills-opencode.ts` spawns discard opencode's per-response usage.
proposed edit (**loopd — propose-only, needs `npm test`**): capture opencode's usage in
`orchestrator/src/opencode-runner.ts` and accumulate into the journal `cost_cum.usd_est`, so rubric
dim 3 becomes an exact read. The journal + render plumbing already exists — only the producer is
missing.
applied edit (2026-07-14): `opencode-runner.ts` extracts `info.cost`/`info.tokens` into a `SpawnCost`,
threaded through reviewer/planner/triager `SkillResult.cost`; `skill-log.ts` stamps cumulative
`cost_cum.usd_est` on each `skill.result` (read from the journal tail so it's correct across the plan+
build loggers) plus a per-call `cost_usd`; `render.ts` shows a `($X.XX)` suffix. Covers the judgment
(Opus) spawns; the CLI implementer reports no usage (noted in rubric dim 3). Dim 3 promoted to exact.

## IMP-15 · loopd triager is tally-only — no verdict list (dim 8 unsupported + dangling 6b read)

status: applied (2026-07-14)
first-seen: 2026-07-14 · seen: 0 (raised by the doctor v2 rework) · dimension: 8 (escape attribution) / 4 (pipeline)
evidence: PLAN-doctor-v2.md Gap B — `opencodeTriager` returns `{addressCount, declineCount, deferCount}`
and writes nothing; `default-wiring.ts:111` tells 6b's implementer to "address the items in
verdicts.md" — a file **nothing writes** (dangling read); no `addressed.md`/`missed_by` anywhere.
proposed edit (**loopd — propose-only, needs `npm test`**): extend the triager to emit a structured
verdict list — per item `{class, verdict (address/decline/defer), missed_by, reason}` — written to
`<run-dir>/verdicts.md`. One change, two payoffs: (i) 6b applies from a real verdict list instead of
raw `feedback.md`; (ii) restores rubric dim 8 (read `verdicts.md` across runs for the
`class × missed_by` escape pattern).
applied edit (2026-07-14): the triage schema now returns `items[]` (each `{class, verdict, missed_by,
reason, source}`); tallies are derived from it; `ci-round.ts` writes `<run-dir>/verdicts.md` via
`renderVerdicts` (new `verdicts.ts`); `orchestrate.ts` threads `items` through `reduceTriage`; 6b's
implementer now reads `verdicts.md` (the dangling read is fixed). Dim 8 promoted to exact.
