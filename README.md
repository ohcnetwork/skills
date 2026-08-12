# Skills

A collection of [agent skills](https://code.visualstudio.com/docs/copilot/customization/skills) — self-contained folders, each with a `SKILL.md`, that teach a coding agent how to do a specific task. Most are tailored to the [CARE](https://github.com/ohcnetwork) codebases.

## Installing

Agents discover skills from `~/.agents/skills/` (VS Code Copilot) or `~/.claude/skills/` (Claude Code). Install by symlinking the skills you want into one of those directories, so `git pull` keeps them current.

See **[INSTALL.md](INSTALL.md)** for step-by-step instructions — written so an agent can do the install for you.

## Skills included

| Skill | What it does |
| --- | --- |
| [care-review](care-review/SKILL.md) | Full review of a CARE frontend diff via two parallel lenses (intent/legibility + approach), condensed into one report. |
| [care-diff-review](care-diff-review/SKILL.md) | Reconstructs *what* a diff does and *which requirement* it fulfills from the code alone, flagging where the code fails to make that legible. The intent lens of `care-review`. |
| [care-technical-review](care-technical-review/SKILL.md) | Judges a diff's *approach* — is it the simplest solution or overengineered? Suggests simplifications and reuse. The approach lens of `care-review`. |
| [care-sql-code-review](care-sql-code-review/SKILL.md) | Reviews raw analytics SQL (`care_analytics_sql`) for correctness, performance, and maintainability against the CARE Postgres schema. |
| [care-report-templates](care-report-templates/SKILL.md) | Reference for authoring Jinja2 report templates in the CARE EMR — context variables, filters, globals, and patterns. |
| [playwright](playwright/SKILL.md) | Write, debug, and run Playwright E2E tests for CARE, with a bundled guide and example specs. |

Each skill's `SKILL.md` describes exactly when the agent should invoke it and how it behaves.

## Adding a new skill

Create a new top-level directory with a `SKILL.md` inside it. Once symlinked (or after re-running the install snippet in [INSTALL.md](INSTALL.md)), agents will discover it automatically.
