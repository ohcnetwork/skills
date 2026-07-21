| F# | classification | action |
| --- | --- | --- |
| F1 | infra | The failing spec (`deviceList`) exercises a flow the diff never touches — the change only shortens a button label on `LocationForm.tsx`. The annotation shows a backend `503` / timeout, and the check passed on the prior run at the same SHA: a transient flake. Make NO edit; the loop should re-poll or hand off. |

**Classification — F1 is `infra`.** The diff is unrelated to the device list, and the failure is a
`503`/timeout (environment), not a stale assertion or a regression. No edit is the correct action —
editing the assertion here would paper over transient infra.
