# Failing CI checks (round 3) — bots clean, CI still red

### [F1] e2e — Playwright: patient registration

Check: `playwright / patient` — conclusion: **failure**

Annotations:
- `tests/patient/patientRegistration.spec.ts:352` — `await expect(ageCell).toHaveText('25 Y')`
  ```
  AssertionError: Timed out 5000ms waiting for expect(locator).toHaveText(expected)
  Expected string: "25 Y"
  Received string: "25 years"
  ```
