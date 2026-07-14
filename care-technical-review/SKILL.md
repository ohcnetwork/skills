---
name: care-technical-review
description: Review a CARE frontend (care_fe) diff for approach quality — is this the simplest solution to the problem, or overengineered? Suggests simplifications, reuse of existing components/hooks/utils, and minimal refactors. The "approach" lens of /care-review (can run standalone). Use for "is this overengineered", "simpler way to do this", "clean this up", "suggest refactors/simplifications", "is it worth a new hook/component/abstraction". Judges proportionality to the problem; favors less code, not more.
user-invocable: true
argument-hint: "[develop | commit | working | <file>]"
model: opus # declared judgment tier — honored by the invoker (see care-review "Models"), not auto-enforced
---

# CARE Technical Review

Judge the _approach_, not just whether it works. A change can technically solve the problem and
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

<!-- care-loop:methodology name="default" -->

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

### Simplification — the three cases

Not all redundancy is the same. Use this decision tree to distinguish what should be simplified:

**Case 1: Mirrored state** (a local state that equals a prop)
```
❌ Redundant: const [name, setName] = useState(props.name)
✅ Fix: Delete the state, read props.name directly
```
Action: Always eliminate.

**Case 2: Computed/derived value** (a state that could be derived from other state/props)
```
❌ Redundant: const [total, setTotal] = useState(0); useEffect(() => { setTotal(a + b) }, [a, b])
✅ Fix: const total = a + b; (compute at render time, or useCallback if deps are stable)
```
Action: Eliminate unless the derivation is genuinely expensive (rare).

**Case 3: Cache** (a state that duplicates server data for performance)
```
✌️ Keep it: const [cachedUser, setCachedUser] = useState(null); // avoid refetch on tab focus
```
Action: Keep ONLY if the cache invalidation is correct (and document why). Flag if cache is stale or never cleared.

**Reuse decision:**
- A sibling component/hook/util already does _this exact problem_? **Reuse it** (call or extend).
- Two things are _similar but solve different problems_? **Don't merge** — false reuse creates confusion. Keep them separate.

**Remove redundancy:**
- Dead branches (unreachable code)
- Duplicate logic (same code in two functions)
- Superfluous conditions (a check that's always true)
- Needless casts (e.g., `as any` when you could use a real type)

**Collapse needless `useEffect`/`useMemo`/`useCallback`:**
- `useEffect` — only when something external must be kept in sync (API, timer, storage). Derived state should not be in useEffect.
- `useMemo`/`useCallback` — only when the identity is consumed by a memoized child, an effect dep, or guards real cost (expensive calculation, not string concatenation).

### Efficiency — only where it's real

Flag only genuine efficiency costs, not principle-based optimizations. Use concrete thresholds:

**What counts as real efficiency (worth fixing):**
- **N extra network queries** on a common flow. Measure: How many extra queries in a typical user session? If >2 on a frequent path (patient search, order entry), flag it.
- **Render churn:** a component re-renders 100+ times unnecessarily in a single interaction (measure via React DevTools Profiler).
- **DOM bloat:** the change adds 1000+ DOM nodes when 100 would suffice (measure with `document.querySelectorAll('*').length`).
- **Bundle size:** adding 50+ KB to the shipped bundle when an equivalent exists in the repo.
- **Cache invalidation bugs:** a refetch that should use cached data but doesn't (data freshness issue, not just extra work).

**What's NOT real efficiency (skip):**
- "This function does two things instead of one" — code clarity is different from efficiency.
- "We could cache this" without measuring cache-hit rate — premature optimization.
- Reducing 5ms to 3ms in an uncommon flow — imperceptible to users.
- Combining two hook calls into one — no measurable performance gain if each already runs once per render.

**Measurement hints:**
- Network: check the Network tab; count `fetch` calls for the user action.
- Render: React DevTools Profiler → check component render count / duration.
- DOM: open browser DevTools Console, run `document.querySelectorAll('*').length`.
- Bundle: use `source-map-explorer` or webpack-bundle-analyzer on the build output.

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

<!-- /care-loop:methodology -->
