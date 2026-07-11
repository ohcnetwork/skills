# Step 2 — Fast specs, when they pay  (spawned role · Opus to design, Sonnet to write)

**Today** this repo has no fast unit layer (Playwright E2E only), so the orchestrator handles
trivial skips inline (see SKILL.md) and this step is only spawned when vitest is available.

- **When vitest is available**: write/modify the unit spec(s) covering the change's logic **first**;
  confirm a meaningful red. These are the fast TDD driver for Step 3.
- Playwright specs are **not** written here — they move to Step 3 as an optional track.
- Any specs written become the **regression gate** for Steps 5 and 7.

Inherits [working-agreement.md](./working-agreement.md) and [token-discipline.md](./token-discipline.md).
