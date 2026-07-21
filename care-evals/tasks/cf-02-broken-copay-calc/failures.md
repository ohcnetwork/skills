# Failing CI checks (round 2) — bots clean, CI still red

### [F1] unit — vitest: billing/copay

Check: `test / unit` — conclusion: **failure**

Annotations:
- `src/components/Billing/copay.test.ts:24` — `expect(netPayable(100, 10)).toBe(90)`
  ```
  AssertionError: expected 80 to be 90
  Expected: 90
  Received: 80
  ```
