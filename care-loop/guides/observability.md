# Observability & state (token-free watchdog + the run dir)

## The run dir — `<skill-dir>/runs/<repo>-<branch-flat>/`

The **single** persistence location for a loop run. Nothing loop-persistent goes in guide files or
ad-hoc paths. It lives inside the installed skill folder (which `~/.claude/skills/care-loop` and
`~/.agents/skills/care-loop` symlink), under `runs/` — gitignored, durable across reboots (unlike
`/tmp`), and past runs stay on disk as material for iterating on the loop skill itself. All loops'
run dirs sit side by side here, so **fleet status is `cat runs/*/state.json`**.

**The slug is derived, never invented.** Repo name comes from the **main `.git`**
(`git rev-parse --path-format=absolute --git-common-dir`, then the parent's basename) — NOT the
worktree's toplevel — so a loop running inside a worktree resolves to the **same** slug as the main
checkout. The branch has `/` flattened to `-` (`eng-648/generic-autocomplete` → slug
`care_fe-eng-648-generic-autocomplete`), so the dir stays flat and the `runs/*/state.json` fleet
glob never misses a nested path. Every bundled script computes this same default (pass `-d` only to
override). **Step 1 constructs the slug by hand from the _planned_ branch** — before the worktree
exists, the derived default would still read `care_fe-develop` (collision risk), so the planner
writes directly to `runs/<repo>-<planned-branch-flat>/`. No post-hoc `mv`: the branch is created at
approval, not Step 3.

At the top of each round the orchestrator re-derives where it is from this dir, never from
conversation scrollback (see the stateless-rounds rule in `SKILL.md`) — so the conversation can be
compacted aggressively and a crashed session resumes mid-loop. **`state.json` is the resume
anchor**; `loop.log` is narrative only. **Resume rule:** if `state.json`'s `worktree` path no
longer exists on disk, **report and stop** — never silently recreate it. A missing worktree means
the user intervened (removed it, finished the task); recreating would clobber that.

## The shared e2e lock — `runs/.playwright.lock`

Every loop has its own worktree, but the backend :9000 and the Playwright DB snapshot are
**singletons**. `pw-lock.sh` is a global mutex (atomic `mkdir` lock at `runs/.playwright.lock`,
holder pid recorded, stale/dead-pid locks stolen) that serializes DB/spec access across loops. It's
built into `run_gate.sh` (around the Playwright stage) and `preflight.sh` (around the DB stages), so
callers can't forget it; it's also exposed for ad-hoc spec runs (see [03-implement.md](./03-implement.md)).
**Restore-on-acquire:** whoever takes the lock runs `playwright:db-restore` first (skipped only on
preflight's snapshot-bootstrap path via `-S`) — never trusting the previous holder to have left a
clean DB, which also makes stale-steal safe. While waiting, it heartbeats to
`agents/pw-lock.log` so the watchdog doesn't read the wait as a stall.

Manifest:

| File                 | Written by                                                            | Purpose                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state.json`         | orchestrator, **only via `write-state.sh`**, at every step transition | machine-readable resume anchor (schema below); the script validates keys/types/step vocabulary and writes atomically — **never hand-write this file** (it drifted in every hand-written run) |
| `loop.log`           | orchestrator                                                          | round-by-round narrative + the one-line round summaries                                                                                                                                      |
| `agents/<agent>.log` | each spawned agent                                                    | structured progress markers ([working-agreement.md](./working-agreement.md)) — subdir keeps them out of the all-DONE check's way                                                             |
| `gate/*.log`         | `run_gate.sh`                                                         | full per-stage gate output; mtimes count as activity for the stall check                                                                                                                     |
| `baseline.md`        | Step 1                                                                | frozen scope baseline — grounded by recon, not a blind prediction ([governance.md](./governance.md))                                                                                         |
| `criteria.md`        | Step 1                                                                | acceptance criteria = ground truth for Step 4.5 test-grade                                                                                                                                   |
| `decisions.md`       | Step 1                                                                | interview Q&A + non-goals; 6a can cite a decision to decline a finding without re-verification                                                                                               |
| `intent.md`          | `care-diff-review` (loop-invoked, round 1)                            | full code-reconstructed intent for Step 4.5; **never overwritten** — round-2+ delta intents are appended as `## Round N delta` sections so the grader always has full-branch context         |
| `feedback.md`        | `collect-feedback.sh`                                                 | pre-digested bot/CI feedback for Step 6a — grouped by file+line, `[resolved]` tagged                                                                                                         |
| `verdicts.md`        | Step 6a                                                               | the triaged verdict list; **overwritten each round** (declines persist in `declined.md`); Step 6b is spawned with this **path**                                                              |
| `declined.md`        | Step 6a (append-only) + Step 4                                        | cross-round decline memory — one fingerprint line per decline; checked before re-litigating                                                                                                  |
| `addressed.md`       | Step 6a (append-only)                                                 | escape log — one entry per bot-caught `address` verdict with `class:` + `missed-by:` attribution; the doctor aggregates these across runs to target which skill to improve                   |
| `replies.md`         | Step 6b                                                               | staged thread replies; Step 5 posts them after the push and archives to `replies-r<N>.posted.md`                                                                                             |
| `pr-body.md`         | Step 5 (round 1)                                                      | the filled PR template passed to `gh pr create --body-file`                                                                                                                                  |
| `ui-surfaces.md`     | Step 1 (when `.tsx` files touched)                                    | changed screens + sibling surfaces + routes + long-content stress candidates; consumed by Step 4.8                                                                                           |
| `ui/round-<N>/`      | Step 4.8 (live mode)                                                  | per-surface viewport screenshots (`<surface-slug>-<viewport>.png`); consumed by `post-ui-screens.sh` in Step 5                                                                               |

`state.json` schema — **exact, and enforced by `write-state.sh`** (the only write path: a step
transition is `write-state.sh -s 6a`; unset fields carry forward, `updated_at` is stamped, the
write is atomic, and wrong types / unknown steps / ad-hoc keys are rejected). For reference:
`repo` is the full `owner/name`, `pr` is the integer number (not a URL),
`head_sha`/`last_reviewed_sha`/`updated_at` are always present, `worktree` is the absolute
worktree toplevel. No extra ad-hoc keys.

```json
{
  "task": "<one-line task>",
  "repo": "ohcnetwork/care_fe",
  "branch": "eng-648/generic-autocomplete",
  "worktree": "/Users/…/care_fe-eng-648-generic-autocomplete",
  "tier": "standard",
  "pr": 16539,
  "round": 2,
  "step": "6a",
  "head_sha": "<sha>",
  "last_reviewed_sha": "<sha-reviewed-in-step-4>",
  "updated_at": "<iso-utc>"
}
```

**`step` — settled values + in-progress markers.** The **canonical vocabulary is single-sourced in
`write-state.sh`** — print it with `write-state.sh --vocab` (never maintain a copy here). Settled
values are `1`, `2`, `3`, `4`, `4.5`, `4.8`, `5`, `6a`, `6b`, `7`, `merged`, `aborted`. **Bracket
every side-effecting action** with an `-ing` marker written _before_ it and the settled value
_after_ — `3-implementing`, `4.8-validating`, `6b-applying`, `5-committing`, `5-pushing`,
`5-replying`, `5-await`. A crash then leaves an unambiguous "was mid-X" marker that resume keys on,
instead of a stale start-of-step anchor. The write is tiny (atomic temp+`mv`); do it every transition.

## Resume — reconcile, don't trust the anchor

A host session can die mid-step, so `state.json` may lag the real work. On re-invocation the
orchestrator runs [00-resume.md](./00-resume.md), which starts from **`resume-probe.sh`** — a
one-round-trip ground-truth digest (working tree dirty?, local vs PR head, which bots reviewed the
current head, CI, which run-dir artifacts exist). The reconcile table there maps (anchor step ×
ground truth) → the true re-entry step; per-step idempotency guards
([05-gate-push.md](./05-gate-push.md), [06b-apply.md](./06b-apply.md)) make re-entry safe. The
crash isn't auto-detected — re-invoking is what triggers the reconcile.

## `watch-agents.sh` — the watchdog

Run the bundled **`watch-agents.sh`** in the terminal — a blocking `sleep` loop that consumes **no
model tokens**. It returns the moment any agent needs attention: a **new** `NEEDS_INPUT`/`BLOCKED`
marker (per-file byte offsets persist in `.watch-cursor`, so a marker that was already surfaced and
answered never re-triggers the next invocation), a **stall** (nothing written anywhere under the
run dir — `gate/` logs included — within the threshold, default 900s), or **all agents `DONE`**. On
return, the orchestrator **surfaces the exact message to the user** and waits — turning a stuck
agent into a prompt instead of a silent hang. (Prefer this over an agent that watches agents: same
result, no token cost, and it works in Copilot where there's no background scheduler.) It derives
the run dir from repo+branch like every other script; `-d` only to override.
