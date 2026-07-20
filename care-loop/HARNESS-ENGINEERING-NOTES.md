# Harness Engineering — notes & directions for care-loop

Summary of two pieces, then a map onto what we already have and where to push next.

- HumanLayer, *Skill Issue: Harness Engineering for Coding Agents* — the practitioner's "configure the runtime, don't wait for the model" view.
- Martin Fowler / Birgitta Böckeler et al., *Harness Engineering* — the control-theory framing (feedforward/feedback, sensors/guides, Ashby's Law).

---

## Part 1 — The two theses

### HumanLayer: "it's a configuration problem, not a model problem"
Harness engineering = leveraging the agent's configuration points to raise output quality/reliability, instead of waiting for a better model. Hashimoto's rule: when the agent makes a mistake, *engineer a solution so it never makes that mistake again.*

Components and how to treat them:
- **CLAUDE.md / AGENTS.md** — concise, universally-applicable, <~60 lines, progressive disclosure. Human-crafted, not auto-generated. Respect the "instruction budget."
- **MCP servers / tools** — extend beyond file I/O + bash; too many degrade performance (disable unused). For common CLIs (gh, docker) direct use often beats an MCP wrapper. *Never connect to one you don't trust* (prompt injection).
- **Skills** — progressive disclosure: instructions loaded only when needed; bundle related markdown + CLIs in the skill dir. Security: "treat skills like `npm install random-package`."
- **Sub-agents** — the value is **context isolation**, not role-play. Prevents "context rot" (models degrade at long context, esp. low-similarity distractors). Cheap models for leaves, expensive model for the orchestrator.
- **Hooks** — deterministic control flow at lifecycle/tool events. Canonical use: surface typecheck/build failures *before* the agent finishes, forcing remediation.

**Back-pressure is the highest-leverage lever.** Typecheck / unit / coverage / UI checks — but make verification **context-efficient**: surface only errors, keep success silent. Don't flood context with passing-test output.

Anti-patterns: designing the harness upfront before real failures; installing skills/MCPs "just in case"; running the full suite after every change; micro-optimizing sub-agent tool access; magic prompts. **Bias toward shipping** — only invest in harness where it demonstrably ships more good code faster; throw away config that doesn't help.

### Fowler: the control-systems framing
A harness is **"everything in an AI agent except the model itself."** Agents are non-deterministic, contextually blind, and "think in tokens." The harness raises the probability of a good first attempt and lets the agent self-correct before human review — cutting review toil.

**Two control types (need both):**
- **Guides = feedforward** — steer *before* the agent acts (architecture docs, conventions, bootstrap scripts, codemods).
- **Sensors = feedback** — observe *after* it acts, enable self-correction (tests, linters, type checkers, AI review).
- Feedback-only → repeats the same mistakes. Feedforward-only → encodes rules but never learns if they worked.

**Two execution kinds:**
- **Computational** — deterministic, ms–s, cheap, reliable (tests, linters, types, structural analysis).
- **Inferential** — semantic, slow, costly, non-deterministic but richer (LLM-as-judge, AI review).

**Three regulation domains:**
- **Maintainability** — best developed; computational sensors catch structure (dup code, complexity, coverage, drift) reliably. Higher-impact issues (misdiagnosis, overengineering) only caught *probabilistically* by LLM sensors — not yet reliable enough to reduce supervision.
- **Architecture fitness** — fitness functions for perf/observability characteristics.
- **Behaviour** — weakest. "Spec as feedforward + is the AI-generated test suite green as feedback" puts too much faith in AI-written tests. The **approved-fixtures** pattern shows promise, used selectively.

Other load-bearing ideas:
- **Keep quality left** — distribute checks by cost/speed: fast lint+tests+basic review pre-integration; mutation/broad review post-integration; drift/dep/SLO monitoring continuously.
- **Ambient affordances / harnessability** — the environment's structural legibility determines which sensors you *can* build (strong types → type sensors; clear module boundaries → arch rules). Cruel corollary: **"the harness is most needed where it is hardest to build"** (legacy/tech-debt).
- **Harness templates + Ashby's Law** — a regulator needs at least as much variety as the system it governs; committing to a topology (stack/conventions) narrows the space and makes a comprehensive harness achievable. Ship reusable "guides+sensors" bundles per topology.
- **The steering loop** — when an issue recurs, improve the feedforward/feedback controls so it's less probable next time. AI can help build the controls (write tests, draft rules, scaffold linters/guides).
- **Human role** — direct human input to where it matters most, not eliminate it.

Open questions the article leaves: keeping a growing harness *coherent* (non-contradicting guides/sensors); agents making trade-offs when signals conflict; measuring **harness coverage** (analogous to code coverage); managing scattered controls as a system.

---

## Part 2 — Map onto care-loop (what we already have)

| Concept | Our instance | State |
|---|---|---|
| Feedforward guides | `SKILL.md` per skill + skill-sourcing (named-region injection), ARCHITECTURE.md | Strong |
| Computational sensors | 161 orchestrator tests; CI re-gate in `care-ci-fix`; Playwright affected-spec gate | Strong |
| Inferential sensors | care-review lens agents, care-test-grade, care-triager, care-ux-review, LLM-judge (layer 2 in evals) | Present |
| Context isolation / sub-agents | `forkedFanOut` (session.fork, cache-inheriting), triager fan-out, lens sub-agents | Present |
| Deterministic back-pressure | `preflight.sh`, `run_gate.sh`, `pw-lock.sh`, typecheck | Present |
| The steering loop | **doctor (discovery) → evals (control arm) → SKILL.md harden → re-run** | This *is* our loop |
| "no edit without a delta" | care-evals standing rule (before/after benchmark.md, same model-id) | Codified |
| Model ladder | free → Haiku → Sonnet → Opus per-skill; models.json gate | Built |

We are unusually far along on the *steering loop* itself — the doctor + evals split is exactly the "recurring issue → harden the control → verify offline forever" cycle both articles arrive at. The escape→fixture discipline (a live doctor miss becomes an offline eval task) is our answer to "keep quality left."

---

## Part 3 — Directions worth exploring

Ordered by leverage-to-effort as I read it. None require model upgrades.

### A. Close the two named gaps in our behaviour/maintainability harness
1. **~~Wire deterministic grading for `care-ux-review`~~ — DONE 2026-07-17.** The grader was *already*
   wired (routes through `_grade_care_review`; signal-based recall + FP over `must_flag`/`must_not_flag`,
   clean-control handling) and discriminating — verified: a blank output fails ux-01 (recall 0, critical
   miss); a false-positive output fails the ux-05 clean control. The apparent gap was a **rendering bug**
   in `aggregate.py` (per-task summary branched on the literal skill name `"care-review"`, so ux fell
   through to `acc None · block None`). Fixed by keying the summary on `detail.outcome`
   (`findings`/`clean`) instead of skill name; ux now renders `recall/fp` like care-review. Stale
   `care-evals/SKILL.md` copy (ux grading listed as a v1.5 non-goal, ux missing from the evaluated-skills
   table) corrected.
   - **Coverage extended 2026-07-17: tablet-band gap probes** — `ux-06` (KPI stat-row overflow) and
     `ux-07` (header action-bar sibling collision) both render fine at mobile *and* desktop but break
     only in the **md band (768–1023)**, plus `ux-08` a clean tablet control. Their signals deliberately
     **exclude generic "overflow"/"fixed width"** so a review only scores by naming the middle-breakpoint
     breakage — verified tight (a generic-overflow review fails ux-06). This targets a real rubric gap:
     `care-ux-review`'s *static* mode drills the 320/375 small end + desktop; the 768–1023 band is only
     exercised by *live* mode's 768×1024 viewport, which the eval doesn't run.
   - **Coverage extended 2026-07-17: nested-scroll gap probe** — `ux-09` (a `Sheet` with a
     scroller-inside-a-scroller where the flexbox **`min-h-0`** trap makes *both* `overflow-y-auto`
     regions non-functional) + `ux-10` clean control. Signals exclude the generic "add overflow" so a
     review only scores by naming the declared-but-dead scroller / missing `min-h-0` (verified tight).
     Another real gap: the rubric lists the horizontal `min-w-0` idiom but not the vertical
     `min-h-0`/nested-scroll analog. Generalizes to "overflow declared but non-functional → revisit the
     component design." Suite now **24 tasks (10 ux)**.
   - **Remaining, if wanted:** a live-model ladder rung for ux to confirm discrimination on a real model
     (synthetic bad-output probes already confirm the grader itself). **Watch ux-06/07 specifically** —
     if a real model misses them, that's the steering-loop signal to harden the static rubric to check
     the tablet band explicitly.
2. **Behaviour harness = our weakest, exactly as the article predicts.** We lean on `care-test-grade` (maker/checker on AI tests) — that's the "approved-fixtures used selectively" pattern. Push it: add more seeded green-but-wrong specs; make test-grade a hard Step-4.5 gate, not advisory.

### B. Context-efficiency audit of our sensors (HumanLayer's silent-success rule)
Go through the loop's tool outputs and enforce **errors-only surfacing**: passing tests, clean typecheck, green Playwright runs should emit ~nothing into the agent's context; only failures should. This is cheap and directly fights context rot in long runs. Candidate: an assert on journal/skill sidecar verbosity.

### C. Harness-coverage metric (the article's explicit open question) — BUILT 2026-07-17
We have *code* coverage via tests and *task* coverage via evals — but no measure of **which failure classes the harness actually regulates.** **Built:** [HARNESS-COVERAGE.md](./HARNESS-COVERAGE.md) — a taxonomy of all 22 failure classes the doctor has ever seen (seeded from IMP-1..IMP-15 + the 8 rubric dims), each tagged computational / inferential / nothing and 🟢/🟡/🔴. The payoff is a ranked blind-spot list (BS-1..BS-8). First-cut metric: 🟢 13 · 🟡 5 · 🔴 4 live. Read: maintainability+process ~fully computational; **behaviour regulated only probabilistically (the deliberate weak point)**; architecture-fitness unregulated by choice. Top actionable blind spots it surfaces: **BS-1** (reviewer/triager model pin computed but inert — cheapest 🔴→🟢) and **BS-2** (= direction A.2 below: `care-test-grade` is advisory, not a gate — highest value).

### D. Harness templates (Ashby's Law, applied to CARE)
Everything is pinned to one topology already — `care_fe`, its stack, its conventions. That's the article's "commit to a topology to make a comprehensive harness achievable." Worth making explicit: a single **care_fe harness template** = the bundle of guides (ARCHITECTURE.md, skill sources) + sensors (test suite, Playwright gate, lint) named and versioned as one unit, so a second target repo would fork *the template*, not cherry-pick pieces.

### E. Feedforward/feedback coherence as the harness grows
We now have ~12 skills. The article's open question — non-contradicting guides + conflicting-signal trade-offs — is becoming real. A periodic "consolidate the harness" pass (analogous to the OpenAI team's recurring "garbage collection" for drift) over SKILL.md files to catch overlap/contradiction. Could itself be a skill.

### F. Hooks for pre-finish remediation
We enforce gates at loop-stage boundaries. The article's stronger pattern is a **hook that fires before the agent declares done** and bounces it back on typecheck/build failure. Worth checking whether any loop stage lets an agent "finish" with a red computational sensor that a hook could have caught earlier/cheaper.

### G. Cost-shaped placement ("keep quality left")
Map each sensor to *where in the change lifecycle* it fires vs. its cost. Cheap computational sensors should run early and often; expensive inferential ones (lens agents, LLM-judge) gated to fewer, later invocations. We partly do this via the model ladder — the missing half is *timing*, not just model tier.

---

## One-line takeaway
Both articles converge on the same machine we're already building: **recurring failure → strengthen a control (guide or sensor) → verify it offline forever.** Our doctor+evals split is that machine. The near-term wins are (1) ~~making every sensor actually *measure* (ux grading)~~ **done — was a rendering bug, not a missing grader**, (2) making every sensor *quiet on success* (context efficiency), and (3) making our blind spots *visible* (harness-coverage taxonomy).
