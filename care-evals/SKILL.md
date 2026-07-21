---
name: care-evals
description: Offline skill-evaluation harness — the control arm for self-improving CARE skills. Runs pre-authored tasks with known ground truth (seeded-defect diffs + clean controls) against a skill (care-review, care-test-grade, care-triager), grades the output deterministically, and reports before/after deltas + a per-model ladder scorecard. No CI/PR/bots. Use for "eval the skills", "did my skill edit help", "which model is cheapest for this skill", "run the eval suite".
user-invocable: true
argument-hint: "[task-id | comma-list | all] [--adapter mock|sdk|opencode] [--model <id>] [--ladder]"
---

# CARE Evals (offline skill-evaluation harness)

The **doctor** (`care-loop-doctor`) is the discovery instrument — it finds failures in live runs but
cannot _verify a fix_. care-evals is the missing **control arm**: pre-determined tasks with known
ground truth, no CI/PR/bots, before/after deltas that arm the human judgment gate with **numbers**.

It measures **skill × model**. That is the point: the suite's job is to make skills _model-robust_
and find, per skill, the **cheapest model that passes** — the ladder (free → Haiku → Sonnet → Opus)
decides per skill where quality actually falls off. Production model pins follow this evidence
(human-gated), not doctrine.

## What it evaluates (v1)

| Target skill        | Tasks                                                                       | Ground truth                                                           |
| ------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **care-review**     | seeded-defect diff (`cr-01`, 3 planted defects) + clean control (`cr-02`)   | `must_flag` recall + `must_not_flag` false positives                   |
| **care-test-grade** | seeded-wrong specs — `tg-01` (one of each verdict; AC2 = thin-but-faithful `Weak`), `tg-03` asserts-unrelated (a `Wrong`/block flavor: adjacent success signal stands in for the value), `tg-04` surrogate-dodge (**presence-instead-of-value = `Wrong`/block**; IMP-10 guard, fix routes back to plan) + `tg-02` **mixed control** (AC1/AC3 `Covered` = precision · AC2 = genuine `Weak`-not-block). Three distinct block triggers: rubber-stamp value, unrelated behavior, presence-instead-of-value. | per-criterion verdict enums (`Covered/Weak/Missing/Wrong`) exact-match; block derived from any `Wrong` |
| **care-triager**    | bot feedback over a seeded diff (`tr-01`: real bug + false-positive + scope-creep, reusing cr-01's ground-truthed defects) | per-finding verdict enums (`address/decline/defer`) exact-match; `missed_by` recorded, not gated (v1) |
| **care-ci-fix**     | red-CI failure context over a diff — `cf-01` stale e2e assertion, `cf-02` broken-code, `cf-03` flake control | per-failure **classification** enums (`test-stale/code-wrong/infra`) exact-match. Grades the judgment that drives update-spec / fix-source / no-edit; applying the edit is v1.5 |
| **care-ux-review**  | seeded UI defects (`ux-01` overflow, `ux-02` non-responsive, `ux-03` sub-375 gap probe, `ux-04` workflow-burden wizard) + clean control (`ux-05`); **tablet-band gap probes** (`ux-06` stat-row overflow, `ux-07` sibling action-bar collision — both fine at mobile+desktop, break only at md 768–1023) + tablet clean control (`ux-08`); **nested-scroll gap probe** (`ux-09` sheet with a scroller-inside-a-scroller where the flexbox `min-h-0` trap makes both `overflow-y-auto` regions non-functional) + clean control (`ux-10`); static mode | `must_flag` recall + `must_not_flag` false positives — same deterministic signal grading as care-review. Gap-probe signals **exclude the generic** ("overflow"/"fixed width" for tablet; "add overflow" for nested-scroll) so a review only passes by naming the specific failure — the middle-breakpoint (768–1023) break, or the declared-but-dead scroller / missing `min-h-0`. Live browser mode is out (static-only here) |

Each task pins a real `care_fe` `base_sha` (fixture-rot control). care-review fixtures add new files
via `fixture.patch` (always applies cleanly at the pin); care-test-grade fixtures carry
`criteria.md` + `intent.md` + `specs/`.

## Fidelity — the eval runs the ACTUAL skill

The runner inlines the target skill's **real `SKILL.md`** (verbatim, from
`~/.claude/skills/<skill>/SKILL.md`) plus all task inputs into the prompt — never a paraphrase. So
the eval measures the artifact you edit: **hardening `care-review/SKILL.md` moves the numbers.**
Inlining is host-agnostic and deterministic — it doesn't depend on a runtime's skill-discovery
firing or the model choosing to load the skill, and needs no file/tool permissions.

