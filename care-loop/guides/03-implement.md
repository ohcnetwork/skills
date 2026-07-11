# Step 3 — Parallel makers: implement + (optional) e2e  (spawned role · Sonnet, Opus if complex)

The worktree **and** its branch already exist on arrival (the orchestrator created both right after
plan approval — see SKILL.md "Worktree-first"). No branch guard here: cwd is inside the worktree,
on the task branch, ready to edit. **On a resumed run** ([00-resume.md](./00-resume.md)) the tree
may already hold partial edits — continue from them and gate; don't restart the change.

## Spawn two makers in parallel

They write **disjoint paths** (`src/` vs `tests/`), so they run safely on one tree, no worktree
needed:

- **Implementer** (model per the SKILL.md tier table — Sonnet 4.6 for `trivial`/`standard`,
  Opus 4.8 for `complex`; escalation valve: two failed gate attempts → upshift to Opus 4.8, note
  in `loop.log`): implement per the plan until the **fast gate is green** — vitest when available,
  else `tsc --noEmit` + `lint` + `build`, **always via `run_gate.sh`** (`-n` for a build-less
  inner-loop pass; never a bare `npm run build` in the integrated terminal — it can OOM-crash
  VS Code, see [05-gate-push.md](./05-gate-push.md)). Run `lint-fix` + `format` on changed files.
- **E2E author** (Sonnet) — **optional**: write/modify the affected Playwright spec(s) for the
  acceptance criteria (`playwright` skill + guide). Consume the **test-surface contract** from the
  plan (`decisions.md` / `criteria.md`) — the routes, `data-testid`s, and key ARIA labels were
  settled at Step 1 so the implementer and e2e author agree on the seams. Skip for trivial changes
  or when the e2e is heavier than the change warrants. This track **does not gate the
  implementer** — its specs run at the Step-5 gate, not in the inner loop.

## Pre-flight before any Playwright run — one script

Backend readiness (bounded, never spin) **and** the DB-snapshot check/seed are folded into the
bundled **`preflight.sh`**. Run it once before the first spec run:

```
preflight.sh
```

It probes the backend on :9000 (bounded — 10 tries, then `FAIL`, never an infinite spin), checks
`playwright:db-status`, seeds if missing, and prints one compact `PASS`/`FAIL` line per stage. On
`FAIL` (backend never came up), **STOP and prompt the user** — do not loop forever. See
`preflight.sh -h` for the seeding flags.

**Shared backend/DB across worktrees.** The backend :9000 and the Playwright DB are singletons, so
any ad-hoc spec run or between-spec DB restore must go through **`pw-lock.sh`** (the gate and
preflight already do internally). Wrap each as **one compound command per lock hold** — the lock's
restore-on-acquire gives you a clean DB, so an explicit restore is only needed for a bare run:

```
pw-lock.sh -- npx playwright test <spec>      # restore-on-acquire cleans the DB first
pw-lock.sh -- npm run playwright:db-restore    # ad-hoc isolation restore, if ever needed alone
```

A long wait here just means another worktree loop holds the lock — not a hang.

**UX hygiene while building:** if you touch `.tsx` files, apply the `care-ux-review` overflow/layout and a11y rubric as you write — build it right rather than fixing it at Step 4.8. Key points: `truncate`+`title` or `line-clamp` on variable text; `min-w-0` on flex children; accessible names on new interactive elements; `h-11` (44px) touch targets.

Inherits [working-agreement.md](./working-agreement.md) and [token-discipline.md](./token-discipline.md).
