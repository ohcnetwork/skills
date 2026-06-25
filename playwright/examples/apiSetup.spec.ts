/*
 * GOLDEN EXAMPLE — precondition data created via the API, then verified in the UI
 *
 * REFERENCE ONLY. This whole file is a comment: the skills repo does not install
 * Playwright or the `tests/...` modules, so nothing here is imported or compiled.
 * Copy the shape into a real spec in care_fe.
 *
 * Derived from tests/facility/billing/accountTransfer.spec.ts. Shows BOTH ways to
 * create setup data without driving the UI:
 *   1. raw fetch() + getApiHeaders() — quick, dependency-free (the existing pattern)
 *   2. Playwright's `request` fixture — idiomatic, trace-integrated (preferred for new code)
 *
 * Setup helpers create data in a hook/test body (never at module top level), then the
 * test asserts the precondition is reflected in the UI.
 *
 * ---------------------------------------------------------------------------
 * import { faker } from "@faker-js/faker";
 * import { type APIRequestContext, expect, test } from "@playwright/test";
 *
 * import { getApiHeaders, getApiUrl } from "tests/helper/utils";
 * import { getFacilityId } from "tests/support/facilityId";
 * import { getPatientId } from "tests/support/patientId";
 *
 * interface AccountInfo {
 *   id: string;
 *   name: string;
 *   status: string;
 * }
 *
 * // --- Option 1: raw fetch() (the existing care_fe pattern) -------------------
 * async function createAccountViaFetch(
 *   facilityId: string,
 *   patientId: string,
 *   name: string,
 * ): Promise<AccountInfo> {
 *   const res = await fetch(`${getApiUrl()}/api/v1/facility/${facilityId}/account/`, {
 *     method: "POST",
 *     headers: getApiHeaders(),
 *     body: JSON.stringify({
 *       name,
 *       status: "active",
 *       billing_status: "open",
 *       patient: patientId,
 *       service_period: { start: new Date().toISOString() },
 *     }),
 *   });
 *   if (!res.ok) {
 *     throw new Error(`Failed to create account: ${res.status} — ${await res.text()}`);
 *   }
 *   return (await res.json()) as AccountInfo;
 * }
 *
 * // --- Option 2: the `request` fixture (preferred for new helpers) ------------
 * async function createAccountViaRequest(
 *   request: APIRequestContext,
 *   facilityId: string,
 *   patientId: string,
 *   name: string,
 * ): Promise<AccountInfo> {
 *   const res = await request.post(
 *     `${getApiUrl()}/api/v1/facility/${facilityId}/account/`,
 *     {
 *       headers: getApiHeaders(),
 *       data: {
 *         name,
 *         status: "active",
 *         billing_status: "open",
 *         patient: patientId,
 *         service_period: { start: new Date().toISOString() },
 *       },
 *     },
 *   );
 *   await expect(res).toBeOK(); // ergonomic assertion built into the fixture
 *   return (await res.json()) as AccountInfo;
 * }
 *
 * test.use({ storageState: "tests/.auth/user.json" });
 *
 * test.describe("Billing accounts — created via API", () => {
 *   let facilityId: string;
 *   let patientId: string;
 *
 *   test.beforeEach(() => {
 *     facilityId = getFacilityId();
 *     patientId = getPatientId();
 *   });
 *
 *   test("an account created via fetch() appears in the billing list", async ({
 *     page,
 *   }) => {
 *     const name = `Acct ${faker.string.alphanumeric(6)}`;
 *
 *     await test.step("Create precondition account via API", async () => {
 *       await createAccountViaFetch(facilityId, patientId, name);
 *     });
 *
 *     await test.step("Verify it shows in the UI", async () => {
 *       await page.goto(`/facility/${facilityId}/settings/billing`);
 *       await expect(page.getByText(name)).toBeVisible();
 *     });
 *   });
 *
 *   test("an account created via the request fixture appears in the list", async ({
 *     page,
 *     request,
 *   }) => {
 *     const name = `Acct ${faker.string.alphanumeric(6)}`;
 *
 *     await test.step("Create precondition account via request fixture", async () => {
 *       await createAccountViaRequest(request, facilityId, patientId, name);
 *     });
 *
 *     await test.step("Verify it shows in the UI", async () => {
 *       await page.goto(`/facility/${facilityId}/settings/billing`);
 *       await expect(page.getByText(name)).toBeVisible();
 *     });
 *   });
 * });
 */
