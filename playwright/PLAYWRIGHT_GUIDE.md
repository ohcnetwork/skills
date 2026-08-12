# Playwright Test Writing Guide (CARE)

The encyclopedic reference for writing Playwright E2E tests for CARE. `SKILL.md` is
the lean router (when to test, critical rules, mindset, checklists); **this file is
the how-to** — templates, selectors, helpers, assertions, and the full pattern
gallery. Read `SKILL.md` first for the rules, then use this for the mechanics.

> **Canonical source:** this guide, bundled with the skill, is the single source of
> truth for CARE Playwright patterns. The app repo (`care_fe`) references the skill
> rather than keeping its own copy — edit patterns here, not there.

## Quick Start

```bash
# First time setup
npm run playwright:install        # Install browsers
npm run build                     # Build the app (required — tests run against production build)
npm run playwright:db-reset       # Create DB snapshot with fixtures (requires CARE_BACKEND_DIR)

# Run tests (backend must be running on port 9000)
npx playwright test tests/auth/   # Run a specific directory
npx playwright test --workers=4   # Run with parallelism

# Re-run (DB auto-restores from snapshot)
npx playwright test tests/auth/   # Just run again — clean state guaranteed
```

## Test File Template

Every test file follows this exact structure:

```typescript
import { faker } from "@faker-js/faker";
import { expect, test } from "@playwright/test";
import { getFacilityId } from "tests/support/facilityId";

// REQUIRED: Use authenticated storage state
test.use({ storageState: "tests/.auth/user.json" });

test.describe("Feature Name", () => {
  let facilityId: string;

  test.beforeEach(async ({ page }) => {
    facilityId = getFacilityId();
    await page.goto(`/facility/${facilityId}/settings/locations`);
  });

  test("creates location with valid name and type", async ({ page }) => {
    await test.step("Fill location form", async () => {
      // actions
    });

    await test.step("Verify location appears in list", async () => {
      // assertions
    });
  });
});
```

## Authentication

Use one of these storage states depending on the role needed:

| Storage State                    | Role           | Credentials                   |
| -------------------------------- | -------------- | ----------------------------- |
| `tests/.auth/user.json`          | Admin          | `admin` / `admin`             |
| `tests/.auth/facilityAdmin.json` | Facility Admin | `care-fac-admin` / `Ohcn@123` |
| `tests/.auth/nurse.json`         | Nurse          | `care-nurse` / `Ohcn@123`     |

```typescript
// Most tests use admin
test.use({ storageState: "tests/.auth/user.json" });

// Nurse-specific tests
test.use({ storageState: "tests/.auth/nurse.json" });
```

These files are generated (gitignored) by the setup specs in `tests/setup/*.setup.ts`.
If you hit a missing storage-state file error, run the auth setup first:
`npx playwright test tests/setup/auth.setup.ts`.

## Available IDs from Setup

```typescript
import { getFacilityId } from "tests/support/facilityId";
import { getPatientId } from "tests/support/patientId";
import { getEncounterId } from "tests/support/encounterId";
import { getAccountId } from "tests/support/accountId";

// Use in beforeEach or test body
const facilityId = getFacilityId();
const patientId = getPatientId();
const encounterId = getEncounterId();
const accountId = getAccountId();
```

Always navigate with these deterministic IDs. **Never** pick a random
encounter/patient/facility from a list in the UI — random selection causes
flakiness when data changes between runs.

## Common URLs

> **Source of truth:** route definitions live in `src/Routers/routes/` (e.g.
> `FacilityRoutes.tsx`, `PatientRoutes.tsx`). The paths below are illustrative — if a
> URL 404s, check the route files rather than trusting this list, which can lag the app.

```typescript
// Facility pages
`/facility/${facilityId}/overview`
`/facility/${facilityId}/settings/locations`
`/facility/${facilityId}/settings/departments`
`/facility/${facilityId}/settings/devices`
`/facility/${facilityId}/settings/services`
`/facility/${facilityId}/users`

// Patient pages
`/facility/${facilityId}/patient/${patientId}/encounter/${encounterId}`
`/facility/${facilityId}/patient/${patientId}/profile`
`/facility/${facilityId}/encounters`

// Admin pages
`/admin/questionnaire`
`/admin/valueset`
```

