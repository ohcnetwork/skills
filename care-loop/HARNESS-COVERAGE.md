# Harness coverage — which failure classes care-loop actually regulates

Answers the open question both harness-engineering articles leave (Fowler: *"measuring harness
coverage — analogous to code coverage"*; HumanLayer: *"engineer a solution so it never makes that
mistake again"*). We have **code** coverage (161 orchestrator tests) and **task** coverage
(care-evals, 24 tasks), but until now no measure of **which failure classes a control actually
catches** — so the blind spots stayed implicit.

This file makes them explicit. It's the companion to [HARNESS-ENGINEERING-NOTES.md](./HARNESS-ENGINEERING-NOTES.md)
§C, seeded from every failure the doctor has ever recorded in
[care-loop-doctor/diagnoses/IMPROVEMENTS.md](../care-loop-doctor/diagnoses/IMPROVEMENTS.md) (IMP-1..IMP-15)
and the eight judgment dimensions in [care-loop-doctor/rubric.md](../care-loop-doctor/rubric.md).

## The three sensor types (per Fowler)

- **Computational** — deterministic, ms–s, cheap, reliable. Tests, `validateState`, the FSM,
  `run_gate.sh`, `poll.ts`, JobResult schema validation, gate-enforced model pin.
- **Inferential** — semantic, slow, costly, non-deterministic but richer. LLM-as-judge: the
  `care-review` lenses, `care-test-grade`, `care-ux-review`, `care-triager`, and the doctor itself.
- **Nothing / human** — no control regulates it; caught late (remote CI) or only by a person.

A control is either **feedforward** (a guide that steers *before* the act — ARCHITECTURE.md, skill
sources, acceptance criteria) or **feedback** (a sensor that observes *after*). Both axes matter: a
class caught only by an inferential feedback sensor is regulated *probabilistically*, not reliably.

---

## Coverage table — every failure class the doctor has seen

Legend for **Status**: 🟢 reliably regulated (computational, un-bypassable) · 🟡 regulated
probabilistically (inferential, or computational-but-advisory) · 🔴 blind spot (no control, or the
control is inert / remote-only / after-the-fact).

| # | Failure class | Origin | Regulated by | Type | When it fires | Status |
|---|---|---|---|---|---|---|
| 1 | Judgment step runs on the cheap tier | IMP-1, dim 1 | **planner:** plan-gate abort `plan_wrong_tier` ([plan.ts:90]); **reviewer/triager/grader/ux:** `assertRightTier` throws `WrongTierError` on an explicit `modelPinSatisfied === false` | Computational | each judgment spawn | 🟢 (BS-1 closed 2026-07-17) |
| 2 | Mid-turn death; unsafe resume | IMP-2, dim 2 | journal `run.end` + `run.resume` reconcile; `-ing` markers; torn-tail detect | Computational (feedback) | on resume | 🟢 |
| 3 | `state.json` schema drift | IMP-3, dim 5 | `validateState` — [state.ts] is the sole writer, throws on bad keys/types/step | Computational | every write | 🟢 (structurally closed) |
| 4 | Raw bot feedback instead of the digest | IMP-4, dim 4 | `feedback.ts` collects the digest deterministically | Computational | Step 6a | 🟢 |
| 5 | Hand-polled CI wait; can't self-resume | IMP-5, dim 6 | blocking `poll.ts` (single wait path) | Computational | Step 5 | 🟢 |
| 6 | `npm run build` OOM takes down the host | IMP-6, dim 2 | `run_gate.sh` caps `NODE_OPTIONS=--max-old-space-size=4096` | Computational (feedforward) | gate | 🟢 |
| 7 | Router drops the mechanical contract | IMP-7, dim 4/1 | loopd makes the contract un-bypassable (FSM + `validateState` + `poll.ts`) | Computational | whole loop | 🟢 (was 🔴 pre-loopd, probabilistic per-tier) |
| 8 | In-flight run ignores a mid-run fix | IMP-8, dim 2 | resume re-entry re-reads the current step guide | Computational (feedforward) | round boundary | 🟡 (relies on re-entry discipline) |
| 9 | Un-instrumented run — no run-dir trail | IMP-9, dim 4 | loopd always writes `journal.jsonl` + sidecars | Computational | whole loop | 🟢 |
| 10 | Illegal step order / skipped gate | dim 4 | FSM throws `FsmError` on illegal transitions; `push` requires a preceding `gate-*` exit-0 | Computational | every transition | 🟢 |
| 11 | Skill returns schema-invalid output | dim 5 | `JOBRESULT_SCHEMA` validation → `spawn.invalid` + retry | Computational | every spawn | 🟢 |
| 12 | Bot rounds never converge / cap out | dim 6 | `ci.wait`/`ci.done`, `budget.stop{max_rounds}`, `checkpoint.written` | Computational | Step 6 | 🟢 |
| 13 | **Behaviour: change doesn't do the right thing** | dim 8, care-review | `care-review` lenses + `care-test-grade` **hard gate (4b on by default; `Wrong`→loopback, findings fed back to re-implement)** + escape attribution (bots, after merge) | Inferential (feedback) | Step 4 / 4b / post-push | 🟡 **weakest domain, now gated** (BS-2 closed 2026-07-17) |
| 14 | Escape: a bot caught what our lens missed | dim 8, IMP-15 | `care-triager` → `verdicts.md`; doctor aggregates `class × missed_by` | Inferential (feedback) | Step 6, post-hoc | 🟡 (probabilistic; the steering signal, not prevention) |
| 15 | e2e criteria assert data the fixture can't produce | IMP-10 | **plan-time:** care-planner fixture-realizability rule (feedforward); **backstop:** care-test-grade `Weak` on the un-faithful assert | Inferential (feedforward + feedback) | Step 1 / Step 4b | 🟡 (BS-3 addressed 2026-07-17) |
| 16 | PR title fails the `[ENG-###]` Jira check | IMP-12 | local assertion in `orchestrate.ts` `start()` — regex-guards the title and throws **before** `createPr` ([orchestrate.ts:141]) | Computational (local) | before PR open | 🟢 (BS-4 already closed) |
| 17 | Silent blocking gate → terminal wedge | IMP-13 | **obviated by loopd** — the gate runs as a `spawnSync` subprocess (shell.ts `runHelper`), output teed to a log, `timeoutMs`-bounded; no shared interactive terminal to wedge | Computational (structural) | gate | 🟢 (BS-6 obviated 2026-07-17) |
| 18 | Token/cost economy unmeasurable | IMP-14, dim 3 | `cost_cum.usd_est` from opencode usage → journal + `loop.log` | Computational (observability) | every judgment spawn | 🟡 (maker/CLI cost still unmeasured — see BS-5) |
| 19 | Triager tally-only — dim 8 unsupported | IMP-15 | `verdicts.md` per-item list (`class·verdict·missed_by·severity`) | Computational (observability) | Step 6 | 🟢 |
| 20 | Maintainability: dup code / complexity / drift | Fowler | `care-technical-review` (approach lens) — inferential; no computational structural sensor | Inferential | Step 4 | 🟡 (probabilistic; no lint-for-complexity) |
| 21 | Architecture fitness (perf / observability chars) | Fowler | **nothing** — no fitness functions | — | — | 🔴 (see BS-7) |
| 22 | Harness coherence — contradicting guides/sensors | Fowler open-q, E | **nothing** — no control over ~12 skills' mutual consistency | — | — | 🔴 (see BS-8) |

Rows 1–12 + 18–19 are the **maintainability + process** domain — our strongest, almost entirely
computational and largely closed by loopd. Rows 13–15, 20 are the **behaviour** domain — inferential,
probabilistic, exactly as both articles predict is the weakest. Rows 21–22 are unregulated entirely.

---

## The payoff: blind spots, ranked by leverage-to-effort

Ordered so the cheapest reliable win is first. Each names the control to build and the sensor type it
would add.

### BS-1 · Reviewer/triager model pin computed but never enforced — ✅ CLOSED 2026-07-17
The reviewer/triager/grader/ux wrappers computed `modelPinSatisfied` but only the **planner** gate
acted on it, so a wrong-engine judgment spawn completed silently. **Shipped:** `warnIfWrongTier`
(console-only) became `assertRightTier`, which throws a typed `WrongTierError` on an explicit
`modelPinSatisfied === false` — mirroring the planner's `=== false` semantics (`undefined` =
unverifiable = a local model / test fake, passes). All four judgment wrappers route through the one
helper, so the fire is uniform. The run halts loudly instead of proceeding on the wrong tier; the
journal's `spawn.result.model` already records which engine ran, so the doctor still sees it.
Guarded by `test/tier-enforcement.test.ts` (throws on `false`, passes on `true`/`undefined`).

