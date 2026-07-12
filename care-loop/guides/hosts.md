# Hosts — Copilot-only mechanics

Claude Code sessions can skip this file. It collects the quirks that only apply when the loop runs
inside VS Code Copilot.

## Judgment spawns go by AGENT NAME first; `model` arg is the fallback

_(The **doctrine** — why judgment never runs inline, the enforcement ladder, the `planned-by:`
attestation — lives once in SKILL.md "Model enforcement". This section is only the Copilot
**mechanics** of carrying the judgment model on a spawn.)_

Copilot resolves custom agents from `~/.copilot/agents` (and `~/.claude/agents`,
`<repo>/.github/agents`). The care-loop judgment agents — `care-planner`, `care-reviewer`,
`care-test-grader`, `care-triager` — are installed there with **Opus bound in their `.agent.md`
frontmatter**, so spawning them **by name** via `runSubagent` carries the model with the
identity. That is the primary mechanism. _(First run on a new machine: verify with the
`care-model-probe` agent — session picker on Sonnet, spawn the probe by name, it must self-report
Opus. If it reports Sonnet, Copilot ignored the frontmatter — use the fallback below for
everything.)_

**Fallback — explicit `model` arg.** `runSubagent` takes an optional `model` arg (format
`"Model Name (Vendor)"`). **Passing nothing on a generic spawn defaults to the session model — a
bare generic spawn is a bug, not a default** (a live run planned + recon'd entirely on Sonnet this
way; see SKILL.md "Model enforcement"). When a named agent doesn't resolve, spawn generic with an
explicit model (picks in [models.md](./models.md)):

| Tier                                                                | `runSubagent` model arg         |
| ------------------------------------------------------------------- | ------------------------------- |
| Judgment — plan, `care-review` lenses, triage, test-grade           | `"Claude Opus 4.8 (copilot)"`   |
| Mechanical — implement (`trivial`/`standard`), gate, apply verdicts | `"Claude Sonnet 4.6 (copilot)"` |
| Implement (`complex` tier, or after the escalation valve)           | `"Claude Opus 4.8 (copilot)"`   |
| Ensemble second opinion (`thorough` only)                           | `"GPT-5.5 (copilot)"`           |

Only the **bold Opus** rows in [models.md](./models.md) stay on Opus; everything else spawns on
Sonnet 4.6. _(Thinking Effort + Context Size are session-level picker knobs, not `runSubagent`
args; optionally drop Thinking Effort during mechanical phases, keep High for plan/review/grade.)_

**Step 1 planning is NEVER inline — spawn `care-planner`, relay the interview.** The orchestrator
(whatever the session picker says — it **cannot change the picker**; that's the user's control)
runs Step 1 as **two `care-planner` spawns**:

