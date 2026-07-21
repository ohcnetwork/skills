import { test, expect } from "@playwright/test";

// Specs under grade for the invoice percentage-discount feature.
// (Auth/setup helpers elided — care-test-grade grades the assertions, not the harness.)

test.describe("invoice percentage discount", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/facility/f1/billing/invoice/inv-1000/edit");
    // Fixture invoice: subtotal 1000, tax 50.
  });

  // AC1 — net payable reflects the applied discount.
  test("applying 10% updates the net payable", async ({ page }) => {
    await page.getByLabel("Discount percent").fill("10");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page.getByTestId("net-payable")).toHaveText("950.00");
  });

  // AC2 — discount row shows the computed amount with a leading minus.
  test("discount row shows a discount amount after applying", async ({ page }) => {
    await page.getByLabel("Discount percent").fill("10");
    await page.getByRole("button", { name: "Apply" }).click();

    // NOTE: checks the VALUE (faithful) but thinly — "-100" also matches -1000.00, -100.50, etc.,
    // so it could pass on a wrong amount. A thin-but-faithful assertion (Weak), not a presence dodge.
    await expect(page.getByTestId("discount-row")).toContainText("-100");
  });

  // AC3 — a percent over 100 must be REJECTED and the net left unchanged.
  // This spec instead asserts the over-100 discount is applied and the net drops,
  // which contradicts the criterion.
  test("applying 150% discounts the invoice further", async ({ page }) => {
    await page.getByLabel("Discount percent").fill("150");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page.getByTestId("net-payable")).toHaveText("-450.00");
  });
});