### BS-2 · `care-test-grade` was advisory, not a gate — ✅ CLOSED 2026-07-17
The weakest domain in both articles. The gate *machinery* already existed —
`LOOPBACK_VERDICTS["care-test-grader"] = ["wrong"]` and the `4b` FSM transitions — and the
`testGrader` port was wired into `roleSpawn`. The gap was that the default review sequence was
`reviewSteps: ["4a"]`, so **4b never ran** on a real run. **Shipped:** the `start()` build phase now
defaults to `["4a","4b"]` (overridable via `StartOptions.buildCfg`), turning test-grade into a hard
gate — a `Wrong` verdict loops back to implement; `Weak`/`Missing` stay advisory (matches the skill's
"blocks only on Wrong" policy); a spec-less diff returns `pass` (no infinite loop). **Also fixed a
latent gap this exposed:** a review/grade loopback previously re-invoked the maker *blind* (findings
were dropped by the `roleSpawn` adapter and never reached `lastImplementContext`), so a gate would
have just burned the retry budget → abort. `SpawnResult` now carries a `findingsDigest` that
`roleSpawn` renders per role and `pipeline.ts` feeds back as re-implement context — a strict
improvement to the already-shipped 4a reviewer gate too. Guarded by a new `pipeline.test.ts` case
(`wrong`→loopback path + findings-in-context assertion).
- **Judge hardened 2026-07-17:** the test-grade eval suite went 2→4 tasks — `tg-03` (a second
  `Wrong`/block flavor: a green assertion on unrelated behavior, distinct from tg-01's buggy-impl
  rubber-stamp) and `tg-04` (a genuine `Weak` that must be caught yet must **not** block, which also
  turns the IMP-10/BS-3 escape into an offline regression guard). Fills two discrimination holes tg-01
  (always blocks) and tg-02 (all-Covered) couldn't: a distinct block trigger, and "catch-but-don't-
  block." All 4 green in mock (plumbing + ground-truth self-consistency).
