| F# | classification | action |
| --- | --- | --- |
| F1 | test-stale | The card label now reads `25 years, Male`; the spec still expects `.*Born …, Male` from the old format. AC1 intentionally changed the age string. Update the locator/assertion in `patientRegistration.spec.ts:354` to the new label. |
| F2 | test-stale | `navigateToPatientDetails` clicks `getByRole("button", { name: /.*Y,.*/ })` — the card name was `25Y, Male`, now `25 years, Male`, so `/.*Y,.*/` no longer matches and the click times out. This is the SAME changed value as F1, not a flake. Update the `/.*Y,.*/` locator in `assignUser.spec.ts:23`. |
| F3 | test-stale | Identical `/.*Y,.*/` card-click locator in `requestCreate.spec.ts:30`, same timeout, same root cause. Update the locator here too — this is the one changed token referenced across F1–F3. |
| F4 | infra | `deviceList.spec.ts:44` times out because the device API returned `503` (retried 3×). Unrelated to the age diff — a backend/environment flake. Make NO edit. |

**Classification.** F1–F3 are all `test-stale` driven by a **single** changed value: the diff reformats
`formatPatientAge` (`25Y` → `25 years`), which flows into the patient card's accessible name. F1 asserts
that label; F2 and F3 *locate* the card by `/.*Y,.*/` to click through — so the same change surfaces as a
`locator.click` **timeout**, not an obvious assertion diff. Per `care-ci-fix` §1.A (locator/label drift)
the fix is the ONE mechanical token swap applied in **every** referencing spec (F1–F3) — the allowed
>2-file case. F4 is a genuine `infra` flake (a `503` on an unrelated spec); despite also being a timeout,
it has nothing to do with the diff → no edit. The trap is treating F2/F3 as `infra` because they time
out; the diff + AC1 show the locator, not the environment, is what changed.
