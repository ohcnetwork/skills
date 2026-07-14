---
name: care-diff-review
description: Reconstruct, from the code alone, what a CARE frontend (care_fe) diff does and what requirement it fulfills, and flag where the code fails to make that legible. The intent/legibility lens of /care-review (can run standalone). Use for "what does this change do", "is this readable / self-explanatory", "reconstruct the intent", or to verify a refactor is behavior-preserving. Defaults to diffing against develop; suggests rather than edits. For a full review (intent + approach), use /care-review instead.
user-invocable: true
argument-hint: "[develop | commit | working | <file>]"
model: opus # declared judgment tier — honored by the invoker (see care-review "Models"), not auto-enforced
---

# CARE Diff Review

**Premise: good code is self-readable.** A reviewer should be able to tell _what_ a change does
and _why_ (the requirement it fulfills) from the code alone — no commit message needed. This
skill reconstructs that intent from the diff, surfaces every place the code failed to convey it,
and confirms the reconstruction with the user. Wherever the reading was hard, that's the finding.

<!-- care-loop:methodology name="default" -->

## Working agreement (applies throughout)

1. **Suggest first, don't edit.** Propose changes; apply only after explicit approval.
2. **Smallest possible diff.** Fix the issue and nothing adjacent. Anything out of scope goes in
   a one-line _Out of scope_ note, not into the working tree.
3. **Don't change the contract or invent logic** to paper over something. Diagnose the cause; if
   you don't understand why existing code is the way it is, ask — don't rewrite it.
4. **Match the codebase** — new code reads like the file around it (`CLAUDE.md`).
<!-- /care-loop:methodology -->

## Step 1 — Get the diff (default: against develop)

> **Dispatched by `/care-review`?** The scope is already resolved — read the provided
> `/tmp/care_review.diff` and skip this step. Don't re-run git.

Default scope is everything this branch changes relative to `develop` (committed + uncommitted).
Write it to a temp file and read that (inline terminal output truncates on large diffs):

```
git diff $(git merge-base develop HEAD) > /tmp/care_review.diff && wc -l /tmp/care_review.diff
```

Override only when explicitly asked:

| User says                          | Command                          |
| ---------------------------------- | -------------------------------- |
| "against the last/previous commit" | `git show HEAD`                  |
| "unstaged / working changes only"  | `git diff` + `git diff --staged` |
| a specific file ("only this file") | scope the diff to that path      |

**List the changed files first**, then review only those (read an unchanged file only if a
finding needs its context). **Do not read the commit message, PR body, or branch name yet** —
they're the answer key. Form your reading from the code, then optionally cross-check against them
at the end.

<!-- care-loop:methodology name="default" -->

## Step 2 — Reconstruct the intent from the code

For the diff as a whole, and for each distinct logical change, state plainly:

- **What it does** — the behavior change, in one or two sentences.
- **Why** — the requirement or problem it most plausibly fulfills, inferred from the code.
- **Confidence** — _high_ if the code makes it self-evident; _low_ if you had to guess.

Reason from _this_ code in _this_ file. Read the actual control flow and data flow — don't
pattern-match to a catalog of known bugs.

### Intent reconstruction mini-checklist

Before settling on a reconstruction, verify these structural facts. They're not required for every change, but they'll catch gaps:

- **Entry point** — where does the change activate? (component mount? event handler? API call? conditional branch?)
- **Exit point** — what's the observable outcome? (render output? state change? side effect? API request?)
- **Shared state touched?** — does it modify local state, props, context, or server state? (impacts other consumers)
- **Fallback/edge paths** — are there conditional branches the change introduces? (happy path + error/empty cases?)
- **Scope shift** — does this change affect other files or does it stay local? (shared component → check siblings)

**Example reconstruction checklist:**

```
Change: Add a "low stock" warning banner to the inventory list

✓ Entry: Component mounts with `items` prop
✓ Exit: Banner rendered above list if any item.stock < 10
✓ State: None (reads props, no local state or context)
✓ Fallback: Empty inventory → no banner; all items in stock → no banner
✓ Scope: Isolated to InventoryList.tsx (no siblings affected, only this component renders the banner)

Confidence: HIGH — straightforward conditional render, no surprises
```

This checklist doesn't change your output (still one or two sentences), but it ensures you didn't miss a multi-file scope or an important edge case.

## Step 3 — Legibility gaps (the core output)

Every spot your confidence dropped is a place the code isn't self-documenting. Flag it and give
the **minimal** change that would make the intent legible:

- **Misleading / vague names** → intention-revealing rename (a function should say what it does:
  `releaseLocation` → `markLocationAsReserved`).
- **Purpose not evident from surrounding code** → smallest restructure (extract / split / move)
  that makes it self-explanatory. Add a comment _only_ where naming can't carry the meaning —
  a non-obvious "why", a BE quirk, a guarded edge case.
- **Fat handlers / mixed flows** → split so each path reads top-to-bottom and can be debugged in
  isolation.

