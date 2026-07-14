---
name: care-ux-review
description: UI/UX review of a CARE frontend (care_fe) diff — overflow, layout integrity across breakpoints, a11y, and Tailwind/component conventions. Two modes: static (diff-only, always runs) and live (browser via Playwright MCP, when configured). Validates the changed surfaces plus every sibling consumer of a changed shared component. Use for "review UI changes", "check layout", "a11y review", "does this break at mobile". Also dispatched as a third lens by /care-review (static only) and by care-loop Step 4c (live+static). Tiered output: Broken / Convention / Polish.
user-invocable: true
argument-hint: "[develop | commit | working | <file>] [live]"
model: opus  # declared judgment tier — honored by the invoker (see care-review "Models"), not auto-enforced
---

# CARE UX Review

You are the UI/UX engineer lens for a **hospital EMR**: does this render correctly across screen sizes **down to small/old ward phones**, does it break any sibling surfaces, and — because **clinician time is patient-care time** — is it **efficient to use** (no needless screens or taps for routine actions)? **Static mode** always runs (diff-based). **Live mode** adds browser validation via Playwright MCP when the tools are present — never silently skip it; always state which mode you're running in the output header.

<!-- care-loop:methodology name="static" -->

## Severity tiers (use these labels verbatim)

- **`Broken`** — overflow escapes its parent; content unusable or clipped at a breakpoint; a sibling element displaced or overlapped; a new interactive element has no accessible name. **Blocks the push in care-loop.**
- **`Convention`** — violates a documented care_fe rule. **Always cite the instruction file.**
- **`Polish`** — FYI; advisory only.

Calibration: judge only the changed surfaces and their direct siblings. Unchanged code is out of scope. A clean result is valid — don't manufacture findings.

## Repo conventions (cite these files; don't invent rules)

- **`CLAUDE.md`** — typing, import order; all user-facing strings via i18next (`public/locale/en.json`, append-only).
- **`.github/instructions/careui.instructions.md`** — ARIA on medical data, keyboard nav, WCAG AA contrast, **44px minimum touch targets**.
- **`.github/instructions/react-components.instructions.md`** — shadcn/ui + CAREUI medical components; `cn()` from `src/lib/utils.ts`; CVA for variants; `focus-visible:ring-1` focus states.
- **`.github/instructions/pages.instructions.md`** + **`src/hooks/useBreakpoints.ts`** — mobile-first; breakpoints xs 480 / sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536.
- **`tailwind.config.js`** — color tokens (primary `#0d9f6e`); never hardcode colors inline.
- Overflow idioms in this repo: `truncate` (+ `title` attribute for hover), `line-clamp`, `break-words`, `min-w-0` on flex children, `overflow-hidden` on containers.
<!-- /care-loop:methodology -->

## Step 0 — Resolve the diff

Write the diff to a temp file and read from there (inline terminal output truncates on large diffs):

```bash
git diff $(git merge-base develop HEAD) > /tmp/care_ux.diff
```

Overrides: last commit (`git show HEAD`), working only (`git diff` + `git diff --staged`), or a named file. List the changed `.tsx` files. Identify which are **shared components** (imported by files outside their own directory) — these drive the sibling-surface list.

> **Dispatched as an agent by `/care-review` or `care-loop`?** The diff file path is already resolved and passed in the prompt — read it directly, do not re-run git. Return findings to the orchestrator; do **not** confirm with the user.

<!-- care-loop:methodology name="static" -->

## Mode 1 — Static lens (always runs)

Read the diff and apply this rubric:

### Overflow / layout

For every place user-supplied or server-supplied text is rendered:

- Is there a `truncate` (with `title` for full text on hover), `line-clamp`, or `break-words`?
- Are flex children given `min-w-0`? (Without it, a flex child can grow past its container.)
- Are containers given `overflow-hidden` or `overflow-auto`?
- Does any newly-added fixed width (e.g. `w-64`, `w-[300px]`) risk breaking at a narrow viewport?
  **Validate down to the smallest supported device — 320px** (older/small Android, iPhone SE-class),
  not just 375px: a fixed width — or a width **plus** horizontal padding — that exceeds ~320px
  overflows there even when it looks fine at 375/flagship. Care runs on whatever phone is on the
  ward. Prefer fluid widths (`w-full` + `max-w-*`) over any `w-[…px]` ≥ 320.
