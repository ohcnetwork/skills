# Step 0 — Resume (orchestrator · run before the pipeline when a run dir already exists)

A host session can die **mid-step** (Copilot, no error, between turns). The run dir + worktree
survive, but `state.json` names the step's _start_, not its progress — so it can be **stale**. This
guide reconciles the anchor against reality and picks the true re-entry step. Never trust
`state.json` alone.

## 1. Probe ground truth

Run the bundled **`resume-probe.sh`** — one round-trip, compact digest (don't run the git/gh
commands by hand; that re-caches their output):

```
resume-probe.sh
```

It prints: `tree` (dirty ⇒ a maker/6b left uncommitted edits), `pushed` (local vs PR head),
`bots-at-head` (who reviewed the current HEAD), `ci`, and `artifacts` (which run-dir stage files
exist). Read `state.json`'s `step` too — including the `-ing` in-progress markers
([observability.md](./observability.md)); the full step vocabulary is `write-state.sh --vocab`.

## 2. Reconcile — anchor × ground truth → re-entry step

| `state.json` step            | Ground truth (from the probe)                     | Re-enter at                                                                        |
| ---------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| any `6*` / `*-await*`        | **tree dirty**                                    | **Step 5** — 6b already applied edits; gate + commit + push. Do **not** re-triage. |
| `5-committing` / `5-pushing` | tree clean, **local ahead** of PR head            | Step 5 — push only (commit exists)                                                 |
| `5-pushing` / `5-await`      | **pushed** (heads match), bots **not** at head    | Step 5 — poll (`poll-pr.sh`)                                                       |
| `6a`                         | pushed, bots **at head**, no `verdicts.md`        | Step 6a — triage                                                                   |
| `6b-applying`                | `verdicts.md` present, tree clean                 | Step 6b — apply (re-derive from `verdicts.md`)                                     |
| `5-replying`                 | `replies.md` present, some `replies-r*.posted.md` | Step 5 — post the **remaining** replies                                            |
| `3-implementing`             | tree dirty, **no PR yet**                         | Step 3 — continue; gate the partial work                                           |

**Reply reconstruction:** if a dirty tree came from a lost 6b but `replies.md` was never written,
derive the addressed threads from the applied **diff vs. the open comment threads** (which
files/lines the edits touch), not a guess. If it stays ambiguous, surface to the user.

## 3. Report, and gate only on contradiction

Before any mutating action, emit a one-line reconcile report, e.g.:

> Resuming ENG-648: anchor said `5-await`; tree dirty (2 files), PR head not advanced, bots
> reviewed `856ac149b`, CI fail. Re-entering at **Step 5** (gate + commit + push the applied fixes).

- **Ground truth matches the anchor** → proceed automatically.
- **Ground truth contradicts the anchor** (the interesting cases — a dirty tree under an `await`
  step, a diverged head) → **ask the user to confirm** the re-entry before mutating.

## 4. Resume rule (from observability.md)

If `state.json`'s `worktree` path no longer exists on disk, **report and stop** — never silently
recreate it. A missing worktree means the user intervened.

**Reap an orphaned dev server.** If the prior session died during Step 4c, the Vite dev server it
started (logged to `<run-dir>/agents/dev-server.log`) may still be running and holding a port. If
`<run-dir>/.dev-server.pid` exists, `kill "$(cat <run-dir>/.dev-server.pid)" 2>/dev/null` and
`rm -f` the pidfile. As a fallback (older run, no pidfile), if the log exists and a listener's cwd
is inside this worktree but no 4c validation is active, it's an orphan — kill it before re-running
4c so the fresh validator starts clean.

Once the re-entry step is chosen, hand back to the normal pipeline at that step. The per-step
idempotency guards ([05-gate-push.md](./05-gate-push.md), [06b-apply.md](./06b-apply.md)) make a
re-entry safe even if the crash left partial work.

Inherits [working-agreement.md](./working-agreement.md) and [token-discipline.md](./token-discipline.md).
