# Token discipline (keep the loop cheap — it accumulates)

Input dominates (~99% of spend, re-read every turn); output is negligible. So the levers are
**model tier, context size, round-trips** — never output.

- **Tier the models — don't run everything on Opus.** Reserve **Opus** for judgment (plan,
  `care-review` lenses, feedback triage, test-grade). Run the mechanical majority on **Sonnet** —
  implement-to-green, running the gate/tests, applying triaged verdicts, parsing tool output. If
  the host can't set a subagent's model, switch the session to Sonnet for those phases. Model picks
  live in one place: [models.md](./models.md).
- **Never paste full terminal/tool output back into the model.** Write to a file, feed only the
  signal — `grep -E "fail|Error|✗|warning" | tail -20`, not 45 lines of passing tests. Pasted
  output is re-cached every turn. The bundled scripts (`run_gate.sh`, `preflight.sh`,
  `collect-feedback.sh`, `poll-pr.sh`) all print a compact digest for exactly this reason.
- **Delegate verbose work to subagents.** A subagent's file reads and tool dumps stay in *its*
  context; only its short summary returns — keeping the orchestrator's cached context small. Push
  implement / gate / triage / grade into summary-returning subagents.
- **One guide per spawned role.** The orchestrator spawns each subagent with only *its* role guide
  plus this file and [working-agreement.md](./working-agreement.md) — never the whole skill. The
  6b apply agent must never load 6a's collation mechanics, etc.
- **Batch multi-step ops into one script.** Gate = `run_gate.sh`; DB/backend pre-flight =
  `preflight.sh`; bot-feedback pre-digest = `collect-feedback.sh` — one round-trip each, not a
  dozen.
- **Keep the cache warm.** The prompt cache TTL is ~5 min; a long idle op (build, Playwright, DB
  reset) expires it and forces a full-context re-read at ~10× the cache-read rate. Run long ops as
  token-free `pgrep`/`sleep` waits (the bundled scripts do this) and keep active turns close
  together.
- **State file holds summaries, not dumps.** The run dir (`<skill-dir>/runs/<repo>-<branch>/`) is
  the loop's persistent memory — see [observability.md](./observability.md) for its schema.
