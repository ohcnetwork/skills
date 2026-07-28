---
id: cf-04-locator-drift-multispec
skill: care-ci-fix
tier: maker
kind: locator-drift
args: develop
---

# cf-04 — One changed value, locators broken across N specs (the eng-747 trap)

The change reformats the abbreviated patient age from `25Y` to the spelled-out `25 years` (AC1). That
age string is also the **accessible name** of the patient card button (`… , Male`), which several e2e
specs use as a **locator** — some to assert, some to *navigate* (click the card, then act). One output
change therefore breaks the locator in multiple specs at once. This is the exact shape that stranded
the live `eng-747-patient-age-format` run: the fixer fixed only the one spec with an obvious assertion
and left the navigation specs red.

The discrimination that matters: **not every timeout is a flake.** Three failures below are the changed
locator; two of them surface as `locator.click Timeout` (a navigation click that can no longer find the
card) — which *looks* like infra but is `test-stale`. A fourth failure is a genuine, unrelated flake.
The fixer must separate them by cross-referencing the diff + criteria, not by pattern-matching on
"TimeoutError".

- **F1** — `patientRegistration.spec.ts:354` — `getByRole("button", { name: /.*Born .*, Male/ })` not
  visible (element not found). The card label changed with the age format → **test-stale**.
- **F2** — `assignUser.spec.ts:23` — `getByRole("button", { name: /.*Y,.*/ }).click()` times out
  (navigation helper). The `/.*Y,.*/` locator keys off the old `25Y` string → **test-stale**.
- **F3** — `requestCreate.spec.ts:30` — same `/.*Y,.*/` card-click locator, same timeout → **test-stale**.
- **F4** — `deviceList.spec.ts:44` — `expect(rows).toHaveCount(3)` times out because the device backend
  returned `503`. Unrelated to the age diff → **infra** (no edit).

Ground truth: [expected.json](./expected.json). The gradeable signal is the per-failure classification
(all four). The correct fix updates the ONE changed token in **every** referencing spec (F1–F3) and
edits nothing for F4 — the multi-file, single-token swap that `care-ci-fix/SKILL.md` §1.A/§3 allows;
applying the edit + re-running the check stays v1.5 (needs live care_fe + Playwright).

Self-contained: `change.diff`, `failures.md`, `criteria.md` are inlined by the runner — no live care_fe
checkout needed (classification is judged from the diff + annotations + criteria).