- **Live ladder run 2026-07-17 (Haiku 3/4, Sonnet 2/4 via Copilot, n=1)** exposed a real gate risk:
  **both tiers over-block tg-04** — a presence-only assert of a value-criterion, ground-truthed
  `Weak`, was graded `Wrong`→block by both. Not a tier gap — a **rubric under-specification** of the
  Weak/Wrong line.
- **Resolved 2026-07-17 (skill-owner decision + fix):** the models were right — **presence-instead-of-
  value is `Wrong`** (the spec verifies nothing the criterion claims → must be rewritten). Shipped:
  (1) sharpened the `care-test-grade` Weak-vs-Wrong rubric (Weak = verifies the claim but thinly;
  Wrong = doesn't verify it — contradicts / unrelated behavior / presence-instead-of-value); (2)
  re-grounded the fixtures — tg-04 `Weak`→`Wrong`/block (IMP-10 guard: fix routes back to the plan),
  tg-01 AC2 redesigned to a genuine thin-but-faithful `Weak`, tg-02 → a **mixed control** (AC1/AC3
  `Covered` precision + AC2 a legitimate `Weak`-not-block, recovering the discrimination case tg-04's
  flip vacated). **Live re-run: Haiku 4/4** — the cheap tier now handles the gate's key case. The
  sharper rubric also correctly surfaced tg-02's thin AC2 that the old rubric let pass (two models
  agreed) — the steering loop working as designed. See care-evals/FINDINGS.md.

