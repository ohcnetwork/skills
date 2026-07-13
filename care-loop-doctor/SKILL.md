---
name: care-loop-doctor
description: Self-diagnosis for the care-loop skill — collate Copilot session evidence (auto-discovered VS Code chat sessions + optional debug-log exports) with care-loop run dirs, judge the run against a rubric, persist findings as memory, and apply improvements to the skill files behind one human gate. Use for "diagnose the loop", "why did the loop do X", "analyze this debug log", "loop retro", "improve care-loop from this run". Standalone — does not run the loop.
user-invocable: true
argument-hint: "[log/session path(s) | run-dir slug]"
---

# CARE Loop Doctor (diagnose → gated self-improvement)

Turn a care-loop run's evidence into (1) a diagnosis report, (2) durable memory, and (3) — with
**one human gate** — applied improvements to the care-loop skill files. Standalone from the loop;
this skill + the loop are designed to eventually merge into a self-improving agent, with
`diagnoses/` as its seed memory.

Diagnosis is **judgment work** — run on a strong model, and record `diagnosed-by: <model>` in the
report header (same honesty rule as the loop's `planned-by:`).

## Evidence tiers (manual exports are OPTIONAL — never block on them)

| Tier | Source                                                                        | Gets you                                                                                                | Availability                               |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| J    | `<run-dir>/journal.jsonl` + `agents/*.result.json` (headless `care-loopd` runs) | exact step/spawn/decision timeline, `model_used` per spawn, cost, reason codes, checkpoints             | headless runs only (once `care-loopd` ships — PLAN-orchestrator-architecture §5) |
| A    | VS Code chat-session storage (`workspaceStorage/<hash>/chatSessions/*.jsonl`) | per-request `modelId`, agent, timeline, tool invocations, marker counts, silence gaps                   | **auto-discovered** via `find-sessions.sh` |
| B    | manual UI export `agent-debug-log-<session>.json`                             | per-turn token counts, spawn model args, tool errors, mid-turn-death detection                          | only if the user exported it               |
| C    | `care-loop/runs/<slug>/` run dir                                              | state.json, loop.log, agents/\*.log, plan artifacts, gate logs, addressed.md/declined.md verdict memory | always                                     |

**Tier J outranks A/B when present.** A journal-emitting run is diagnosed from J + C alone — read
`journal.jsonl` directly (one compact fact per line; grep by `event`, no digest script needed).
Chat sessions then serve one purpose only: an occasional honesty spot-check that session `modelId`s
match the journal's `model_used`. A/B remain the primary path for editor-hosted (legacy) runs.

If Tier B is absent and the diagnosis needs its depth (token economics, spawn args), say exactly
what's missing and how to export — _VS Code: Copilot chat panel → `…` menu → "Export Debug Log"
(or `⇧⌘P` → "Chat: Export…"), save anywhere, pass the path_ — then **proceed on A + C anyway**.
A `copilot_all_prompts_*.json` export has no parser; grep it selectively (model lines,
system-prompt headers) only when provided.

## Workflow

1. **Gather.** Explicit paths in the invocation win. Otherwise: list `care-loop/runs/*/`
   candidates (Tier C) and check each for `journal.jsonl` (Tier J) **first**; then
   `find-sessions.sh -r care_fe` (Tier A) and glob `~/Desktop`/`~/Downloads` for
   `agent-debug-log-*.json` (Tier B). Show what was found before digesting.
   **Tier-A scoping (IMP-11 — a wrong default here produced a wrong diagnosis on 2026-07-12):**
   loop sessions live in the TARGET repo's VS Code workspace (`Desktop/care_fe`), never in the
   skills workspace — **always pass `-r care_fe`** (or run from a care_fe checkout). Never rely on
   the cwd-derived default when the doctor is invoked from the skills repo: it scopes to the
   skills workspace, which holds only skill-development sessions, and every loop run is missed.
2. **Digest.** Tier A/B: one `digest-session.py <all files>` call — it auto-detects both formats
   and emits ~50 factual lines per session, including **marker counts** (helper-script adherence,
   drift signals, agent spawns, crash strings) and **silence gaps ≥10 min** — do not hand-roll
   these analyses. Tier J needs no digestion (read/grep the journal directly). Never parse the
   raw session JSON in-context.
3. **Pair.** Match sessions ↔ run dirs: time window vs `state.json`/artifact mtimes, branch/PR
   strings in the digest timeline vs `state.json`. State the pairing (or that none was found).
4. **Analyze.** Apply [rubric.md](./rubric.md) — trends dimension **first** (read
   `diagnoses/IMPROVEMENTS.md` + last 2–3 reports), then the seven evidence dimensions. For
   dimension 8 (escape attribution), read `addressed.md` from **all** run dirs found in step 1,
   not just the paired one — the aggregate is the signal. Every finding carries an evidence
   pointer. When Tier J is present, dimensions 1/3/4/5 (model tier, token/cost, pipeline order,
   schema adherence) are **exact reads** from the journal, not inferences from session forensics.
   **escape → fixture:** any escape attributed to a *skill* miss/false-positive (a review that
   missed a real defect, a test-grade that rubber-stamped) is a `care-evals` fixture candidate —
   note it in the report so the regression can be reproduced offline as a ground-truth task (see
   `care-evals/SKILL.md`). The doctor discovers; care-evals verifies the fix with a before/after delta.
5. **Report.** Write `diagnoses/<yyyy-mm-dd>-<sess8>.md` (append `-b`, `-c`… on same-day rerun —
   never clobber):

   ```
   # Diagnosis — <date> — session <sess8> (<run-dir slug or "unpaired">)
   diagnosed-by: <model>
   evidence: <tier-A files> · <tier-B files or "none"> · <run dir or "none">

   ## Findings (ranked by impact)
   1. [<rubric dim>] <one-line finding>
      evidence: <digest line / artifact path>
      proposed edit: <file + section, concrete> | none
   ## Healthy signals
   - <what worked — regressions are detected by these disappearing>
   ```

6. **Backlog.** Merge findings into `diagnoses/IMPROVEMENTS.md` — one fingerprinted entry per
   distinct issue:

   ```
   ## IMP-<n> · <short title>
   status: open | applied (<date>) | declined (<reason>)
   first-seen: <date> · seen: <count> · dimension: <rubric #>
   evidence: <report file(s)>
   proposed edit: <file + section>
   ```

   Re-observations bump `seen:` and append the report pointer — **never duplicate an entry**. An
   `applied` entry re-observed = flag as regression in the report. A `declined` entry is not
   re-proposed without materially new evidence.

7. **Gate + apply.** Present **one consolidated ask**: the proposed edits grouped by target file,
   each tagged with its `IMP-<n>`. On approval — apply them to `care-loop/` (or this skill's own
   files), mark the entries `applied (<date>)`. Declined items → `declined (<reason>)`. **No
   approval → the report + backlog stand; nothing else is touched.** The apply scope is skill
   files ONLY — never `care_fe` code, never `runs/` artifacts.

## Non-goals

- Does not run or resume the loop (that's `care-loop` + its `00-resume.md`).
- No Claude Code transcript ingestion in v1 (separate format; later).
- No scheduler — user-invoked. The self-improving-agent conversion is a future plan that reuses
  `diagnoses/` as memory.
