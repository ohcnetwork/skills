# Failing CI checks (round 5) — bots clean, CI still red

### [F1] e2e — Playwright: patient registration

Check: `test (2)` — conclusion: **failure**

Annotations:
- `tests/facility/patient/patientRegistration.spec.ts:354` —
  `await expect(page.getByRole("button", { name: new RegExp(`.*Born ${year}, Male`) })).toBeVisible()`
  ```
  Error: expect(locator).toBeVisible() failed
  Expected: visible
  Error: element(s) not found
    - Expect "toBeVisible" with timeout 10000ms
  ```

### [F2] e2e — Playwright: assign user to patient

Check: `test (2)` — conclusion: **failure**

Annotations:
- `tests/facility/patient/patientDetails/users/assignUser.spec.ts:23` —
  `await page.getByRole("button", { name: /.*Y,.*/ }).click()`  (inside `navigateToPatientDetails`)
  ```
  TimeoutError: locator.click: Timeout 10000ms exceeded.
  waiting for getByRole('button', { name: /.*Y,.*/ })
      at navigateToPatientDetails (tests/facility/patient/patientDetails/users/assignUser.spec.ts:23:56)
  ```

### [F3] e2e — Playwright: create resource request

Check: `test (2)` — conclusion: **failure**

Annotations:
- `tests/facility/patient/patientDetails/request/requestCreate.spec.ts:30` —
  `await page.getByRole("button", { name: /.*Y,.*/ }).click()`
  ```
  TimeoutError: locator.click: Timeout 10000ms exceeded.
  waiting for getByRole('button', { name: /.*Y,.*/ })
      at tests/facility/patient/patientDetails/request/requestCreate.spec.ts:30:41
  ```

### [F4] e2e — Playwright: device list

Check: `test (1)` — conclusion: **failure**

Annotations:
- `tests/facility/settings/deviceList.spec.ts:44` — `await expect(deviceRows).toHaveCount(3)`
  ```
  TimeoutError: expect(locator).toHaveCount(expected)
  Expected: 3
  Received: 0
  Call log: GET /api/v1/facility/x/device/ → 503 Service Unavailable (retried 3x)
  ```