Keep every suggestion legibility-sized, not a rewrite. The bar is: _would another dev understand
this change, and the requirement behind it, by reading it cold?_

### Tier your findings for routing

Organize legibility findings by severity so care-loop can route them appropriately:

**`Broken` (blocks understanding — loop routes to Step 3 re-implement)**
- Code is actively misleading (a function name says "release" but does "reserve"; a comment describes old behavior)
- Intent is illegible despite reasonable effort to reconstruct (control flow is convoluted, no clear entry/exit points)
- A rename or small restructure is the minimal fix

**`Convention` (repo style — loop notes in round summary)**
- Violates a documented pattern in `CLAUDE.md` or the repo's conventions
- Example: event handlers should cite the event + expected side effect, per CLAUDE.md section 3.2
- Fix is straightforward once the rule is known

**`Polish` (optional — advisory only)**
- Minor readability improvements that are good-but-optional
- Extracting a loop to a named function when names already carry it
- Inline comments that could be refactored but the code is already legible

### Secondary — correctness

While reading, if the code plainly can't fulfill the intent it implies, flag it: a logic/edge-case
error, or a regression in the **other usages** of a shared component/hook/util/route the diff
touched (always check those). Only concrete, evidenced issues — no speculation.

### Refactor-safety mode

If the diff is described as "just readability / renaming / nothing should change", the headline is
a yes/no on behavior preservation. Classify every hunk as rename / move / reformat / extract
(safe) vs. anything that alters control flow, conditions, data sent to BE, effect timing, or
render output (flag loudly, however small).

<!-- /care-loop:methodology -->

## Step 4 — Confirm with the user

> **Dispatched as an agent by `/care-review`:** reconstruct intent **independently** from
> `/tmp/care_review.diff`, then **return** your reconstructed intent + legibility/correctness
> findings to the orchestrator. Do **not** confirm with the user — the orchestrator reconciles
> your intent reading against the other agent's and owns the single confirm.
>
> **Loop-invoked** (the `/care-review` call came from `care-loop`, signalled by a run dir
> `<care-loop skill dir>/runs/<repo>-<branch>/`):
> additionally write your **full** intent reconstruction — the complete per-change _what + why_,
> not the 1–2 sentence condensed version — to `<run-dir>/intent.md`, so Step 4b
> (`care-test-grade`) can grade the specs against it without a second reconstruction. Standalone
> invocations are unchanged — write nothing extra.

Lead with the reconstructed intent: _"Here's what I read the change as doing, and the requirement
I think it fulfills — is that right?"_ A mismatch means either the code isn't legible (fix the
code) or there's a latent bug (fix the logic) — resolve which. Then list legibility gaps and any
correctness finding, each `file:line` + minimal fix, ending with a one-line _Out of scope_ note.

Producing a full requirements doc is usually overkill — default to the one-or-two-sentence intent
per change. Only emit a longer per-change requirements summary if the user asks or the diff is
large. **Don't edit until approved.**

### Care-loop integration (Step 4a orchestrator)

When invoked by care-loop (Step 4a), tier your findings so the orchestrator can route them:

```
## Legibility findings

**Broken (blocks understanding)**
- <finding> → <minimal fix> (file:line)

**Convention** (repo style)
- <finding> → cite: <CLAUDE.md section> (file:line)

**Polish** (optional)
- <finding> (minor improvement)
```

- **Broken** findings loop back to Step 3 (implementer re-codes for legibility)
- **Convention** findings are noted in the round summary (fix if time permits)
- **Polish** findings are advisory (not loop-back candidates)

<!-- care-loop:methodology name="default" -->

## Reference — what "legible CARE code" looks like

Use these to judge whether a change reads idiomatically (so intent is obvious), not as a
mandatory checklist. `CLAUDE.md` / `.cursorrules` win on conflict.

- **TypeScript** — no `any`/implicit-any; prefer a real type or guard over an assertion;
  `interface` for objects; **maps over enums**; `null`/`undefined` explicit and matching the BE
  shape (`X | None` → `X | null`); specific generic constraints; exhaustive discriminated unions.
- **React** — `useEffect` is a smell (prefer derived state / event handlers; comment the ones
  that are genuinely external); `useCallback`/`useMemo` only when identity is consumed by a
  memoized child, an effect dep, or guards real cost — don't wrap trivial handlers; state as
  local as possible; React 19 refs are regular props (no `forwardRef`); compose
  `src/components/ui` (shadcn — don't modify) + `CAREUI` before inventing a component; one
  component per file.
- **Conventions** — user-facing strings via i18next → `public/locale/en.json`; API through
`query()`/`mutate()` wrappers + `{domain}Api.ts` route objects (`silent: true` to suppress
toasts); mobile = Drawer, desktop = Popover; truncation needs `min-w-0` on the constrained
parent + `truncate`; plugin-support changes shouldn't duplicate the core flow.
<!-- /care-loop:methodology -->
