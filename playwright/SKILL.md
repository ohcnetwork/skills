---
name: playwright
description: "Write, debug, and run Playwright E2E tests for CARE. Use when: creating new test files, fixing failing tests, adding test coverage, writing assertions, using test helpers, setting up test authentication, or running Playwright commands."
argument-hint: "Describe the test scenario or feature to test"
---

# Playwright E2E Testing for CARE

Router for CARE E2E tests: the discovery workflow, when to test, the rules, the QA
mindset, and the form checklist. Mechanics (form interactions, selector helpers,
assertions, pattern gallery, fixtures, a11y/clock) live in the bundled guide.

> **Before writing, read [`PLAYWRIGHT_GUIDE.md`](./PLAYWRIGHT_GUIDE.md)** (installed at
> `~/.claude/skills/playwright/PLAYWRIGHT_GUIDE.md`) **and copy a shape from
> [`examples/`](./examples):**
> [`crudForm`](./examples/crudForm.spec.ts) (create → validate → verify → edit-prefill) ·
> [`multiRole`](./examples/multiRole.spec.ts) (second user via `browser.newContext()`) ·
> [`apiSetup`](./examples/apiSetup.spec.ts) (API seeding — the **exception**; per-test
> data is seeded via the UI by default, see the seeding rule below).

## When to E2E (and when not)

E2E is for **user journeys** (login → navigate → fill form → submit → verify) that need
a browser and a running backend. Not for pure logic/formatters (→ unit test), component
rendering (→ component test), or API request/response shape (→ integration test). Rule
of thumb: if it doesn't need a browser + backend, it isn't E2E.

This skill authors **deterministic journey tests** — the CI regression layer that
enforces a specific path. That is distinct from an agent driving the app live to verify
a goal (runtime exploration): if you use a browser to explore, the committed artifact is
still a deterministic spec, not the exploration.

## Workflow — Clarify Before You Write

Don't jump to writing specs — most missed bugs come from untested requirements, not bad
selectors. Run this gate first:

1. **Survey the change.** Read the diff and relevant source — the route in
   `src/Routers/routes/`, the form's zod schema, API types in `src/types/{domain}/` —
   and draft a **rough requirements list**: flows, every field + its validation, the
   states it can be in, and which roles can reach it. If a browser/Playwright MCP is
   available, open the page and read the live accessibility tree to confirm exact
   roles/labels/`data-slot`s instead of guessing — then still commit a deterministic spec.
2. **Present the draft requirements** as a bullet list and ask the user to confirm or
   correct it; surface anything the diff implies but doesn't state.
3. **Clarify specs.** Ask where the code is ambiguous: validation rules and exact error
   text, success/redirect behavior, defaults, role boundaries, which responses matter.
4. **Grill on edge cases.** Enumerate them and ask whether each is in scope (draw from
   the Mindset and Form Checklist): empty/boundary/invalid inputs, permission-denied,
   duplicate/concurrent actions, 4xx/5xx, the 5-live-encounter limit, empty and
   loading→loaded states. Don't assume out of scope — ask.
5. **Produce a test plan** — a numbered list, each with an outcome-style name and a
   happy / negative / edge tag. Get agreement before writing. Update the plan if scope shifts.

## Setup & Commands

```bash
npm run playwright:install        # Install browsers (first time)
npm run build                     # Build app (tests run against production build)
npm run playwright:db-reset       # Create DB snapshot with fixtures (requires CARE_BACKEND_DIR)
npm run playwright:db-restore     # Restore clean DB state before re-runs

npx playwright test tests/auth/    # Run a directory
npx playwright test -g "test name" # Run by pattern
npx playwright test --headed       # Headed (debug) / --ui (interactive)
npx playwright show-report         # View last HTML report
```

## File Organization

Mirror the **app's** route hierarchy (source of truth: `src/Routers/routes/` and
`src/pages/Facility/settings/layout.tsx`) — not whatever `tests/` contains today. E.g.
`tests/facility/settings/locations/` for `/facility/:id/settings/locations`. Full tree
in the guide.

- Directories: **camelCase** by feature (`activityDefinition/`, `patientDetails/`).
- Files: `featureAction.spec.ts` (`locationCreation.spec.ts`, `deviceEdit.spec.ts`); one action per file.

## Canonical Test Structure

```typescript
import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";
import { getFacilityId } from "tests/support/facilityId";

test.use({ storageState: "tests/.auth/user.json" });

test.describe("Feature Name", () => {
  let facilityId: string;

  test.beforeEach(async ({ page }) => {
    facilityId = getFacilityId();
    await page.goto(`/facility/${facilityId}/settings/locations`);
  });

  test("creates location with valid name and type", async ({ page }) => {
    await test.step("Fill location form", async () => {/* actions */});
    await test.step("Verify location appears in list", async () => {/* assertions */});
  });
});
```

