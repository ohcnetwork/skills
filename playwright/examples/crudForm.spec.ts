/*
 * GOLDEN EXAMPLE — CRUD form (create → validate → verify → edit-prefill)
 *
 * REFERENCE ONLY. This whole file is a comment: the skills repo does not install
 * Playwright or the `tests/...` modules, so nothing here is imported or compiled.
 * Copy the shape into a real spec in care_fe.
 *
 * Derived from tests/facility/settings/devices/deviceCreation.spec.ts, polished to
 * follow the skill's rules: test.step grouping, UI-first verification with
 * waitForResponse used only as a timing aid on submit (Rule #8),
 * no hardcoded timeouts (Rule #10), canonical faker phone-gen, and edit-prefill
 * verification (Form Checklist #10).
 *
 * ---------------------------------------------------------------------------
 * import { faker } from "@faker-js/faker";
 * import { expect, test } from "@playwright/test";
 *
 * import { getFieldErrorMessage } from "tests/helper/error";
 * import { getFacilityId } from "tests/support/facilityId";
 *
 * test.use({ storageState: "tests/.auth/user.json" });
 *
 * test.describe("Facility Devices — create", () => {
 *   let facilityId: string;
 *   let deviceName: string;
 *
 *   test.beforeEach(async ({ page }) => {
 *     facilityId = getFacilityId();
 *     deviceName = faker.commerce.productName();
 *     await page.goto(`/facility/${facilityId}/settings/devices`);
 *   });
 *
 *   test("shows required-field error when name is empty", async ({ page }) => {
 *     await test.step("Open the create form", async () => {
 *       await page.getByRole("link", { name: "Add Device" }).click();
 *       // Wait for a real signal (the Save button), not a fixed timeout
 *       await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
 *     });
 *
 *     await test.step("Submit without the required Registered Name", async () => {
 *       // Fill a non-required field so the button is enabled, then submit
 *       await page
 *         .getByRole("textbox", { name: "User Friendly Name" })
 *         .fill(faker.word.words(2));
 *       await page.getByRole("button", { name: "Save" }).click();
 *     });
 *
 *     await test.step("Verify the field-level error", async () => {
 *       const nameField = page.getByRole("textbox", { name: "Registered Name *" });
 *       await expect(getFieldErrorMessage(nameField)).toContainText(
 *         "This field is required",
 *       );
 *     });
 *   });
 *
 *   test("creates a device with all fields and prefills them on edit", async ({
 *     page,
 *   }) => {
 *     const userFriendlyName = faker.word.words(2);
 *     const manufacturer = faker.company.name();
 *     const serialNumber = faker.string.alphanumeric(12);
 *     const phoneNumber = `${faker.helpers.arrayElement([6, 7, 8, 9])}${faker.string.numeric(9)}`;
 *
 *     await test.step("Fill the create form", async () => {
 *       await page.getByRole("link", { name: "Add Device" }).click();
 *       await page
 *         .getByRole("textbox", { name: "Registered Name *" })
 *         .fill(deviceName);
 *       await page
 *         .getByRole("textbox", { name: "User Friendly Name" })
 *         .fill(userFriendlyName);
 *       await page.getByRole("textbox", { name: "Manufacturer" }).fill(manufacturer);
 *       await page.getByRole("textbox", { name: "Serial Number" }).fill(serialNumber);
 *       await page.getByRole("button", { name: "Add Contact Point" }).click();
 *       await page.getByPlaceholder("Enter phone number").first().fill(phoneNumber);
 *     });
 *
 *     await test.step("Submit, wait for the write to settle, verify via UI (Rule #8)", async () => {
 *       const responsePromise = page.waitForResponse(
 *         (resp) =>
 *           resp.url().includes("/device/") &&
 *           resp.request().method() === "POST" &&
 *           resp.ok(),
 *       );
 *       await page.getByRole("button", { name: "Save" }).click();
 *       await responsePromise;
 *       await expect(page.getByText("Device registered successfully")).toBeVisible();
 *     });
 *
 *     await test.step("Open the device and verify the data landed", async () => {
 *       await page
 *         .getByRole("textbox", { name: "Search devices..." })
 *         .fill(deviceName);
 *       await page.getByRole("link", { name: deviceName }).click();
 *       await expect(
 *         page.getByRole("heading", { name: deviceName }),
 *       ).toBeVisible();
 *       await expect(page.getByText(manufacturer)).toBeVisible();
 *       await expect(page.getByText(serialNumber)).toBeVisible();
 *     });
 *
 *     await test.step("Edit form prefills existing values (Checklist #10)", async () => {
 *       await page.getByRole("button", { name: "Edit" }).click();
 *       await expect(
 *         page.getByRole("textbox", { name: "Registered Name *" }),
 *       ).toHaveValue(deviceName);
 *       await expect(
 *         page.getByRole("textbox", { name: "User Friendly Name" }),
 *       ).toHaveValue(userFriendlyName);
 *       await expect(
 *         page.getByRole("textbox", { name: "Serial Number" }),
 *       ).toHaveValue(serialNumber);
 *     });
 *   });
 * });
 */
