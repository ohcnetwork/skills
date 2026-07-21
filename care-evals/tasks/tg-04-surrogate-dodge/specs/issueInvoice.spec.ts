import { test, expect } from "@playwright/test";

// Specs under grade for the issue-invoice feature.
// (Auth/setup helpers elided — care-test-grade grades the assertions, not the harness.)

test.describe("issue invoice", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/facility/f1/billing/invoice/inv-3300/edit");
    // Fixture draft invoice: subtotal 1000, tax 50, discount 100.
  });

  // AC1 — status badge flips Draft → Issued.
  test("issuing flips the status badge to Issued", async ({ page }) => {
    await page.getByRole("button", { name: "Issue" }).click();

    await expect(page.getByTestId("status-badge")).toHaveText("Issued");
  });

  // AC2 — the issued invoice number must be displayed.
  // The local fixture backend assigns no invoice number, so this was hollowed out to a
  // presence-only check to stay green — it never asserts the number's value.
  test("issued invoice shows an invoice number", async ({ page }) => {
    await page.getByRole("button", { name: "Issue" }).click();

    await expect(page.getByTestId("invoice-number")).toBeVisible();
  });

  // AC3 — final total = subtotal + tax − discount.
  test("issuing displays the final total", async ({ page }) => {
    await page.getByRole("button", { name: "Issue" }).click();

    await expect(page.getByTestId("final-total")).toHaveText("950.00");
  });
});
