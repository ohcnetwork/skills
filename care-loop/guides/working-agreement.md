# Working agreement (inherited by every agent in the loop)

Smallest possible diff — no scope creep, no adjacent "improvements". Don't change a component's
contract or invent logic to paper over a problem. Less code, not more. New code reads like the
file around it (`CLAUDE.md`): i18next strings in `public/locale/en.json`, `query()`/`mutate()`
wrappers, maps over enums, one component per file.

Scope is not just a style preference here — it is enforced. See [governance.md](./governance.md)
for the numeric scope tripwire, the convergence guard, and verify-before-accept.

## Agent log markers

Write structured lines to `<run-dir>/agents/<your-role>.log`. These markers are what the watchdog
(`watch-agents.sh`) reads — without them a stuck agent is a silent hang, not a prompt:

- `HEARTBEAT <iso-ts>` — periodic; **always one right before starting a long command** (build,
  Playwright, DB reset). The agent can't write mid-command, so the heartbeat keeps the stall
  check quiet. For extra coverage, **tee long-command output** into the run dir (e.g.
  `<run-dir>/agents/`) so the watchdog sees file-mtime activity even while you're blocked.
- `STATUS: <what it's doing>` — on each meaningful step.
- `NEEDS_INPUT: <question>` — when you need a human decision.
- `BLOCKED: <reason>` — when you can't proceed (e.g. `BLOCKED: backend not up on :9000`).
- `DONE` — when finished.

## Mid-run skill changes — a running session keeps the old contract

A loop session started **before** a care-loop skill change does **not** auto-adopt the new
scripts or rules — the guides were read into context when the run began. At each round boundary,
re-read the step guide you're about to run; if a helper the current step needs
(`poll-pr.sh`, `write-state.sh`, `collect-feedback.sh`, `run_gate.sh`) postdates the run, prefer
[00-resume.md](./00-resume.md) re-entry in a fresh session over limping on the old contract. A
session that keeps hand-polling / hand-writing state after the fix shipped will stall exactly the
way the fix was meant to prevent.
