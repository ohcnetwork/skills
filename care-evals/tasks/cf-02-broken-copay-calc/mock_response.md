| F# | classification | action |
| --- | --- | --- |
| F1 | code-wrong | The diff changed `netPayable` to `total - copay * 2`, double-subtracting the copay, so `netPayable(100, 10)` returns `80` instead of `90`. AC1 (subtract once) and AC2 (100−10=90) confirm the TEST is correct. Fix the source back to `total - copay`; do not change the test. |

**Classification — F1 is `code-wrong`.** The spec's expected `90` matches AC2, and the diff
introduced a real regression (`copay * 2`). The correct fix is to the source, not the test —
updating the test to expect `80` would ship a billing bug behind a green check.
