# Step 6b — Apply the verdicts  (spawned role · Sonnet 4.6)

Spawned with **only the path** `<run-dir>/verdicts.md` — read it; that verdict list is
your full instruction. You do **not** load the 6a collation mechanics.

## Apply

- **Idempotent re-entry:** you may be resumed after a crash mid-apply. Before applying an `address`
  item, **check whether it's already applied** (the edit is present in the working tree) and skip
  it if so — the tree diff is the record. Never re-apply on top of existing edits.
- Apply **only** the `address` list — minimal diffs, no scope creep.
- If a fix changes behavior the specs assert, **update the affected spec first** (keep the
  regression gate honest), then implement.
- **Bug-class fix rule:** when an `address` item is tagged as a bug class, fix the in-scope siblings
  in the same round ([governance.md](./governance.md) §4) — don't leave known-identical bugs behind.
- `defer-to-human` items go in the round summary, **not** the code. `decline` items are not
  implemented.

## Stage a reply for every inline thread — required, a round isn't done without it

**Don't post replies here** — a "fixed" reply must reference a commit that's actually on the PR,
and the push happens at Step 5. Instead write **`<run-dir>/replies.md`**, one entry per thread:

```
- thread <comment_id> · fixed — <what/where; Step 5 appends the pushed commit SHA>
- thread <comment_id> · declined — <the reason from the 6a verdict>
```

Step 5 posts every entry right after the push (declined-only rounds post without one) and archives
the file — see [05-gate-push.md](./05-gate-push.md). Every `address` and `decline` verdict must
have an entry; a thread with no staged reply blocks the round.

Inherits [working-agreement.md](./working-agreement.md) and [token-discipline.md](./token-discipline.md).
