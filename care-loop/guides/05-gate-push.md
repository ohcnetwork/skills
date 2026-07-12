# Step 5 — Gate + push (spawned role · Sonnet / script)

## Pre-push gate — all must pass

Run **`run_gate.sh`**: `tsc --noEmit` → lint → build → vitest (when available) → affected Playwright
specs. Pass specs with `-s "<spec ...>"`; omit `-s` to skip Playwright; `-n` for build-less
inner-loop check. Full per-stage output: `<run-dir>/gate/*.log`. **Never push on a failing gate.**

**The build runs ONLY through `run_gate.sh` — never a bare `npm run build` in the integrated
terminal.** The production build is memory-heavy (2+ min; needs `NODE_OPTIONS=--max-old-space-size`
per [hosts.md](./hosts.md)); a foreground `npm run build` in Copilot's integrated terminal has
OOM-crashed the terminal **and VS Code** mid-build, taking the session down. `run_gate.sh` sets the
heap ceiling and writes to `<run-dir>/gate/build.log` — always use it (`-n` skips the build for an
inner-loop type/lint pass).

The Playwright stage runs under the shared-e2e lock (`pw-lock.sh`, built in) — a **long wait at the
`playwright…` stage means another worktree loop holds the backend/DB lock, not a hang.** It's
token-free; let it wait.

## Commits — scope-prefixed (**scope > type**)

- **`scope: imperative description`** — scope = feature/module lowercase token (`questionnaire`,
  `encounter`, `billing`, `facility`, `auth`, …); fall back to top-level `src/` area.
- Body carries the _why_ when it isn't obvious from the description.
- **One commit per round** — no commit spam.
- **`[ENG-###]` in PR title only** — never in the commit scope.
- **Idempotent (safe on resume):** **commit only if the tree is dirty**; **push only if local is
  ahead** of the PR head (`resume-probe.sh` reports both). On a clean re-entry these are no-ops —
  never double-commit or force a redundant push.

## First round — open the PR

```
gh pr create --base develop --title "[ENG-707] <summary>" \
  --body-file <run-dir>/pr-body.md --label agentic-workflows
```

**Ready, not draft** (Greptile only reviews ready PRs). _(Inside VS Code Copilot, use the native
PR tool — see [hosts.md](./hosts.md).)_ **Body from the template** — read
`.github/pull_request_template.md`, fill sections in place, keep the merge-checklist verbatim,
write to `<run-dir>/pr-body.md`. Never omit the checklist.

## Post UI screenshots — right after the push (when Step 4c produced screens)

If `<run-dir>/ui/round-<N>/` exists and is non-empty, run `post-ui-screens.sh` to push the
screenshots to the assets branch and post a PR comment with embedded images:

```bash
"$SKILL_DIR/post-ui-screens.sh" -d "<run-dir>" -p <PR> -r <ROUND> -R ohcnetwork/care_fe
```

This is a no-op (safe to always call) when the directory is empty or doesn't exist. After the PR
is merged, the exit report reminds the user to delete the assets ref:
`git push origin :care-loop-assets/<branch-flat>`.

## Post staged replies — right after the push

Post every entry from `<run-dir>/replies.md` (written by 6b): inline threads via
`gh api repos/ohcnetwork/care_fe/pulls/<n>/comments/<comment_id>/replies -f body=...`; top-level
via `gh pr comment`. Append pushed commit SHA to **fixed** replies; **declined** replies carry the
6a reason as-is. Sign `— care-loop 🤖`. **Declined-only round** (no push): post immediately.
Archive after posting: `mv replies.md replies-r<N>.posted.md`. No `replies.md` (round 1) → no-op.

- **Idempotent (safe on resume):** if a crash posted only _some_ replies, **skip any thread that
  already has a `— care-loop 🤖` reply at/after the current head** — don't double-post. Set
  `state.json` to `5-replying` before this block and the settled step after, so a resume re-enters
  here and finishes the remaining posts.

## Wait for bots + CI — token-free

**Default bot set is single-sourced in `poll-pr.sh`** (`-b` overrides) — don't maintain a list
here. Round 1: confirm the repo-active subset via recent-PR authorship; drop any bot that never
engages within the timeout. Rounds 2+: narrow to bots that reviewed the previous round (`-b`).

```
poll-pr.sh -s "$(date -u +%Y-%m-%dT%H:%M:%SZ)" -c "$(git rev-parse HEAD)"
```

**Always pass `-c`** — without the pushed SHA, Greptile in-place-edited summaries are invisible and
the loop hangs. Timeout per tier (SKILL.md tier table): `trivial` 900s; `standard` 900s (<5 changed
files) or 1800s; `complex` 1800s. On timeout: report what never arrived, ask the user.

**`poll-pr.sh` is the ONLY CI/bot wait — never hand-poll.** Do NOT run `gh pr checks` /
`gh pr view --json …` in a loop to watch CI: hand-polling parks the loop waiting for a human nudge
instead of blocking token-free in the terminal (a live run stalled at `5-waiting-ci` with CI
already green, needing repeated "status?" prompts to move). On timeout, **re-invoke `poll-pr.sh`**
(don't fall back to hand-polling). The instant it exits 0, **proceed straight to Step 6a** — do not
wait for a prompt.

## Never rebase or merge `develop` autonomously

Merge conflicts or develop-drift CI failures → `NEEDS_INPUT` / `defer-to-human`. A recent merge may
have touched related features — auto-handling would confuse context.

Inherits [working-agreement.md](./working-agreement.md) and [token-discipline.md](./token-discipline.md).
