---
name: care-technical-review
description: Review a CARE frontend (care_fe) diff for approach quality — is this the simplest solution to the problem, or overengineered? Suggests simplifications, reuse of existing components/hooks/utils, and minimal refactors. The "approach" lens of /care-review (can run standalone). Use for "is this overengineered", "simpler way to do this", "clean this up", "suggest refactors/simplifications", "is it worth a new hook/component/abstraction". Judges proportionality to the problem; favors less code, not more.
user-invocable: true
argument-hint: "[develop | commit | working | <file>]"
---

# CARE Technical Review

Judge the *approach*, not just whether it works. A change can technically solve the problem and
still be the wrong solution — overengineered, redundant, or reinventing something the repo already
provides. The yardstick is **proportionality**: the simplest change that fully solves the problem
at hand, nothing more.

## Inputs

- **The diff** — default is written to a temp file and read from there (inline terminal output
  truncates on large diffs): `git diff $(git merge-base develop HEAD) > /tmp/care_review.diff`.
  Overrides: last commit (`git show HEAD`), working only (`git diff` + `git diff --staged`), or a
  named file.
- **The problem being solved** — you cannot judge overengineering without it. Reconstruct the
  intent briefly from the code first.

> **Dispatched as an agent by `/care-review`?** Read the already-resolved `/tmp/care_review.diff`
> (don't re-run git), reconstruct intent **independently** (no commit message), then **return**
> your approach findings to the orchestrator. Do **not** confirm with the user — the orchestrator
> owns the single confirm and reconciles your reading against the other agent's.

## Working agreement

- **Suggest, don't edit** until approved.
- **Every suggestion must reduce or hold complexity** — less code, fewer moving parts. Never
  propose an abstraction bigger than the problem warrants.
- **Minimal diff** — a review is not a rewrite. Prefer "modify this one file" over "new file".

## What to look for

### Overengineering — flag, then give the simpler alternative
- Premature abstraction / generality with a single caller; options, flags, or config nothing uses yet.
- A new component / hook / context / reducer / effect / state where a derived value, an existing
  component, or a plain function would do.
- A new file when editing an existing one is smaller and clearer.
- Props or flags multiplying to thread behavior — can related props collapse into one object, or
  can the branch be derived from existing data instead of passed?
- Hand-rolling what the stack already provides: shadcn `src/components/ui` + `CAREUI`, `cmdk`
  filtering, `zod`, the `query()`/`mutate()` wrappers, `useFilters`, existing `Utils`.

### Simplification — suggest
- **Derive instead of store** — drop state that mirrors props, other state, or server data.
- **Reuse** — a sibling component/hook/util already does most of this; extend or call it rather
  than duplicate. (Only merge two things if they're genuinely the same problem — not just similar.)
- **Remove redundancy** — dead branches, duplicate logic, superfluous conditions, needless casts.
- **Collapse needless `useEffect`/`useMemo`/`useCallback`** that buy nothing.

### Efficiency — only where it's real
- Redundant network/query work — e.g. a plugin-support path re-fetching what the core flow already
  has, duplicate queries, or a refetch where the cache / `setQueryData` suffices.
- Re-renders only when they cause measurable cost, not on principle.

## Guardrails (calibration)

- **Bias hard toward less code.** But simplifying isn't enough if it removes behavior or
  flexibility that's actually used — don't trade a real use case for a smaller diff.
- **Don't import new patterns/packages** to simplify something the repo already solves its own way.
- **"No changes warranted" is a valid result.** If the approach is already proportionate, say so
  plainly. Don't manufacture refactors.

## Output

Lead with a one-line verdict: is the approach proportionate, or is there a simpler one? Then each
suggestion as — what's heavier than it needs to be, the simpler alternative, and the rough
diff-size delta (should trend negative), with `file:line`. Don't edit until approved.
