---
name: care-intent
description: Reconstruct, from a CARE frontend (care_fe) diff alone, what each change does and the requirement it most plausibly fulfills, with a confidence rating per change. The intent-reconstruction core of /care-diff-review, extracted so it can run as a standalone maker-tier role and be graded by care-evals. Use when you need "what does this change do / why" from the code without a critique. For legibility + correctness findings on top, use /care-diff-review instead.
user-invocable: false
model: sonnet # maker tier — reconstruction is description, not judgment; the orchestrator pins the engine
---

# CARE Intent Reconstruction

**Premise: good code is self-readable.** A reader should be able to tell _what_ a change does and
_why_ (the requirement it fulfills) from the code alone — no commit message needed. This role
produces that reading and nothing else: no legibility tiering, no correctness pass, no critique
(those belong to `/care-diff-review`, which sources this same methodology as its Step 2).

**Form the reading from the code, blind.** Do not read the commit message, PR body, or branch name —
they are the answer key. When a caller needs the reconstruction cross-checked against a stated
description (the care-loop salvage gate), that comparison happens _outside_ this role, on the
reconstruction you return. You are given the diff; reason only from it.

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

<!-- /care-loop:methodology -->

## Output

Lead with the reconstructed intent for the change as a whole, then one _what + why + confidence_ per
distinct logical change. Default to the one-or-two-sentence form; a longer per-change summary only
when the diff is large or the caller asks. **Low-confidence lines are the important ones** — they are
where the code did not make its own intent legible, and (in the salvage flow) exactly what the human
gate must scrutinize.
