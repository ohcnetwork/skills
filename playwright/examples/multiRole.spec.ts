/*
 * GOLDEN EXAMPLE — multi-user / cross-role flow
 *
 * REFERENCE ONLY. This whole file is a comment: the skills repo does not install
 * Playwright or the `tests/...` modules, so nothing here is imported or compiled.
 * Copy the shape into a real spec in care_fe.
 *
 * Derived from the "multi-user messaging" test in
 * tests/facility/patient/encounter/notes/encounterNotes.spec.ts, polished to follow
 * the skill: a second user via browser.newContext() with a different storage state,
 * the context closed in `finally` (so a failing step still releases it), test.step
 * grouping, and waitForResponse to avoid create→list propagation races.
 *
 * ---------------------------------------------------------------------------
 * import { faker } from "@faker-js/faker";
 * import { expect, test } from "@playwright/test";
 *
 * import { getEncounterId } from "tests/support/encounterId";
 * import { getFacilityId } from "tests/support/facilityId";
 * import { getPatientId } from "tests/support/patientId";
 *
 * // Author this test as the admin; the second user authenticates separately below.
 * test.use({ storageState: "tests/.auth/user.json" });
 *
 * test("admin posts a note, facility admin sees and replies to it", async ({
 *   page,
 *   browser,
 * }) => {
 *   const facilityId = getFacilityId();
 *   const patientId = getPatientId();
 *   const encounterId = getEncounterId();
 *   const encounterUrl = `/facility/${facilityId}/patient/${patientId}/encounter/${encounterId}`;
 *
 *   const threadTitle = `Thread ${faker.string.alphanumeric(6)}`;
 *   const adminMessage = `From admin: ${faker.lorem.sentence()}`;
 *   const facAdminMessage = `From facility admin: ${faker.lorem.sentence()}`;
 *
 *   await test.step("Admin creates a thread and posts the first message", async () => {
 *     await page.goto(encounterUrl);
 *     await page.getByRole("tab", { name: "Notes" }).click();
 *
 *     await page.getByRole("button", { name: "New", exact: true }).click();
 *     await page.getByPlaceholder("Enter discussion title...").fill(threadTitle);
 *     await page.getByRole("button", { name: /Create/i }).click();
 *     await expect(page.getByText("Thread created successfully")).toBeVisible();
 *
 *     await page.getByRole("button").filter({ hasText: threadTitle }).click();
 *     await page.getByPlaceholder("Type your message...").fill(adminMessage);
 *     // Wait promise FIRST so the listener is registered before the click
 *     await Promise.all([
 *       page.waitForResponse(
 *         (resp) =>
 *           resp.url().includes("/note/") &&
 *           resp.request().method() === "POST" &&
 *           resp.ok(),
 *       ),
 *       page.getByRole("button", { name: "Send message" }).click(),
 *     ]);
 *     await expect(page.getByText(adminMessage)).toBeVisible();
 *   });
 *
 *   // Second user runs in their own context with a different storage state.
 *   const facAdminContext = await browser.newContext({
 *     storageState: "tests/.auth/facilityAdmin.json",
 *   });
 *   try {
 *     const facAdminPage = await facAdminContext.newPage();
 *
 *     await test.step("Facility admin sees the admin's message and replies", async () => {
 *       // Wait for a threads-list GET that actually contains our thread, so we don't
 *       // race the create propagation (React Query refetches on tab click).
 *       const threadsListed = facAdminPage.waitForResponse(async (resp) => {
 *         if (
 *           !resp.url().includes("/thread/") ||
 *           resp.request().method() !== "GET" ||
 *           !resp.ok()
 *         ) {
 *           return false;
 *         }
 *         const body = await resp.json().catch(() => null);
 *         return body?.results?.some(
 *           (t: { title?: string }) => t.title === threadTitle,
 *         );
 *       });
 *
 *       await facAdminPage.goto(encounterUrl);
 *       await facAdminPage.getByRole("tab", { name: "Notes" }).click();
 *       await threadsListed;
 *
 *       await facAdminPage.getByRole("button").filter({ hasText: threadTitle }).click();
 *       await expect(facAdminPage.getByText(adminMessage)).toBeVisible();
 *
 *       await facAdminPage
 *         .getByPlaceholder("Type your message...")
 *         .fill(facAdminMessage);
 *       await facAdminPage.getByRole("button", { name: "Send message" }).click();
 *       await expect(facAdminPage.getByText(facAdminMessage)).toBeVisible();
 *     });
 *   } finally {
 *     await facAdminContext.close();
 *   }
 *
 *   await test.step("Admin sees both messages after refresh", async () => {
 *     await page.goto(encounterUrl);
 *     await page.getByRole("tab", { name: "Notes" }).click();
 *     await page.getByRole("button").filter({ hasText: threadTitle }).click();
 *     await expect(page.getByText(adminMessage)).toBeVisible();
 *     await expect(page.getByText(facAdminMessage)).toBeVisible();
 *   });
 * });
 */