1. Spawn `care-planner` (named agent — frontmatter binds Opus): recon + draft + **return the
   batched interview questions** (a one-shot `runSubagent` can't talk to the user).
2. Orchestrator relays the questions to the user (structured-questions tool, below).
3. Spawn `care-planner` again with the answers: fold in, finalize artifacts incl.
   `planned-by:` in `baseline.md`.

Drafting the plan in the orchestrator's own turn is a wrong-tier defect the moment the session
picker isn't Opus — and the session prompt tells you your model, so you always know. If the named
agent doesn't resolve **and** `runSubagent` can't take a model arg, stop and ask the user to
switch the picker.

**No hook layer exists in Copilot** — enforcement here tops out at agent frontmatter + the
`Planned by:` attestation. (Claude Code additionally has the opt-in `PreToolUse` hard gate:
`hooks/assert-judgment-agent.py`.)

## Playwright MCP — one-time setup for UI validation (Step 4c)

Step 4c (`care-ux-validator`) and the standalone `care-ux-review` skill drive a real browser via
**Playwright MCP** (`@playwright/mcp`) — no specs, no fixtures. Both hosts support it; the tool
names are the same (`browser_navigate`, `browser_screenshot`, `browser_snapshot`, `browser_evaluate`,
`browser_resize`, `browser_console_messages`, `browser_fill`). Without this setup, Steps 4c and
`care-ux-review live` degrade to static-only analysis and say so in their output.

**VS Code Copilot** — add to User-level MCP config (Settings → "MCP", or edit
`~/.vscode/settings.json`):

```json
"mcp": {
  "servers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

Copilot agent mode passes tool-returned screenshots to vision-capable models, so the validator
can _see_ the page there. If the active model doesn't receive image tool results, the validator
falls back to the accessibility snapshot + JS eval probes (all text) and still saves screenshots
to disk for the PR comment.

**Claude Code** — one-time CLI command (after this, the server starts on demand):

```bash
claude mcp add playwright -- npx @playwright/mcp@latest
```

Alternatively, the built-in **Claude Preview** (`mcp__Claude_Preview__*`) or
**claude-in-chrome** (`mcp__claude-in-chrome__*`) work as substitutes — they expose the same
browser automation surface with different tool-name prefixes; the validator's rubric doesn't depend
on the exact names, only the capabilities (navigate, screenshot, snapshot, eval, resize, console).

**Assets-branch note:** screenshots cannot be uploaded via `gh` — they are committed to a
`care-loop-assets/<branch-flat>` ref (never merged) and embedded in a PR comment via
`raw.githubusercontent.com` URLs by `post-ui-screens.sh`. Delete the ref after the PR merges:
`git push origin :care-loop-assets/<branch-flat>`.

## PATH prelude (Copilot integrated terminal)

Copilot's integrated terminal is a non-login zsh that often lacks Homebrew on PATH —
`gh`/`node`/`npm` come back `command not found: gh`. Prepend it once per terminal:

```
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
```

The bundled scripts (`poll-pr.sh`, `run_gate.sh`, `preflight.sh`, `collect-feedback.sh`,
`pw-lock.sh`) already do this internally.

## Never run a bare `npm run build` in the integrated terminal

The production build is memory-heavy (2+ min). A foreground `npm run build` in Copilot's integrated
terminal has OOM'd and disposed the terminal **and VS Code** mid-build (a live run: "The terminal
has been cleaned up", exit 130). Always build through **`run_gate.sh`** — it bounds node's heap
(`NODE_OPTIONS=--max-old-space-size=4096`, matching care_fe's Docker build) and writes to
`<run-dir>/gate/build.log`. Use `run_gate.sh -n` for a build-less inner-loop type/lint pass.

## Worktree — cwd, absolute paths, and multi-root

The loop runs in its own worktree (SKILL.md "Worktree-first"). In Copilot:

- **Loop terminals `cd` into the worktree** — the bundled scripts derive the run dir, repo, and
  branch from cwd (via the main `.git`), so they resolve correctly from there.
- **File edits use absolute paths** into the worktree (`…/care_fe-<branch-flat>/src/…`), not the
  main checkout.
- **Add the worktree folder to the workspace (multi-root) — do this by default.** `get_errors` and
  the TS language server only report on files the workspace knows about; a worktree outside the
  workspace means falling back to terminal `tsc` for every check (slower, noisier). Single-root is
  the degraded mode.

## PR creation — native tool instead of `gh pr create`

In Copilot, open the Step-5 PR via the native `github-pull-request_create_pull_request` (PATH-free,
no shell `gh` needed to create): `repo={owner:"ohcnetwork", name:"care_fe"}`, `head=<branch>`,
`base=develop`, `draft=false`. The tool's `body` is a plain string with no auto-template — pass the
filled `<run-dir>/pr-body.md` content (same rules as [05-gate-push.md](./05-gate-push.md)). It has
no `labels` param and there's no native add-label tool, so **add the `agentic-workflows` label
right after creating**: `gh pr edit <n> --add-label "agentic-workflows"`.

## Step 1 interview

In Copilot, the Step-1 interview (Phase 2 of [01-plan.md](./01-plan.md)) should use the
structured-questions tool (`AskUserQuestion` / Copilot's equivalent) when available — batch
related questions into one ask so the user answers once per round, not per question.

## No background scheduler

Copilot has **no background scheduler**, so waiting is always the blocking `poll-pr.sh` /
`watch-agents.sh`, never agent polling. Native `github-pull-request_*` tools can create the PR /
fetch labels without shell `gh` (avoids the PATH issue) — but the token-free poll still needs
shell `gh`.