## Data Generation

ALWAYS use faker or timestamps for unique data. NEVER hardcode entity names.

```typescript
import { faker } from "@faker-js/faker";

// Names
const name = faker.company.name();
const departmentName = faker.word.words(2);
const description = faker.lorem.sentence();

// With timestamp for guaranteed uniqueness
const uniqueName = `Test ${Date.now()}`;

// Random selection from options
const status = faker.helpers.arrayElement(["Active", "Inactive"]);

// Phone numbers (Indian format) — faker-based, the single canonical form.
// Indian mobiles start with 6–9, followed by 9 more digits.
const phone = `${faker.helpers.arrayElement([6, 7, 8, 9])}${faker.string.numeric(9)}`;

// Slugs (auto-generated from names in the app)
import { expectedSlug } from "tests/helper/utils";
const slug = expectedSlug(name); // lowercase, hyphens, max 25 chars

// Non-existent search term (for testing "no results")
const nonExistent = faker.string.uuid();
```

> For values that must match **existing** fixture data (usernames, body sites),
> import the shared constants instead of hardcoding — see
> [Available Constants](#available-constants).

## Form Interactions

### Text Input

```typescript
await page.getByRole("textbox", { name: "Name" }).fill("value");

// For inputs that need keystroke simulation (e.g., slug auto-generation)
await page.getByRole("textbox", { name: "Name" }).pressSequentially("value");
```

### `.fill()` vs `.pressSequentially()` — IMPORTANT

- **`.fill()`** clears the field first, then sets the value. Use for fresh input.
- **`.pressSequentially()`** types character by character WITHOUT clearing — appends
  to existing data. Use for slug auto-generation, incremental search, etc.
- AI often confuses these. Be explicit:

```typescript
// CORRECT: Clear and type a fresh value
await page.getByRole("textbox", { name: "Name" }).fill("New Value");

// CORRECT: Type along with existing data (slug auto-generation, search)
await page.getByRole("textbox", { name: "Name" }).pressSequentially("appended text");
```

### Select / Combobox

```typescript
await page.getByRole("combobox", { name: "Status", exact: true }).click();
await page.getByRole("option", { name: "Active" }).first().click();
```

**IMPORTANT:** Use `exact: true` when the label might partially match other elements
(e.g. `"Status"` also matches `"Operational Status"`). Use `.first()` on options when
multiple matches are possible.

#### Gotcha: bare `<Label>` + `<SelectTrigger>` has no accessible name

`getByRole("combobox", { name })` only works when the label is programmatically
associated with the trigger. Two shadcn patterns coexist in this codebase:

- **`<FormField>` + `<FormLabel>` + `<SelectTrigger>`** — auto-wires `htmlFor`/`id`.
  `getByRole("combobox", { name: "Status" })` works.
- **Bare `<Label>` + `<SelectTrigger>`** (no `FormField` wrapper) — no association.
  The trigger's accessible name is its current value (e.g. `"Planned"`), **not** the
  visible label. Role+name lookups silently fail with `toBeVisible` timeout or "0
  elements found", even though the element is clearly in the DOM.

Confirm by inspecting `<button role="combobox">`: if it has no `aria-labelledby`
and no `id` matched by a `<label for=...>`, you're in this case.

Fix — anchor on the label and walk to its parent wrapper:

```typescript
function comboboxByLabel(page: Page, labelText: string) {
  return page
    .locator('label[data-slot="label"]')
    .filter({ hasText: new RegExp(`^${labelText}$`) })
    .locator("xpath=..")
    .getByRole("combobox");
}

await comboboxByLabel(page, "Encounter Status").click();
await page.getByRole("option", { name: "Cancelled", exact: true }).click();
```

Use an anchored regex (`^...$`) so the filter doesn't substring-match a sibling
label (e.g. "Encounter Status" vs "Encounter Class").

#### Gotcha: `filter({ hasText })` matches descendant text, not direct content

```typescript
// BAD: matches every ancestor div whose subtree contains "Encounter Status"
// → strict mode violation, multiple comboboxes resolved
page.locator("div.space-y-2")
  .filter({ hasText: "Encounter Status" })
  .getByRole("combobox");
```

`hasText` checks the full text content of the locator's subtree, so any ancestor
of the labeled wrapper also matches. Anchor on the label element itself (see
gotcha above) or use `filter({ has: page.locator(...) })` with a precise child
locator.

### Radio Button

```typescript
await page.getByRole("radio", { name: "Male", exact: true }).click();
```

### Checkbox

```typescript
await page.getByRole("checkbox", { name: "Create Multiple Beds" }).click();
```

### Number Input

```typescript
await page.getByRole("spinbutton", { name: "PIN Code" }).fill("302020");
```

### Date Input (DD/MM/YYYY fields)

```typescript
await page.getByPlaceholder("DD", { exact: true }).fill("16");
await page.getByPlaceholder("MM", { exact: true }).fill("06");
await page.getByPlaceholder("YYYY", { exact: true }).fill("2009");
```

### Tab Navigation

```typescript
await page.getByRole("tab", { name: "Age" }).click();
```

## Advanced Selectors (Helper Functions)

Import from `tests/helper/ui`. These wrap CARE's Radix/shadcn picker components and
handle the popover-vs-drawer, search-debounce, and option-loading quirks for you.

> **Source of truth:** the complete, current set of helpers (and their exact option
> shapes) is whatever `tests/helper/ui.ts` exports. The selection below covers the
> common cases — open that file to confirm signatures rather than trusting this list.

### Command Selector (User picker, Service picker)

```typescript
import { selectFromCommand } from "tests/helper/ui";

const trigger = page.getByRole("combobox", { name: "Practitioner" });
await selectFromCommand(page, trigger, { search: "doctor", itemIndex: 0 });
```

### ValueSet Selector (Codes, body sites, diagnostic codes)

```typescript
import { selectFromValueSet } from "tests/helper/ui";

const trigger = page.getByRole("combobox", { name: "Body Site" });
await selectFromValueSet(page, trigger, { search: "deltoid", itemIndex: 0 });
```

### Requirements Selector (Multi-select with Plus buttons)

```typescript
import { selectFromRequirements } from "tests/helper/ui";

const trigger = page.getByRole("combobox", { name: "Specimen Requirements" });
await selectFromRequirements(page, trigger, { search: "blood", itemIndex: 0 });
```

### Location Multi-Select

```typescript
import { selectFromLocationMultiSelect } from "tests/helper/ui";

const trigger = page.getByRole("button", { name: "Select Locations" });
await selectFromLocationMultiSelect(page, trigger, {
  search: "Ward",
  itemIndex: 0,
  closeAfterSelect: true,
});
```

### Category Picker (Hierarchical navigation)

```typescript
import { selectFromCategoryPicker } from "tests/helper/ui";

const trigger = page.getByRole("combobox", { name: "Activity" });
await selectFromCategoryPicker(page, trigger, {
  navigateCategories: ["Lab Tests", "Blood Tests"],
  itemIndex: 0,
});
```

There is also `selectFromDefinitionCategoryPicker` for activity/resource definitions.

### Filter Select

```typescript
import { selectFromFilterSelect } from "tests/helper/ui";

await selectFromFilterSelect(page, /status/i, "active");
```

### Tab or Menu Item (responsive)

Handles layouts where tabs collapse into a "More" dropdown on narrow viewports.

```typescript
import { clickTabOrMenuItem } from "tests/helper/ui";

await clickTabOrMenuItem(page, /service requests/i);
```

## Assertions

### Toast Notifications

```typescript
import { expectToast } from "tests/helper/ui";

await expectToast(page, "Location Created");
await expectToast(page, /created successfully/i);
await expectToast(page, "Saved", { timeout: 15000 }); // custom timeout
```

### Form Field Errors

```typescript
import { getFieldErrorMessage } from "tests/helper/error";

const nameField = page.getByRole("textbox", { name: "Name" });
await expect(getFieldErrorMessage(nameField)).toContainText("This field is required");
```

### Table Content

```typescript
const tableBody = page.locator('[data-slot="table-body"]');
await expect(tableBody).toContainText("expected text");

// Click a row
await page.locator('[data-slot="table-body"] tr').first().click();

// Find a specific row
await page.getByRole("row").filter({ hasText: departmentName }).click();
```

### Table Badges

```typescript
import { verifyTableBadges } from "tests/helper/ui";

await verifyTableBadges(page, "Active", "My Item Name");
```

### Visibility & Values

```typescript
await expect(element).toBeVisible();
await expect(element).toBeVisible({ timeout: 10000 });
await expect(element).not.toBeVisible();

await expect(element).toHaveValue("expected value");
await expect(element).toContainText("partial text");
await expect(element).toBeDisabled();
await expect(element).toBeEnabled();
```

### `data-slot` Selectors

Components expose `data-slot` attributes (part of shadcn/ui's architecture — **not**
added for testing) for stable targeting:

```typescript
// Table
await expect(page.locator('[data-slot="table-body"]')).toContainText(name);
await page.locator('[data-slot="table-row"]').first().click();

// Badge
await expect(
  page.locator('[data-slot="badge"]').filter({ hasText: "Active" }),
).toBeVisible();

// Collapsible
const card = page.locator('[data-slot="collapsible"]').filter({ hasText: "Lab Tests" });
await card.locator('[data-slot="collapsible-trigger"]').click();

// Command input (search fields)
const input = page.locator('[data-slot="command-input"]').first();
await input.fill("");       // Clear first
await input.fill(search);   // Then fill
```

## Buttons and Actions

```typescript
// Submit / Create
await page.getByRole("button", { name: "Create" }).click();
await page.getByRole("button", { name: "Save" }).click();
await page.getByRole("button", { name: "Submit" }).click();

// Edit
await page.locator("button[title='Edit Location']").first().click();
await page.getByRole("button", { name: /Edit/i }).click();

// Cancel
await page.getByRole("button", { name: "Cancel" }).click();
```

## Navigation

```typescript
// URL navigation
await page.goto(`/facility/${facilityId}/settings/locations`);

// Sidebar
await page.getByRole("button", { name: "Toggle Sidebar" }).click();
await page.getByRole("button", { name: "Patients", exact: true }).click();

// Wait for navigation — prefer asserting a visible element (auto-waits)
await expect(page.getByRole("heading", { name: "Facility Overview" })).toBeVisible();
await page.waitForURL(/\/facility\/[^/]+\/overview$/);
```

---

# Pattern Gallery

### Verifying a Submit

Verification can use the UI, the API response, or both (Critical Rule #8) — API
assertions are fine here; the UI-only restriction is about **seeding**, not verifying.
Always assert the UI outcome the user cares about; add the status-code check when it's
meaningful.

```typescript
await test.step("Submit and verify", async () => {
  const responsePromise = page.waitForResponse(
    (resp) =>
      resp.url().includes("/api/v1/facility/") && resp.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);    // API assertion — allowed for verification
  await expectToast(page, /created/i);    // and assert the UI outcome
});
```

### `Promise.all()` for Parallel Navigation + API Wait

The wait promise MUST be listed first so the response listener is registered before
the action that triggers the request — otherwise the request can fire before
Playwright is listening, causing a flaky timeout.

```typescript
await Promise.all([
  page.waitForResponse(
    (resp) =>
      resp.url().includes("/medication/prescription/") && resp.status() === 200,
  ),
  page.getByRole("tab", { name: "Medicines" }).click(),
]);
```

### Page Load Verification After Navigation

```typescript
// Prefer asserting a visible element directly (auto-waits up to the global timeout)
await expect(page.getByRole("heading", { name: "Facility Overview" })).toBeVisible();

// Only use networkidle as a LAST RESORT when there is no specific element to wait
// for. It is flaky with polling/websockets. (See Critical Rule #10 in SKILL.md.)
// await page.waitForLoadState("networkidle");
```

### Eventually-Consistent Assertions (`expect.toPass()`)

For UI that updates asynchronously (e.g., a list refreshes after creation):

```typescript
await expect(async () => {
  await expect(page.getByRole("table").getByText(createdName)).toBeVisible();
}).toPass({ timeout: 10000 });
```

### Parallel vs Serial Execution

```typescript
// DEFAULT: Tests run in parallel and are independent — prefer this always
test.describe("Location validations", () => {
  test("shows error for empty name", async ({ page }) => { /* ... */ });
  test("shows error for duplicate slug", async ({ page }) => { /* ... */ });
});

// AVOID: serial creates hidden dependencies and increases flakiness.
// Only use when a single logical flow MUST share state. Consider making it ONE test
// with multiple steps instead.
test.describe("Location CRUD", () => {
  test.describe.configure({ mode: "serial" });
  test("create location", async ({ page }) => { /* ... */ });
  test("edit location", async ({ page }) => { /* ... */ });
});
```

### Helper Function Extraction Pattern

Extract reusable form logic into local helpers that return the generated data:

```typescript
import type { Page } from "@playwright/test";

async function createEntity(page: Page, options: { name: string; type: string }) {
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill(options.name);
  await page.getByRole("combobox", { name: "Type" }).click();
  await page.getByRole("option", { name: options.type }).first().click();
  await page.getByRole("button", { name: "Submit" }).click();
  return options; // Return so the test can assert against it
}
```

### Cascading/Dependent Form Elements

Handle comboboxes that appear based on a previous selection:

```typescript
let previousCount = 0;
const MAX_CASCADES = 10;

for (let iteration = 0; iteration < MAX_CASCADES; iteration++) {
  const comboboxes = page.getByRole("combobox");
  const count = await comboboxes.count();
  if (count === previousCount) break;
  await comboboxes.nth(count - 1).click();
  await page.getByRole("option").first().click();
  previousCount = count;

  if (iteration === MAX_CASCADES - 1) {
    throw new Error(`Cascading comboboxes exceeded ${MAX_CASCADES} iterations — possible loop`);
  }
}
```

### Dismiss Stray Popovers

```typescript
import { closeAnyOpenPopovers } from "tests/helper/ui";
await closeAnyOpenPopovers(page);
```

### Wait for a Closing Overlay Before Opening the Next

Radix `Dialog`/`Sheet`/`Popover` stay mounted during their close animation. If you open a
second overlay that shares controls with the first (e.g. an Add sheet and an Edit sheet that
both render a "Service Date" picker), a shared locator matches **both** → strict-mode
"resolved to 2 elements". Wait for the first to fully unmount before touching the next:

```typescript
// After saving in the "Add" sheet, wait for it to close before opening "Edit".
await page.getByRole("button", { name: "Save" }).click();
await expect(page.getByRole("button", { name: "Save" })).toBeHidden();

await page.getByRole("button", { name: "Edit" }).click();

// Now the edit sheet is the only dialog mounted, so this scopes unambiguously
// (and avoids a hard-coded, locale-dependent dialog title).
const editSheet = page.getByRole("dialog");
await expect(editSheet).toBeVisible();
await editSheet.getByRole("textbox", { name: "Notes" }).fill(notes);
```

### File Upload & Camera

```typescript
// Standard file upload
const fileInput = page.locator('input[type="file"]');
await fileInput.setInputFiles("tests/fixtures/sample_file.xlsx");

// Camera/image capture (mimic by uploading an image file — no real camera needed)
await fileInput.setInputFiles("tests/fixtures/images/test-image.jpg");
```

Always verify the uploaded file name/thumbnail appears AND the upload API returns success.

### Delete with Double Confirmation

Destructive actions typically require two confirmations. Verify BOTH:

```typescript
await test.step("Delete with double confirmation", async () => {
  await page.getByRole("button", { name: "Delete" }).click();

  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Confirm" }).click();

  // Second confirmation (if present — e.g., type the entity name)
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("textbox").fill("confirm");
  await page.getByRole("button", { name: "Delete" }).click();

  await expectToast(page, /deleted successfully/i);
  await expect(page.getByText(entityName)).not.toBeVisible();
});
```

### Network Mocking (`page.route()`)

Use sparingly — prefer real backend responses. Only mock when testing error UI that
is hard to trigger naturally.

```typescript
// Mock a 500 error
await page.route("**/api/v1/facility/*/", (route) =>
  route.fulfill({ status: 500, body: JSON.stringify({ detail: "Server Error" }) }),
);

// Mock a network timeout
await page.route("**/api/v1/facility/*/", (route) => route.abort("timedout"));

// Remove the mock afterwards
await page.unroute("**/api/v1/facility/*/");
```

### Multiple User Roles in a Single Test

```typescript
import { expect, test } from "@playwright/test";
import { getFacilityId } from "tests/support/facilityId";

test("Admin assigns task, nurse sees it", async ({ browser }) => {
  const facilityId = getFacilityId();

  const adminContext = await browser.newContext({ storageState: "tests/.auth/user.json" });
  try {
    const adminPage = await adminContext.newPage();
    await test.step("Admin creates assignment", async () => {
      await adminPage.goto(`/facility/${facilityId}/...`);
    });
  } finally {
    await adminContext.close();
  }

  const nurseContext = await browser.newContext({ storageState: "tests/.auth/nurse.json" });
  try {
    const nursePage = await nurseContext.newPage();
    await test.step("Nurse verifies assignment", async () => {
      await nursePage.goto(`/facility/${facilityId}/...`);
      await expect(nursePage.getByText("Assigned Task")).toBeVisible();
    });
  } finally {
    await nurseContext.close();
  }
});
```

Use the `{ browser }` fixture (not `{ page }`) when switching users, and always close
each context in `finally`.

### Keep Tests Independent

- Each test MUST be runnable in isolation — never depend on another test's side effects.
- If a test needs precondition data, create it by **driving the UI** in
  `beforeEach`/`beforeAll` (or, only when API usage is explicitly allowed, a direct API
  call) — never assume a previous test created it.
- **Encounter limit awareness** — a patient can have only 5 live encounters at a
  time. If your test creates or selects encounters, mark them completed after use (via
  the UI; or the API only when explicitly allowed), or re-runs will flake once the
  limit is hit.

---

# Seeding Test Data — via the UI (API only when explicitly allowed)

**Seed each test's precondition data by driving the UI**, the same way a user would — do
not reach for direct API calls to create per-test state. Two clarifications:

- **Verification is different.** Asserting via the API response/status is fine (see
  [Verifying a Submit](#verifying-a-submit)). This rule is only about *seeding*.
- **Shared fixtures are exempt.** The once-per-run setup in `tests/setup/*` (facility,
  patient, encounter, account) may use the API — that is not per-test seeding.

The patterns below are the **explicit-exception escape hatch** for per-test API seeding:
use them only when the user has allowed it for that test, keep the API surface minimal,
and still verify through the UI.

### Direct API Calls with `fetch()` (explicit-exception only)

Quick and dependency-free for one-off precondition data — when API seeding is sanctioned.

```typescript
import { getFacilityId } from "tests/support/facilityId";
import { getApiHeaders, getApiUrl } from "tests/helper/utils";

async function createAccountViaApi() {
  const facilityId = getFacilityId();
  const res = await fetch(`${getApiUrl()}/api/v1/facility/${facilityId}/account/`, {
    method: "POST",
    headers: getApiHeaders(),
    body: JSON.stringify({ name: "Test Account", type: "income" }),
  });
  if (!res.ok) throw new Error(`Failed to create account: ${res.status}`);
  return res.json();
}

test.beforeEach(async () => {
  const account = await createAccountViaApi(); // never call at module top level
});
```

### Playwright's `request` Fixture (explicit-exception only)

If API setup has been explicitly allowed, `request` (an `APIRequestContext`) is the
idiomatic alternative to raw `fetch()` — it participates in tracing, reuses Playwright's
networking, and gives ergonomic `expect(response)` assertions. Use it over `fetch()`
when API usage is sanctioned. It is **not** a default; UI setup is.

```typescript
import { expect, test } from "@playwright/test";
import { getFacilityId } from "tests/support/facilityId";
import { getApiHeaders, getApiUrl } from "tests/helper/utils";

test("creates account via API and verifies in UI", async ({ page, request }) => {
  const facilityId = getFacilityId();

  const res = await request.post(
    `${getApiUrl()}/api/v1/facility/${facilityId}/account/`,
    { headers: getApiHeaders(), data: { name: "Test Account", type: "income" } },
  );
  await expect(res).toBeOK();
  const account = await res.json();

  await page.goto(`/facility/${facilityId}/settings/billing`);
  await expect(page.getByText(account.name)).toBeVisible();
});
```

---

# Recommended Patterns from the Broader Playwright Ecosystem

These were not in the original CARE guide; adopt them as CARE grows. They mirror the
[currents-dev best-practices skill](https://github.com/currents-dev/playwright-best-practices-skill).

### Custom Fixtures (reduce `beforeEach` boilerplate)

Most CARE tests repeat `test.use({ storageState })` + `getFacilityId()` + `goto`. A
custom fixture centralizes that and makes intent explicit. Define once (e.g.
`tests/helper/fixtures.ts`) and import `test`/`expect` from it:

```typescript
import { test as base, expect } from "@playwright/test";
import { getFacilityId } from "tests/support/facilityId";

export const test = base.extend<{ facilityId: string }>({
  // Run every test in this file as admin
  storageState: "tests/.auth/user.json",
  facilityId: async ({}, use) => {
    await use(getFacilityId());
  },
});

export { expect };
```

```typescript
// In the spec — no beforeEach needed for the common case
import { expect, test } from "tests/helper/fixtures";

test("opens the locations page", async ({ page, facilityId }) => {
  await page.goto(`/facility/${facilityId}/settings/locations`);
  await expect(page.getByRole("heading", { name: /locations/i })).toBeVisible();
});
```

Migrate incrementally — the existing `beforeEach` + `getFacilityId()` pattern stays
valid; reach for a fixture when several specs share the same setup.

### Accessibility Smoke Checks (axe-core)

The mindset says "if a screen reader can't reach it, neither should your test."
`@axe-core/playwright` turns that into a concrete check on key pages. (Requires
adding the dev dependency — alert a maintainer before relying on it in CI.)

```typescript
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("locations page has no critical a11y violations", async ({ page }) => {
  await page.goto(`/facility/${getFacilityId()}/settings/locations`);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(serious).toEqual([]);
});
```

### Assert No Console Errors During a Journey

Catches uncaught exceptions and failed requests that don't surface in the UI.

```typescript
test("registration flow logs no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(`/facility/${getFacilityId()}/patient/registration`);
  // ... drive the flow ...

  expect(errors, `Console errors:\n${errors.join("\n")}`).toEqual([]);
});
```

### Clock Mocking (`page.clock`)

For time-dependent UI (token refresh runs every 5 min, relative timestamps, expiry
banners) make time deterministic instead of waiting.

```typescript
test("shows session-expiry warning after inactivity", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T10:00:00") });
  await page.goto("/");
  await page.clock.fastForward("06:00"); // jump 6 minutes
  await expect(page.getByText(/session/i)).toBeVisible();
});
```

### Deliberately Out of Scope

The reference skill covers many topics CARE intentionally does **not** need.  Don't
add patterns for these unless the app's stack changes: framework-specific testing
(Angular/Vue/Next), Electron/desktop, browser extensions, GraphQL, canvas/WebGL,
service workers, Docker, and multi-provider CI (GitLab/CircleCI/Azure/Jenkins).
CARE runs Chromium-only against a React app on GitHub Actions.

---

# File Organization — Mirror the App's Navigation

Test directory structure MUST mirror the **application's** route/navigation hierarchy
— not whatever `tests/` happens to contain today. Existing test dirs can lag or drift
from the app; the routes are the source of truth.

> **Source of truth:** top-level routes live in `src/Routers/routes/` (`adminRoutes.tsx`,
> `FacilityRoutes.tsx`, `OrganizationRoutes.tsx`, `PatientRoutes.tsx`, …), and the
> facility **settings** sub-nav is defined in `src/pages/Facility/settings/layout.tsx`.
> Create a test directory when the app gains a page, even before tests exist for it.
> The tree below is a representative snapshot — confirm against those files.

```
tests/
  auth/                                    # /login, /session, /homepage
  profile/                                 # /profile/*
  admin/                                   # /admin/*
    questionnaire/  valueset/  tags/  patientIdentifierConfig/  apps/
    rbac/  ->  roles/  permissions/        #   /admin/rbac/{roles,permissions}
  organization/                            # /organization/*
    user/  facility/  patient/encounter/
  facility/                                # /facility/:id/*
    overview/  appointments/  encounters/  queues/  resource/  billing/  users/
    services/locations/inventory/          #   /facility/:id/services + locations
    settings/                              # /facility/:id/settings/* (settings/layout.tsx)
      general/  departments/  locations/  devices/  specimenDefinitions/
      observationDefinition/  activityDefinition/  services/  billing/discount/
      chargeItemDefinition/  productKnowledge/  product/  tokenCategory/
    patient/                               # /facility/:id/patient/*
      patientRegistration.spec.ts
      patientHome/
      patientDetails/  ->  files/ notes/ request/ users/
      encounter/       ->  careTeam/ files/drawings/ forms/enableWhen/ medicine/
                            notes/ serviceRequests/ structuredQuestions/
```

The facility `settings/` dir names are camelCased versions of the app's snake_case
route segments (e.g. `healthcare_services` → `services/`, `specimen_definitions` →
`specimenDefinitions/`, `token_category` → `tokenCategory/`). Shared facility-UI
component tests with no single route may live in a `facility/components/` dir.

**Naming conventions:**
- Directories: camelCase matching the feature (e.g., `activityDefinition/`,
  `patientDetails/`) — not kebab-case or snake_case, even though the app routes are.
- Files: `featureAction.spec.ts` (e.g., `locationCreation.spec.ts`, `deviceEdit.spec.ts`).
- Group CRUD operations in the same directory with separate files per action.

# Common Pitfalls

1. **Missing `exact: true`** — `{ name: "Status" }` matches "Operational Status" too.
2. **Missing `.first()`** — multiple matching elements cause "strict mode violation".
3. **Hardcoded entity names** — will fail on re-run; always use faker.
4. **Not awaiting helpers** — all helper functions are async; you must `await` them.
5. **Forgetting `test.use({ storageState })`** — tests fail with auth errors.
6. **Not using `test.step()`** — makes reports hard to read.
7. **Reaching for `networkidle`** — do NOT use `page.waitForLoadState("networkidle")`
   as your default wait. Prefer asserting a specific element (`expect(locator)
   .toBeVisible()`) or `page.waitForResponse(...)`. `networkidle` is flaky with
   polling/websockets and never resolves on pages with background activity. Use it
   only as a documented last resort. (This is Critical Rule #10 in `SKILL.md`.)
8. **Non-camelCase directory names** — see naming conventions above.
9. **Overlapping Radix overlays during close animations** — Radix `Dialog`/`Sheet`/`Popover`
   keep their content mounted while they animate closed. Opening a second overlay (or
   clicking a control) right after closing the first makes a shared locator match **both**
   → strict-mode "resolved to 2 elements". Assert a control unique to the closing overlay is
   `toBeHidden()` before interacting with the next one. `getByRole("dialog")` is a good way
   to drop a hard-coded (locale-dependent) title, but it is only unambiguous once exactly
   one dialog is mounted — so wait for the previous one to unmount first.

```typescript
import { BODY_SITES, KNOWN_USERNAMES } from "tests/helper/commonConstants";
```

- `BODY_SITES` — array of SNOMED body-site display names for `selectFromValueSet`.
- `KNOWN_USERNAMES` — fixture usernames safe to select in pickers. **This file is the
  source of truth; do not duplicate the list in docs or tests.** Import it and read
  the array rather than hardcoding names, since the set changes as fixtures evolve.

# Sanctioned Exceptions to the Rules

The skill's rules are strict on purpose. Two narrow, intentional exceptions:

- **`waitForTimeout` inside shared helpers** — the picker helpers in `tests/helper/ui.ts`
  use a small bounded `waitForTimeout` to absorb debounced search input where there
  is no DOM/response signal to await. This is acceptable **only** inside encapsulated
  helpers, never in spec files. In specs, always wait for an element or response.
- **CSS/class selectors inside helpers** — `expectToast` targets the toast container
  by class (`.toaster.group`) because the toast has no stable role. Encapsulating
  such a selector in one helper is fine; specs themselves must use roles, labels,
  text, or existing `data-slot` attributes.

# Running Specific Tests

```bash
# Single file
npx playwright test tests/facility/settings/locations/locationCreation.spec.ts

# By grep pattern
npx playwright test -g "creates location with valid name"

# Single directory
npx playwright test tests/auth/

# Headed / interactive / report
npx playwright test --headed tests/auth/login.spec.ts
npx playwright test --ui
npx playwright show-report
```