- **OpenCode can also natively discover our skills** (`~/.claude/skills/<name>/SKILL.md` is one of
  its global skill paths, and the frontmatter matches) — but loading is model-discretion via its
  `skill` tool with no force-preload flag, so we inline for determinism rather than rely on it.
  Requires `opencode` installed + a free provider configured; the adapter passes `--auto` so
  headless runs don't block on tool permissions.
- **Single-model fidelity limit:** an orchestrator skill (care-review spawns Opus lens sub-agents)
  is flattened to one pass on a single-model adapter — the skill's own text is followed, but the
  sub-agent split doesn't fire. Leaf skills (care-test-grade, and the lenses run standalone) are
  fully faithful. For faithful lens measurement, eval `care-diff-review` / `care-technical-review`
  as their own leaf tasks rather than through the care-review orchestrator.

## Run it

```bash
cd care-evals/runner

# Offline plumbing check (no model — replays tasks/<id>/mock_response.md):
python3 run_eval.py all --adapter mock

# Real judgment run (Claude via `claude` CLI), Opus-pinned:
python3 run_eval.py all --adapter sdk --model claude-opus-4-8

# Free-model ladder rung (OpenCode). Start ONE warm server first, then run:
opencode serve --port 4599 >/tmp/oc_serve.log 2>&1 &   # leave running for the whole sweep
python3 run_eval.py all --adapter opencode --model opencode/deepseek-v4-flash-free
#   --adapter opencode  = the reliable serve transport (sync POST /session/{id}/message,
#     fresh session per call, tools disabled). $OPENCODE_SERVER_URL overrides the default :4599.
#   --adapter opencode-run = the legacy `opencode run` CLI path — one-offs only; it cold-starts /
#     wedges a shared server under batch load (esp. orchestrator skills like care-review). Avoid for sweeps.
#   opencode ships free `opencode/*` models (no auth): deepseek-v4-flash-free, nemotron-3-ultra-free,
#     mimo-v2.5-free, hy3-free, north-mini-code-free, …

# One task, with the layer-2 LLM judge on a strong pinned model:
python3 run_eval.py cr-01-invoice-discount-bug --adapter sdk --model claude-opus-4-8 \
        --judge-adapter sdk --judge-model claude-opus-4-8
```

Outputs land in `results/<date>-<adapter>-<model>/`:

- `<task>.result.json` — JobResult (`care-evals/jobresult@1`, mirrors `care-loop/jobresult@1`).
- `<task>.output.md` — the raw skill output.
- `<task>.grading.json` — pass/fail + score + detail (recall/FP or verdict accuracy).
- `benchmark.md` — pass-rate + mean±stddev per skill.
- `ladder.md` — per skill × model-id scorecard (pass-rate + est $). **Compare within a model-id +
  date only** — a model swap invalidates prior deltas.

## Grading (two layers)

1. **Deterministic (always, authoritative for v1):** signal-based `must_flag` recall + `must_not_flag`
   false-positive count (care-review); verdict-enum exact-match (care-test-grade; and care-triager's
   per-finding `address/decline/defer`). Runs with no model
   — this is what makes the harness cheap and CI-able.
2. **LLM judge (optional, `--judge-adapter`):** `runner/grader-agent.md` scored by a strong,
   **version-pinned** model. Refines the coarse layer-1 recall for prose. A weak judge invalidates
   every grade — keep it pinned and strong even if free.

## Model strategy (dual-track)

Skills under test run on **free models by default** (the OpenCode ladder rung); the SDK adapter
covers the Claude tiers. The ladder turns the "judgment = Opus" tier table from doctrine into a
**per-skill empirical result**.

Guardrails that keep this honest:

- **Compare within model-id only.** Every result row carries model-id + date; free-tier churn →
  re-run the suite before trusting a delta.
- **Suite quality is safety-critical.** A weak model shipping for judgment on weak fixtures is false
  confidence. The clean-control (false-positive) and seeded-defect (miss) tasks must be strong
  _before_ any downward model move.
- **Grader stays strong.** The layer-2 judge runs on the strongest consistently-available model
  (free is fine if strong + pinned per results batch).
- **Prompt-tuning is the first fix.** Where a skill fails a cheaper rung, harden its `SKILL.md` for
  model-robustness (explicit vocab, tighter output contracts) and re-run — cost optimization via
  skill tuning.

## The standing rule

**Once the suite exists, no skill edit lands without an eval delta.** A change to `care-review` /
`care-test-grade` (or any skill once it has tasks here) is accompanied by a `benchmark.md` before/
after on the **same** model-id. A regression in recall or precision blocks the edit at the human gate.

## Adding a task (fixtures are the real cost)

1. `tasks/<id>/task.md` — frontmatter (`id`, `skill`, `tier`, `kind`, `args`) + human-readable
   description of what's seeded.
2. `tasks/<id>/base_sha` — a pinned `care_fe` commit.
3. **care-review:** `fixture.patch` (author in a throwaway worktree at `base_sha`, then
   `git diff --cached > fixture.patch`; prefer new-file additions so it always applies).
   **care-test-grade:** `criteria.md` + `intent.md` + `specs/`.
   **care-triager:** `fixture.patch` (the change) + `feedback.md` (bot findings, each tagged `[F#]`;
   reuse a care-review seeded-defect patch so the `address` items are already ground-truthed, then add
   verifiable false-positives → `decline` and scope-creep → `defer`).
   **care-ci-fix:** `change.diff` (the change, static — fully offline, no `--care-fe` needed) +
   `failures.md` (red-CI checks, each tagged `[F#]` with its annotations) + `criteria.md` (the plan's
   acceptance criteria). Author one of each class: stale assertion → `test-stale`, real regression →
   `code-wrong`, flake/infra → `infra` (the `cf-03` control catches an over-eager fixer that edits over
   a flake).
4. `tasks/<id>/expected.json` — ground truth: `must_flag[{file,line_hint,class,signals}]`,
   `must_not_flag[]`, `clean_signals[]` (controls), `expected_verdicts{AC→enum}` (test-grade), or
   `expected_verdicts{F#→address|decline|defer}` + `critical_verdicts` (triage), plus a `pass`
   threshold block (triage: `min_verdict_accuracy`).
5. `tasks/<id>/mock_response.md` — an ideal output, so `--adapter mock` self-tests the task.

**Fixture soundness — the control must be provably right.** A failing *control* (a clean/sound
fixture that grades red) is far more often a **fixture bug than a model failure** — treat it as
guilty until proven otherwise. For test-grade especially, **criterion ↔ intent ↔ spec must be in
exact agreement**: a criterion of "at most 10" with a spec asserting `toHaveCount(10)` is genuinely
`Weak` (asserts exactness the criterion doesn't require; unfaithful unless ≥10 is seeded and made
explicit) — a correct grader *will* flag it, so labelling it `Covered` makes the control wrong, not
the model. (Real example: tg-02 AC1, 2026-07-13 — the free model correctly caught it; the fix was to
tighten the criterion to "exactly 10 on a full first page" + state the ≥10 seed in `intent.md`.)
Before trusting a red control, re-derive the ground truth by hand.

**escape → fixture discipline:** a live miss/false-positive the doctor catches (a skill escape)
becomes a fixture candidate here — reproduce it as a task so the regression is caught offline forever.
See `care-loop-doctor/diagnoses/IMPROVEMENTS.md`.

## Relationship to care-loopd

The runner **is** the care-loopd phase-2 runner skeleton (shared stage → invoke → collect → JobResult
shape; see `care-loop/PLAN-orchestrator-architecture.md` §3–4, §10 phase 2.5). The suite doubles as
the runner's abort-criterion testbed: **≥9/10 valid JobResults** across the two roles, or the whole
headless direction is re-evaluated. `run_eval.py` prints that tally every run.

## Non-goals (v1)

care-ux-review **live browser mode** = out *of v1* (static-mode grading is in — signal-based recall/FP,
same as care-review). It is now **designed** — see [`LIVE-EVAL-SCOPE.md`](./LIVE-EVAL-SCOPE.md): a
model-free playwright-python grader that renders fixtures at 375/768/1280 and grades on JS layout
probes (`scrollWidth`/`clientWidth`, page overflow, scroll usability), the deterministic-layer answer
to the spatial-geometry classes (ux-06/07 tablet band, ux-09 nested scroll) that a diff-only lens is
structurally weak at. Static and live are **complementary lenses**, not either/or. Continuous running
and any autonomy are out — this is an offline, human-gated measurement tool.