**Auth states:** `tests/.auth/user.json` (admin), `…/facilityAdmin.json`, `…/nurse.json`
— generated by `tests/setup/*.setup.ts`. **Key helpers** (`tests/helper/ui`):
`expectToast`, `selectFromCommand`, `selectFromValueSet`, `selectFromFilterSelect`;
`getFieldErrorMessage` (`tests/helper/error`). Full signatures in the guide.

## Critical Rules

> **Seed through the UI, not the API.** Create each test's precondition data by driving
> the actual screens — do **not** use `fetch()` or the `request` fixture to seed
> per-test state unless the user explicitly allows it for that test. (Shared fixtures
> built once in `tests/setup/*` are exempt — that's not per-test seeding.)
> **API is fine for verification:** asserting a `page.waitForResponse()` / status code
> is allowed, alongside — not instead of — UI assertions.

1. **`faker` for data you create**; for existing fixture options import from
   `tests/helper/commonConstants.ts` — no scattered literals.
2. **Deterministic fixture IDs** (`getFacilityId/PatientId/EncounterId` from
   `tests/support/`); never pick a random row from a UI list (flakes when data changes).
3. **`test.use({ storageState })`** on every authenticated flow (omit only for public/auth pages).
4. **`exact: true`** when a label can partially match another element.
5. **`.first()` only after searching/filtering** — never to pick randomly from a full list.
6. **`test.step()`** to group actions.
7. Place tests in the **matching feature directory**.
8. **Verify the submit landed** — assert the UI outcome (toast + redirect + new data
   visible, Checklist #9) and/or the API response (`page.waitForResponse()` + status).
   Both are fine; skip the API assertion for chained or meaningless calls.
9. **Confirm navigation** — assert a heading/unique element after navigating.
10. **Wait on elements/responses, not timeouts**; avoid `page.waitForLoadState("networkidle")`
    (flaky; last resort only).
11. **No custom test IDs in source** — use roles, labels, text, existing `data-slot` (shadcn, not added for tests).
12. **Verify in-page generated content** (QR/tokens): assert the element is visible, and
    optionally its API response.
13. **Constants over duplication** — shared values in `tests/helper/`.
14. **Run the file(s) locally and confirm green before pushing.**
15. **3-strike rule** — after 3 failed fix attempts, stop and ask a human to inspect the UI.
16. **Don't touch CI/CD YAML** unless asked; if a test needs a new `.env` var, alert the human.
17. **Never `.skip()`/`.fixme()`/conditional-skip to hide failures** — fix them. `.skip()`
    only for genuinely unsupported environments, with a comment.
18. **Improve this skill via a separate reviewed PR**, not mid-task.

> **Sanctioned exceptions** to #10/#11: a bounded `waitForTimeout` and CSS/class selectors
> are OK **inside shared helpers** (debounced search, `expectToast`'s container) — never in specs.

## Mindset: Senior QA Engineer

- **User journeys, not implementation** — assert the outcome the user cares about, not the DOM.
- **Both paths** — every happy path needs its negative twin (missing/invalid input,
  permission denied, 4xx/5xx with the right error shown).
- **Isolation** — each test self-contained; never rely on another's side effects.
- **Regression-first** — reproduce a bug as a failing test before fixing the code.
- **Accessibility** — reach elements by role/label (the guide has an axe-core pattern).
- **Boundaries & transitions** — min / max / just-over inputs; loading→loaded, empty→populated.
- **One focused journey per spec** — split or push down long, multi-session, or
  multi-window flows. Authored tests degrade sharply on complexity (industry reports
  ~8% failure on simple flows vs ~48% on complex ones); keep each spec small and linear.

## Form Testing Checklist

Every form MUST cover:

1. **Required-field validation** — submit empty, each required field errors.
2. **Happy path** — all valid data, verify success.
3. **Field combinations** — only some required fields filled, correct errors appear.
4. **Error-message text** — assert exact text per rule (min length, format, required).
5. **Individual field update (edit)** — editing one field doesn't corrupt others.
6. **Field-level validation** — invalid formats (email/phone/date), boundaries, special chars.
7. **Reset/cancel** — cancel doesn't save; form resets.
8. **Duplicate-submit prevention** — button disables after click.
9. **Post-submit verification (mandatory)** — toast text AND URL change AND the new data
   visible on the destination page. Never stop at the click.
10. **Edit prefill** — assert existing data is prefilled before changing anything.

## Debugging & Flakiness

```bash
npx playwright test <path> --trace on   # trace viewer / --debug Inspector / --headed watch
npx playwright show-report              # last HTML report
npx playwright show-trace test-results/<run-id>/trace.zip
```

Fail → check report → `--headed` → `--debug` → if data looks stale, `npm run playwright:db-restore`.

**Flaky triage:** race (element before data) → wait for response/text, not `networkidle` ·
animation → `waitFor({ state: "visible" })` first · parallel collision → `Date.now()` suffix ·
stale DB → `db-restore` · polling/WebSocket → wait for a specific DOM change.
