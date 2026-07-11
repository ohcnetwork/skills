# IMPROVEMENTS — standing backlog (care-loop-doctor memory)

Deduped, fingerprinted findings across diagnoses. Re-observations bump `seen:`, never duplicate.
`applied` entries that recur are regressions — flag in the report and reopen here.

## IMP-1 · Judgment steps inherit the session model (Sonnet plans/reviews)
status: applied (2026-07-11)
first-seen: 2026-07-11 · seen: 2 · dimension: 1 (model-tier)
evidence: 2026-07-11-seed.md (sessions 676b5e29, 47e67a5c)
proposed edit: named care-* agents with Opus frontmatter (care-loop/agents/) + SKILL.md
"Model enforcement" router-does-no-judgment + `planned-by:` attestation — shipped; positive
control in the re-run baseline. Watch for regression: any judgment turn on Sonnet post-2026-07-11.

## IMP-2 · Mid-turn session death leaves a stale anchor; resume is unsafe
status: applied (2026-07-11)
first-seen: 2026-07-11 · seen: 1 · dimension: 2 (termination/resume)
evidence: 2026-07-11-seed.md (session 7c1e26b1)
proposed edit: 00-resume.md reconcile + resume-probe.sh + `-ing` state markers + per-step
idempotency guards — shipped. Watch: a resumed run that re-triages already-applied work.

## IMP-3 · state.json schema drift (every run so far, including post-fix)
status: applied (2026-07-11) — VALIDATED 2026-07-11 (first fully-compliant state.json observed)
first-seen: 2026-07-11 · seen: 4 · dimension: 5 (schema)
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
