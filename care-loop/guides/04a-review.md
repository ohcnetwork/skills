# Step 4a — Review, ours (spawned as **`care-reviewer`** · Opus 4.8, frontmatter-bound)

**Model self-check:** you must be Opus (judgment tier — [models.md](./models.md)). If you can tell
you're a smaller model, emit `BLOCKED: spawned on wrong model tier` to your agent log and stop.

Review mode per the SKILL.md tier table: `trivial` — a **single lens** (`care-technical-review`)
is enough; `standard` — full **`/care-review`** (lens-split); `complex` — `/care-review`, adding
**`thorough`** (Opus + GPT-5.5 ensemble) when the PR is also large (roughly: >10 changed files or

> 500 changed lines) or the user asked.

**Third lens when `.tsx` files are in the diff:** run **`care-ux-review` (static mode only)** as a
third parallel lens agent alongside the intent and approach agents. Return its findings to the
orchestrator alongside the other lens results: `Broken` → "Worth deciding"; `Polish` →
"Optional/FYI". This review stays browserless — live browser validation is Step 4c's job.

## Rounds 2+ — review the delta, not the full diff

After round 1, review **only the delta since `last_reviewed_sha`** (a `state.json` field the
orchestrator maintains). Invoke `care-review` with an explicit base ref:

```
/care-review --base <last_reviewed_sha>
```

If `care-review` does not accept a `--base` flag in this session, fall back to running
`care-diff-review` + `care-technical-review` directly, each with the base ref as the diff anchor
(`git diff <last_reviewed_sha>...HEAD`). A full branch-vs-develop re-review is wasteful when most
of the diff was already reviewed — the delta is just this round's fixes. Fall back to a full
re-review only when the delta is large (roughly: touches >50 % of the files in the full diff) or
the changes are structurally entangled.

## Consult `declined.md`

Before re-litigating any **own-review** finding that was already declined in an earlier round,
check `<run-dir>/declined.md`. A previously-declined finding is copied, not re-verified — unless
the code at that location changed this round. Log declined own-review findings there too (not just
bot findings) so later rounds skip them.

## Apply

Apply its **"worth deciding"** findings; log "Optional/FYI" items without acting unless trivial.

Inherits [working-agreement.md](./working-agreement.md) and [token-discipline.md](./token-discipline.md).
