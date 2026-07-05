---
name: care-review
description: Full review of a CARE frontend (care_fe) diff via two parallel lens agents — (1) what problem the change solves + whether the code makes it legible, and (2) whether the approach is the simplest one or overengineered — condensed into one report. Use for "review/critique my changes", "review the diff", "full review", "review against develop / the last commit". Add "thorough" for a heavier cross-model ensemble. Defaults to diffing against develop; suggests rather than edits.
user-invocable: true
argument-hint: "[develop | commit | working | <file>] [thorough]"
---

# CARE Review (orchestrator)

Two lenses, run as **parallel subagents** and condensed into one report. Each agent reconstructs
intent independently — you can't judge a solution until you know the problem — and the orchestrator
reconciles their readings:

1. **Intent & legibility** — what does the change do, what requirement does it fulfill, does the
   code convey that on its own? → `care-diff-review`
2. **Approach** — given that problem, is this the simplest solution or overengineered; what can be
   simplified or reused? → `care-technical-review`

## Flow

1. **Resolve the diff once → a temp file.** Default is everything the branch changes vs `develop`:
   ```
   git diff $(git merge-base develop HEAD) > /tmp/care_review.diff && wc -l /tmp/care_review.diff
   ```
   Overrides only when asked: last commit (`git show HEAD`), working only (`git diff` +
   `git diff --staged`), or a named file. **Always write to the file and read that** — never rely
   on inline terminal output, which truncates on large diffs and wastes turns re-running `git`.
   List the changed files. **Do not read the commit message, PR body, or branch name** — intent
   must come from the code.

2. **Pick the mode:**
   - **Default — lens-split.** Two agents in parallel, both on Claude Opus (see *Models*).
   - **Thorough — ensemble.** Triggered by a `thorough`/`deep` argument or an explicit ask for a
     heavier/more-careful review. Run the lens-split across **two** models (Opus + GPT-5.5) for
     cross-provider diversity.

3. **Dispatch the agents in parallel.** Give each agent the diff-file path and instruct it to:
   read `/tmp/care_review.diff` (scope is already resolved — do **not** re-resolve or re-run git),
   reconstruct intent **independently** from the code (no commit message), apply its lens, and
   **return its findings to you — it must not confirm with the user** (you own the single confirm).
   - **Default:** Agent A → `care-diff-review`; Agent B → `care-technical-review`. Both on Opus.
   - **Thorough:** run that A+B pair **twice** — once on Opus, once on GPT-5.5 (up to 4 agents in
     parallel).

4. **Condense into ONE report** — reconcile, don't concatenate:
   - **Bottom line** — one or two sentences: is it sound / mergeable? For a refactor-only diff, the
     behavior-preserving yes/no.
   - **Intent** — one or two sentences (what + the requirement), with confidence. **Reconcile** the
     agents' independent intent readings: they agree → high confidence; they diverge → flag the
     ambiguity (the code isn't conveying its intent).
   - **Worth deciding** — only the **1–2 findings that actually matter**: correctness, a regression
     in the *other usages* of a shared component/hook/util the diff touched, or real
     overengineering. This is the signal; keep it short.
   - **Optional / FYI** — everything else (nits, style, micro-simplifications), clearly demoted so
     it doesn't dilute the decision.
   - **Out of scope** — one line for anything deliberately left untouched.

   In **thorough** mode, note where the two models **agreed vs. diverged** — agreement across
   families is high confidence; divergence is a look-closer signal. A clean diff can legitimately
   return "intent clear, approach proportionate, nothing to change." Don't manufacture findings.

5. **Confirm with the user.** Lead with the reconstructed intent — *"is this the problem you were
   solving?"* — since everything hinges on it. A mismatch means illegible code or a wrong solution.
   Then walk the (few) suggestions. **Don't edit until approved.**

## Models

Concrete picks — overridable at invocation; update this block when availability changes.

| Mode | Agents |
|---|---|
| Default (lens-split) | both lenses on **Claude Opus** |
| Thorough (ensemble) | full lens-split on **Claude Opus** *and* on **GPT-5.5**, reconciled |

**Dispatch caveats (verify in your host):**
- Claude Code's Agent tool spawns **Claude models only** — the GPT side of the ensemble needs a
  host that exposes GPT (e.g. VS Code Copilot).
- If the host **can't set a subagent's model**, run `/care-review thorough` as two passes — once
  with the session on Opus, once on GPT-5.5 — then do the reconcile pass yourself.
- If the host **won't spawn subagents at all**, fall back to a single combined pass: read both lens
  rubrics and do one review on the current model. Still valid — you just lose parallelism and
  cross-model diversity.

## Working agreement (inherited by every agent)

Suggest first, don't edit. Smallest possible diff — no scope creep, no adjacent "improvements".
Don't change a component's contract or invent logic to paper over a problem. Less code, not more.
New code reads like the file around it (`CLAUDE.md`).
