# Governance — scope discipline & anti-thrash (shared)

Referenced by the step guides below; makes [working-agreement.md](./working-agreement.md)
enforceable rather than qualitative.

## 1. Scope Governor  (freeze at Step 1 — [01-plan.md](./01-plan.md))

Freeze a **scope baseline** at Step 1 and write it to `baseline.md` in the run dir
(`<skill-dir>/runs/<repo>-<branch>/` — [observability.md](./observability.md)): the request,
target branch, owner boundary, planned files, planned non-test LOC.

**The baseline is the plan's *predicted* estimate — there is no diff at Step 1, so do not go
hunting for a baseline diff; it does not exist.** The estimate is what you compare later rounds'
real diff against.

**Numeric tripwire:** once a diff exists, if it exceeds **~2×** the baseline's planned files or
non-test LOC **without approval → stop and reclassify.** Do not silently keep expanding.

**Tripwire fires → one consolidated re-approval ask** (the only second gate, exceptional): present
the current scope vs. baseline, and offer two options: (a) approve a **new baseline** (expand scope
with explicit sign-off) or (b) **shrink scope** by deferring the excess to a follow-up. This ask
replaces the next code edit — no changes until the user answers.

The **only** thing that justifies expanding scope past the tripwire is a **critical exception**:
active data loss · a crash · broken install/upgrade · a release blocker · a concrete security
exposure. Anything else that grows scope is a follow-up.

Maps to verdicts (Step 6a): an in-scope blocker = `address`; a follow-up or a stop-and-escalate =
`defer-to-human`.

## 2. Convergence guard  (Step 7 loop logic in `SKILL.md` points here)

Complements the max-5 iteration cap. After **two** non-converging fix cycles (findings not
shrinking, or the same area churning), **pause and reclassify** the remaining findings before
another edit. No speculative fixes just to satisfy a reviewer. Keep exploratory edits local until
proven in-scope. This also bounds the Step-4.5 → Step-3 `Wrong`-spec loop-back.

## 3. Verify-before-accept  (Step 6a — [06a-triage.md](./06a-triage.md))

Verify each bot/review finding against the **real code path + adjacent files** before accepting it.
Reject unrealistic edge cases, speculative risks, and broad rewrites (this is what catches
Greptile/CodeRabbit false positives). A finding is only `address` after you've confirmed it against
the actual code, not just the bot's description.

## 4. Bug-class siblings  (verdict in [06a-triage.md](./06a-triage.md); fix rule in [06b-apply.md](./06b-apply.md))

When an accepted finding reveals a **bug class** (not a one-off), fix the **in-scope** siblings in
the same round — the "other usages" check is a fix rule, not just a flag. Siblings that fall
outside the scope baseline are `defer-to-human`, not silent expansion.
