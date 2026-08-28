| F# | classification | action |
| --- | --- | --- |
| F1 | test-stale | The spec asserts the pre-change `"25 Y"`; AC1 intentionally changed the format to `"25 years"` and the diff shows `formatPatientAge` now returns `${years} years`. Update the assertion at `patientRegistration.spec.ts:352` to `toHaveText('25 years')`. Do not touch the source. |

**Classification — F1 is `test-stale`.** The diff changed `formatPatientAge` to emit `"25 years"`,
matching AC1; the spec still expects the old `"25 Y"`. The correct fix updates the spec's expected
value to `"25 years"` — not a source change (that would revert an intended behaviour). Never `.skip`
or delete the assertion.