- Does any `absolute`-positioned element risk escaping its clipping parent at narrow widths?

### Conventions

- Tailwind color tokens only — no hardcoded hex/rgb; primary is `#0d9f6e` via the token. **Cite `tailwind.config.js`.**
- `cn()` for conditional class merging — not template literals or `clsx` alone. **Cite `react-components.instructions.md`.**
- CVA for multi-variant components. **Cite `react-components.instructions.md`.**
- shadcn/ui or CAREUI primitives before hand-rolling — check `src/components/ui/` and `src/components/CAREUI/`. **Cite `react-components.instructions.md`.**
- `useBreakpoints` for responsive logic branches (not inline `window.innerWidth` checks). **Cite `pages.instructions.md`.**
- i18next keys, not string literals, for user-facing text. **Cite `CLAUDE.md`.**

### A11y

Per **`.github/instructions/careui.instructions.md`**:

- New interactive elements (`<button>`, `<input>`, `<select>`, custom clickable divs): do they have a role + accessible name (`aria-label`, `aria-labelledby`, or associated `<label>`)?
- Validation states: `aria-invalid` present when the field is invalid?
- Icon-only controls: `sr-only` span or `aria-label`?
- Keyboard operability: custom click handlers also handle `onKeyDown` / `onKeyPress` (Enter/Space)?
- Focus states: `focus-visible:ring-1` present on new interactive elements?
- Touch targets: new interactive elements ≥ 44×44 CSS px? (Check height class — `h-11` = 44px.)

### Workflow efficiency (hospital context)

Judge the change as a clinician using it under time pressure on a shared ward device — **every extra
screen, tap, or navigation step for a routine action is time taken from patient care.** Flag when the
diff:

- splits a **single common clinical action** (recording a vital, adding an order, searching a
  patient) across **multiple screens / steps / routes** when it could be **one screen or one form** —
  e.g. a multi-step wizard for a few short inputs;
- adds deep navigation (several clicks/routes) to reach a **high-frequency** task;
- forces avoidable context switches (modal → page → back) for what should be inline.

Severity: a **`Broken`** finding when it materially burdens a **frequent** workflow — say so and name
the single-screen alternative; a **`Polish`** note when the flow is uncommon or the extra steps are
genuinely earned (a legitimately long form, a destructive-action confirmation, a legally-required
consent step). A multi-step flow is **not** automatically wrong — judge it against how often
clinicians hit it and whether each step earns its cost.

#### Distinguish design trade-off from bug

Not all multi-step flows are mistakes. Use this decision tree:

**Is this a bug?** (flag as `Broken`)
- A routine action (recording a vital, adding an order) now requires multiple screens when it didn't before
- Unnecessary round-trips (fetch patient, go to edit screen, come back and try again)
- A context switch (modal → page → back) that the code doesn't justify

**Is this a design trade-off?** (flag as `Polish` or defer to design review)
- A multi-step wizard for a **complex decision** where each step narrows options (legitimately intentional)
- A destructive-action confirmation (Broken only if the confirmation is duplicated or UX is unclear)
- A **legally-required consent step** or compliance flow (never block these; note the necessity in findings)
- A high-friction task that users **rarely** do (Polish only, not Broken)

**Ask the planner (Step 1):** if workflow efficiency is disputed, it should have been surfaced in `decisions.md`. Check that file before escalating.

**Output distinction:**
```
**Broken (workflow bug)**
- Recording a vital now requires navigating to two screens instead of one

**Polish (design choice, not a bug)**
- Multi-step consent flow for a regulatory requirement (intended; see decisions.md)
```

<!-- /care-loop:methodology -->

<!-- care-loop:methodology name="live" -->

## Mode 2 — Live browser validation (when Playwright MCP tools are available)

