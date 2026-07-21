# Failing CI checks (round 2) — bots clean, CI still red

### [F1] e2e — Playwright: device list

Check: `playwright / devices` — conclusion: **failure** (this check PASSED on the previous run at this
same commit SHA)

Annotations:
- `tests/facility/devices/deviceList.spec.ts:88` — `await expect(page.getByRole('row')).toHaveCount(3)`
  ```
  TimeoutError: locator.waitFor: Timeout 10000ms exceeded.
  waiting for getByRole('row') to have count 3
  (network log: GET /api/devices returned 503 Service Unavailable during this run)
  ```