### BS-3 · Acceptance criteria not gradeable against the fixture — ✅ ADDRESSED 2026-07-17
IMP-10: the planner could write a criterion (assert the invoice *number*) the local fixture backend
never produces, and nothing caught it until the e2e maker burned 3–4 red spec runs. **Shipped
(prevention, keep-quality-left):** a fixture-realizability rule in the `care-planner` injected
methodology (Phase 3 criteria authoring) — each criterion must be assertable against the local
Playwright DB; never require a server-assigned value the local backend doesn't produce (invoice/order
number, DB id, server timestamp); assert what the fixture can render (the entered value, a computed
field, a label, a state change), with the IMP-10 case as the worked example. **Backstop (already
present):** `care-test-grade`'s *Assertion strength* check + the **Weak** verdict already flag "spec
went green but doesn't assert the criterion as written" (IMP-10's downstream symptom) at Step 4b —
advisory, late, but real. Left at 🟡, not 🟢: the guide rule is feedforward (probabilistic) and the
sensor is inferential + late — no *computational* guarantee exists (detecting "asserts a
server-assigned value" is semantic, not regex-able). A dedicated Step-1.5 realizability sensor is
deliberately **not** built — the class is seen-once (IMP-10), so bias-toward-shipping says wait for a
recurrence. No care-evals guard: the planner isn't a diff-graded skill, so this rule is verified
in-run only.

### BS-4 · Mechanical PR-shape checks are remote-CI-only — ✅ ALREADY CLOSED (found 2026-07-17)
IMP-12: the `[ENG-###]` title shape once failed only on care_fe's remote Jira check. In loopd it's
already guarded locally: `orchestrate.ts` `start()` builds the title as `[${ticket}] ${summary}` and
`throw`s on `!/^\[ENG-\d+\]\s/` **before** `createPr` ([orchestrate.ts:141]) — a malformed title
can't reach GitHub. No new work; the taxonomy pass surfaced an existing computational sensor that
was mis-tagged 🔴. (A bare throw rather than a journaled `run.end`; acceptable for a "shouldn't
happen" invariant, matching the codebase idiom.)

### BS-5 · Maker (CLI implementer) token cost is unmeasured 🟡 · **low, bounded**
Dim 3 coverage note: `opencode run` (the Sonnet maker) reports no usage, so `cost_cum` covers only
the Opus judgment spawns. The true total is understated. **Fix:** capture the CLI implementer's usage
if opencode exposes it, or estimate from wall-clock + model rate. Bounded value — the judgment spawns
are the expensive share already captured; this closes the accounting, not a correctness gap.

### BS-6 · Gate liveness — silence seeds a terminal wedge — ✅ OBVIATED by loopd (verified 2026-07-17)
IMP-13 (pre-loopd): a blocking `run_gate.sh` stage emitted zero bytes for 1–3 min in Copilot's
integrated terminal, read as dead, the model poked it → real wedge. **Verified structurally gone in
loopd:** the gate is invoked by `shell.ts` `runHelper` as a `spawnSync` subprocess — combined output
teed to a log file, a single `(exit, summary)` handed back, a `timeoutMs` wall-clock cap (a hung gate
→ exit 124, not a spin). There is no interactive terminal shared with the model, no partial-line
`printf` the model watches, and no way for the model to "poke" a running gate — the whole IMP-13
mechanism is absent by construction. Closed as obviated (no code); the proposed liveness-line fix
would only matter to the retired fused-runtime loop.

### BS-7 · Architecture-fitness domain is entirely unregulated 🔴 · **larger, deferrable**
Fowler names perf/observability fitness functions; care-loop has none. No control asserts the change
didn't regress a render budget, bundle size, or an observability characteristic. **Fix:** a fitness
function or two (bundle-size delta on build; a Playwright perf assertion on a hot route) — but only
if a real regression of this class ever appears. Bias-toward-shipping says **don't build it
speculatively**; log it here so the blind spot is visible, and let the doctor open it when a run
actually escapes a perf regression.

### BS-8 · No control over harness coherence as it grows 🔴 · **process, deferrable**
Fowler's open question, now real at ~12 skills: nothing catches two SKILL.md files giving
contradicting guidance, or conflicting sensor signals. **Fix (direction E):** a periodic "consolidate
the harness" pass over the skill sources — analogous to the existing `consolidate-memory` skill.
Could itself be a skill. Deferrable until a contradiction actually bites, but named so it's not a
surprise.

---

## How to keep this file honest

This is a living artifact, maintained by the same steering loop as IMPROVEMENTS.md:

1. **Every new doctor finding** gets a row here, tagged with its sensor type and status — not just an
   IMP entry. A finding with no regulating control is a 🔴 row by definition.
2. **When a fix ships**, flip the row's status (🔴→🟢 for a new computational sensor, 🔴→🟡 for an
   inferential one) and note the control in the "Regulated by" column.
3. **The blind-spot list is the backlog.** Work it top-down (leverage-to-effort). A 🔴 that recurs
   across runs without a fix is the signal to invest; a 🔴 that never recurs is fine to leave — the
   article's bias-toward-shipping applies to the harness itself.

**Coverage metric.** First cut (2026-07-17): 🟢 13 · 🟡 5 · 🔴 4 live (BS-1/3/4/6). After the
2026-07-17 blind-spot pass — BS-1 closed (row 1 🟡→🟢), BS-2 gated (row 13 🔴→🟡), BS-3 addressed
(row 15 🔴→🟡), BS-4 found already-closed (row 16 🔴→🟢), BS-6 obviated by loopd (row 17 🔴→🟢): now
**🟢 14 · 🟡 6 · 🔴 2 — and both remaining 🔴 are BS-7/8, named-but-speculative** (architecture-fitness
+ harness-coherence), deferred by bias-toward-shipping until a run actually escapes one. **No
actionable red blind spots remain.** Read as: the **maintainability + process** domain is ~fully
regulated and computational; the **behaviour** domain now has real gating back-pressure (still
inferential underneath — the deliberate weak point); **architecture fitness** is unregulated by
choice, not oversight.