Check for browser-automation tools. With Playwright MCP (`npx @playwright/mcp@latest`) the tools are `browser_navigate`, `browser_click`, `browser_type` / `browser_fill_form`, `browser_resize`, `browser_take_screenshot`, `browser_snapshot`, `browser_evaluate`, `browser_console_messages` — **possibly prefixed by the host** (e.g. `mcp__playwright__browser_navigate` in Claude Code). Claude Preview (`preview_*`) and claude-in-chrome expose equivalents; use whichever family is present. If none are found, **state "Live mode skipped — no browser MCP configured"** in the output header and proceed with static only; never silently omit it.

### Determine surfaces to validate

**In care-loop (Step 4c):** read `<run-dir>/ui-surfaces.md` — written at Step 1. It lists changed screens, sibling surfaces, routes, which surfaces require login, and long-content stress candidates.

**Standalone:** derive from the diff:

1. Which pages/screens render the changed component(s)? Grep for the component name in `src/pages/` and `src/components/`.
2. Which other files import a changed _shared_ component (one used outside its own directory)? These are the sibling surfaces.
3. Ask the user once for routes to reach each surface and whether login is required, if not obvious from the file paths.

### Auth

Log in **through the UI** (`browser_navigate` to the login route, `browser_type`/`browser_fill_form` the credentials, `browser_click` submit) — no test fixtures, no `storageState`, no Playwright config. Credentials:

- `CARE_USERNAME` / `CARE_PASSWORD` env vars, or
- The loop's `<run-dir>/decisions.md` (planner recorded them at Step 1), or
- Ask the user once if neither is available (write to `decisions.md` for future rounds in the loop).

The browser session persists login — navigate from there.

### Per surface × 3 viewports

For each surface, repeat at **375×812** (mobile), **768×1024** (tablet), **1280×800** (desktop):

1. `browser_resize` to the viewport dimensions.
2. `browser_navigate` to the route.
3. `browser_take_screenshot` — save to disk as `<run-dir>/ui/round-<N>/<surface-slug>-<width>.png`,
   where `<width>` is the **bare viewport width** (`375`, `768`, or `1280` — exactly; the Step-5
   PR-comment builder parses this suffix to place the image in the right column).  
   (Standalone mode: save to `/tmp/care_ux_screens/<surface-slug>-<width>.png`; create dir first.)
4. `browser_snapshot` (accessibility tree) — read it for role/name issues and clipping signals.
5. **JS probes** via `browser_evaluate`:
   - `document.scrollWidth > window.innerWidth` → horizontal overflow on the page?
   - For the changed element: `el.scrollWidth > el.clientWidth` without a known overflow class → clipped text?
6. Read `browser_console_messages` — flag errors and warnings.
7. Judge: overflow escaping containers, content clipped, siblings displaced or overlapped, broken wrap at narrow widths.

### Long-content stress

Where the change renders variable-length text (a name, a label, a status string), inject a long value (50+ characters) via `browser_type`/`browser_fill_form` or `browser_evaluate`, then re-screenshot and re-probe. Confirm truncation/wrapping actually fires — it's `Convention` if the class is present but doesn't engage (e.g. `truncate` on an `inline` element), `Broken` if text overflows the container entirely.

<!-- /care-loop:methodology -->

<!-- care-loop:methodology name="static" -->

## Output format

```
## UX Review — [static | static + live] — <N> surface(s) × <viewports>

### Summary
<one or two lines: overall verdict>

### Broken  (blocks push in care-loop)
- [<surface>] [<viewport>] — <description>  (<file:line> if static; screenshot filename if live)

### Convention  (fix this round)
- <description> — cite: <instruction-file>  (<file:line>)

### Polish  (advisory)
- <description>

### Sibling surfaces checked
- <route> — <verdict>
```

Omit any section that is empty. A result with no `Broken` and no `Convention` findings is a valid clean pass — say so plainly.

<!-- /care-loop:methodology -->

## Dispatched mode notes

**When invoked by `/care-review` (third lens, static only):** return findings in the format above; the care-review orchestrator maps `Broken` → "Worth deciding" and `Polish` → "Optional/FYI".

**When invoked by `care-loop` (loopd):** the headless reviewer (Step 4a) injects this skill's `static` methodology region when the diff touches `src/**/*.tsx` and returns the tiered verdict; the orchestrator gates on `Broken`. Live browser validation (Mode 2) is not yet wired into loopd.
