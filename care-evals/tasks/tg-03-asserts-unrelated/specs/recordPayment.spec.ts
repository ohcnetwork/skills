import { test, expect } from "@playwright/test";

// Specs under grade for the record-partial-payment feature.
// (Auth/setup helpers elided — care-test-grade grades the assertions, not the harness.)

test.describe("record partial payment", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/facility/f1/billing/invoice/inv-2100/edit");
    // Fixture invoice: outstanding balance 800.00.
  });

  // AC1 — outstanding balance must recompute to balance − payment.
  // BUG: this only asserts the success toast, never the recomputed balance. It would stay green
  // even if the balance math were completely broken — it does not test the criterion at all.
  test("recording a payment shows a confirmation", async ({ page }) => {
    await page.getByLabel("Payment amount").fill("300");
    await page.getByRole("button", { name: "Record" }).click();

    await expect(page.getByText("Payment recorded")).toBeVisible();
  });

  // AC2 — the payment appears in the Payments list with its amount.
  test("recorded payment appears in the payments list", async ({ page }) => {
    await page.getByLabel("Payment amount").fill("300");
    await page.getByRole("button", { name: "Record" }).click();

    await expect(page.getByTestId("payments-list")).toContainText("300.00");
  });
});
