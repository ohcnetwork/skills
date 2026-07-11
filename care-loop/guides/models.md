# Models (single source — care-loop internal)

Concrete picks — overridable at invocation; update **this file** when availability changes. The
SKILL.md dispatch table and the `runSubagent` enforcement note in [hosts.md](./hosts.md) both point
here. **The enforced copies live in the named-agent frontmatter** — a model refresh edits this
file **and** the five agent definitions
(`agents/claude/care-{planner,reviewer,test-grader,ux-validator,triager}.md`), then regenerates the
`agents/copilot/*.agent.md` variants with **`sync-agents.sh`** (never hand-edit them; the Claude
body is the source, `sync-agents.sh --check` verifies they haven't drifted).

_(Care-loop-internal only. `care-review` keeps its own Models block — skills stay independently
usable.)_

| Phase                | Model                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| 1 Plan               | **Opus 4.8**                                                                                     |
| 2 Tests-first        | **Opus 4.8** (case design) / Sonnet 4.6 (write)                                                  |
| 3 Implement to green | Sonnet 4.6 (`trivial`/`standard`); **Opus 4.8** (`complex`, or after the escalation valve fires) |
| 4 Review             | **Opus 4.8** (+ **GPT-5.5** only in `thorough` — `complex` + large PRs)                          |
| 4.5 Test-grade       | **Opus 4.8** (checker ≠ Step-3 maker)                                                            |
| 4.8 UX-validate      | **Opus 4.8** — skipped when no `.tsx` files changed                                              |
| 5 Gate + push        | Sonnet 4.6 / script                                                                              |
| 6a Collate + triage  | **Opus 4.8**                                                                                     |
| 6b Apply verdicts    | Sonnet 4.6 — the verdict list is the instruction                                                 |

The **bold Opus** rows stay on Opus (judgment); everything else spawns on Sonnet 4.6 (mechanical).
**Why these are enforced and not advisory — the router-never-judges doctrine, the named agents,
the fallback ladder, and the `planned-by:` attestation — is stated once in SKILL.md "Model
enforcement"; this file owns only the picks** (don't restate the doctrine here).
The effort tier is set at Step 1 (SKILL.md tier table) and recorded in `state.json`; the
**escalation valve** (two failed gate attempts on `standard` → upshift implementation to Opus 4.8,
one-way) is the safety net for running standard work on Sonnet. The ensemble second opinion
(`thorough` only) uses **GPT-5.5**. Host mechanics (Copilot `runSubagent` / Claude Code `Task`
model arg) live in [hosts.md](./hosts.md).
