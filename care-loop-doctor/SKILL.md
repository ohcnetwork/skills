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

| Tier | Source | Gets you | Availability |
|---|---|---|---|
| A | VS Code chat-session storage (`workspaceStorage/<hash>/chatSessions/*.jsonl`) | per-request `modelId`, agent, timeline, tool invocations | **auto-discovered** via `find-sessions.sh` |
| B | manual UI export `agent-debug-log-<session>.json` | per-turn token counts, spawn model args, tool errors, mid-turn-death detection | only if the user exported it |
| C | `care-loop/runs/<slug>/` run dir | state.json, loop.log, agents/*.log, plan artifacts, gate logs, addressed.md/declined.md verdict memory | always |

If Tier B is absent and the diagnosis needs its depth (token economics, spawn args), say exactly
what's missing and how to export — *VS Code: Copilot chat panel → `…` menu → "Export Debug Log"
(or `⇧⌘P` → "Chat: Export…"), save anywhere, pass the path* — then **proceed on A + C anyway**.
A `copilot_all_prompts_*.json` export has no parser; grep it selectively (model lines,
system-prompt headers) only when provided.

## Workflow

1. **Gather.** Explicit paths in the invocation win. Otherwise: `find-sessions.sh` (Tier A, from
   the repo checkout or `-r care_fe`), glob `~/Desktop`/`~/Downloads` for `agent-debug-log-*.json`
   (Tier B), and list `care-loop/runs/*/` candidates (Tier C). Show what was found before
   digesting.
2. **Digest.** One `digest-session.py <all files>` call — it auto-detects both formats and emits
   ~50 factual lines per session. Never parse the raw JSON in-context.
3. **Pair.** Match sessions ↔ run dirs: time window vs `state.json`/artifact mtimes, branch/PR
   strings in the digest timeline vs `state.json`. State the pairing (or that none was found).
4. **Analyze.** Apply [rubric.md](./rubric.md) — trends dimension **first** (read
   `diagnoses/IMPROVEMENTS.md` + last 2–3 reports), then the seven evidence dimensions. For
   dimension 8 (escape attribution), read `addressed.md` from **all** run dirs found in step 1,
   not just the paired one — the aggregate is the signal. Every finding carries an evidence
   pointer.
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
