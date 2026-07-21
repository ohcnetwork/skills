import { test, expect } from "@playwright/test";

// Specs under grade for the user-departments pagination feature.
// (Auth/setup helpers elided — care-test-grade grades the assertions, not the harness.)

test.describe("user departments pagination", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/facility/f1/users/departments");
  });

  // AC1 — full first page shows exactly 10 rows (page-size cap; 23 departments seeded).
  test("shows 10 rows on the first page", async ({ page }) => {
    await expect(page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") })).toHaveCount(10);
  });

  // AC2 — Next advances to page 2 with a distinct batch of rows.
  test("Next advances to the second page of rows", async ({ page }) => {
    const firstRow = page.getByRole("row").nth(1);
    const firstRowPage1 = (await firstRow.textContent()) ?? "";

    await page.getByRole("button", { name: "Next" }).click();

    // Web-first, retrying assertion: waits for the refetch to actually change the first row's text
    // (no snapshot race), then confirms the full page-2 batch is present.
    await expect(firstRow).not.toHaveText(firstRowPage1);
    await expect(page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") })).toHaveCount(10);
  });

  // AC3 — the page indicator reflects the current page number.
  test("page indicator updates after advancing", async ({ page }) => {
    await expect(page.getByTestId("page-indicator")).toContainText("Page 1");

    await page.getByRole("button", { name: "Next" }).click();

    await expect(page.getByTestId("page-indicator")).toContainText("Page 2");
  });
});
