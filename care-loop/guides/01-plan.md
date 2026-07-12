# Step 1 — Plan (spawned as **`care-planner`** · Opus 4.8, frontmatter-bound · human gate lives in SKILL.md)

Agree the approach with the user and produce the plan the rest of the loop runs on. This is the one
step behind the human gate — SKILL.md owns the consolidated ask; you produce what that ask presents.

**You are a spawn, and you must be Opus (SKILL.md "Model enforcement"):** the orchestrator never
drafts the plan inline — it spawns you as the **named `care-planner` agent**, whose frontmatter
binds Opus (the harness applies it; an explicit model arg on a generic spawn is only the fallback
where the named agent doesn't resolve). **Self-check before Phase 1 anyway: you know your model** (the host's system prompt names it — Copilot's literally says
"state that you are using <model>"). If you are not Opus, emit `BLOCKED: planner spawned on wrong
model tier` to your agent log and stop — do not draft. If you are, **write `planned-by: <model>`
into `baseline.md`** — the consolidated ask surfaces it as the mandatory `Planned by:` line, so a
wrong-tier plan is caught at the human gate. (A live run drafted on Sonnet silently; it's a
defect, not a saving.)

Four phases, in order:

## Phase 1 — Recon

Recon before drafting anything — thoroughness per tier (skim / quick / thorough, see the SKILL.md
tier table). If your host lets a spawn spawn, delegate to a **read-only Explore subagent with an
explicit model arg** (a bare spawn inherits the session model — [hosts.md](./hosts.md)); if not
(the usual case — you are yourself a one-shot spawn), **do the recon yourself with read-only
tools**: confirm the actual files that will be touched, the nearest existing
pattern/component/hook to reuse, and existing Playwright specs covering the area. The plan must
cite **real paths** — `baseline.md` becomes a grounded estimate, not a blind prediction.

## Phase 2 — Interview (pre-plan grill)

Depth per tier: `trivial` — no separate interview, fold any open question into the consolidated
ask; `standard` — checklist-driven, uncapped; `complex` — exhaustive. Batched questions — keep
asking until every answer that would change the diff is settled. The only filter is "does the
answer change the diff?" **Relay mechanics:** as a one-shot spawn you may not be able to address
the user directly — **return the batched question list to the orchestrator**, which relays it to
the user and spawns you (Opus again) with the answers to fold in (SKILL.md "Model enforcement").
Frontend checklist to draw from (not exhaustive — skip what's obviously irrelevant):

- Empty / loading / error states
- Permissions / roles
- Mobile / responsive behavior — at 375, 768, and 1280px (the repo's xs/md/lg cut points); does
  any new text truncate/wrap correctly; does any new element meet the 44px touch target?
- Overflow / long-content — wherever the change renders user- or server-supplied text: is there
  `truncate` + `title`, `line-clamp`, `break-words`, or `min-w-0` on flex children?
- A11y — new interactive elements: accessible name, `focus-visible`, keyboard operability?
- i18n (new strings? which namespaces?)
- Reuse an existing component vs. build new
- Explicit **non-goals** (what this change deliberately does _not_ do)

If UI surfaces are touched, also settle **dev credentials** (`CARE_USERNAME` / `CARE_PASSWORD`) — ask once here if not already in env or `decisions.md`; write them there so Step 4c can reuse them without prompting mid-run.

## Phase 3 — Draft plan

Produce:

- **Scope, files, approach** — what changes and where (cite real paths from recon).
- **Acceptance criteria in testable terms** — what the user can _do/see_, stated so a spec can
  assert it. Make each criterion concrete and self-contained.
- **Non-goals** — from the interview; included in the plan so reviewers and later steps know the
  boundary.
- **Test-surface contract** — routes, `data-testid`s, key ARIA labels the e2e author needs. Settled
  here so the implementer and e2e author agree on the seams up front.
- **Change classification — the effort tier** (defaults + what each tier sets: SKILL.md tier
  table; the user may have passed a tier at invocation — confirm or correct it):
  - `trivial` — ≤20 changed lines, UI-only default/ordering/cosmetic, **no** new component, route,
    or API interaction. Unlocks the test skip.
  - `standard` — everything between: contained feature work in a familiar area.
  - `complex` — new cross-module behavior, new route + API interaction, contract/state-management
    changes, an unfamiliar area, or real plan uncertainty after recon.

## Phase 4 — Follow-up round

Any decisions or ambiguities surfaced _by drafting_ go back to the user **before** the consolidated
ask (**mandatory** for `complex`; as-needed for `standard`; skip for `trivial`). This is not a
second gate — it's "drafting raised X, which way?" Then fold the answers in.

## Persist to the run dir (`<skill-dir>/runs/<repo>-<branch>/`)

The run dir is the loop's single persistence location — the orchestrator derives it from the repo
basename + current branch (see [observability.md](./observability.md)); never invent an ad-hoc
path. Before handing back:

1. **`criteria.md`** — the acceptance criteria, one per line/bullet, phrased as testable
   statements. If the change touches UI, at least one criterion must describe breakpoint behavior
   (e.g. "renders without overflow at 375px").
2. **`ui-surfaces.md`** — **only when the diff touches `src/**/*.tsx`\*\*: list of surfaces for
   Step 4c to validate. For each entry: the route (or "N/A — component-only"), how to navigate
   to it, whether login is required, and any long-content stress candidate (a field that renders
   variable-length text). Also list every other file that imports a changed *shared\* component
   (grep consumers under `src/`). Format:
   ```
   ## Changed surfaces
   - route: /patient/:id/appointments  reach: Login → Patients → open record → Appointments tab  auth: yes
   ## Sibling surfaces (consumers of changed shared components)
   - route: /facility/:id/resource-map  file: src/pages/FacilityResourceMap.tsx  auth: yes
   ## Long-content stress
   - ActivityDefinition name field (max: none; inject 60-char string)
   ```
   If no `.tsx` files are touched, omit this file entirely.
3. **`baseline.md`** — the **scope baseline** for the Scope Governor
   ([governance.md](./governance.md) §1): request, target branch, owner boundary, planned files,
   planned non-test LOC — plus **`planned-by: <model>`** (your self-identification; feeds the
   mandatory `Planned by:` line in the consolidated ask). **Grounded** by recon — cite the real
   files you confirmed, not a guess.
4. **`decisions.md`** — the interview Q&A + non-goals. Later steps (especially 6a triage) can cite
   a recorded decision to decline a finding without re-verification.

_(`state.json` is the orchestrator's — you don't write it.)_

## Hand back

Return the plan, the criteria, and the classification to the orchestrator for the single
consolidated ask. Do **not** push, branch, or edit — no approval yet.

Inherits [working-agreement.md](./working-agreement.md) and [token-discipline.md](./token-discipline.md).
