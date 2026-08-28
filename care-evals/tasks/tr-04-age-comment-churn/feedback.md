# PR #16578 — pre-digested bot feedback   (round 8)
# (author · path:line · thread-id · trimmed body) — grouped by file+line; every comment
# kept. [resolved] threads are skippable. [F#] tags are the triage item ids for this fixture.

## Inline comments
- `src/Utils/formatPatientAge.ts:29`  (the `years > 16` years-only branch comment)
  - **Copilot** (thread 3602360177)  [F1] [addressed round 4] [addressed round 6] [addressed round 7]
      The comment parenthetical `diff('years') >= 17` does not match the actual condition
      `years > 16` (line 31). They are equivalent for integer `years`, but the comment should
      mirror the code exactly to avoid confusion for future editors.

- `src/Utils/formatPatientAge.ts:9`  (abbreviated year suffix)
  - **coderabbitai[bot]** (thread 3602458595)  [F2] [resolved]
      ✅ Confirmed as addressed. Years-only now renders `17 Y` (space, line 33) while years+months
      keeps `16Y 6mo` (no space), satisfying the tier-specific spacing requirement.
  - **Copilot** (thread 3602360154)  [F2] [resolved]
      Abbreviated year spacing resolved — the years-only branch inserts the space explicitly, the
      shared suffix stays `"Y"`. This directly contradicts thread 3602458595's earlier "add the
      space" advice; the ternary reconciles both.

- `src/Utils/formatPatientAge.ts:9`  (i18n)
  - **coderabbitai[bot]** (thread 3600593499)  [F3] [resolved]
      Withdrawing the hardcoded-suffix / i18next finding — localization is explicitly out of this
      PR's approved scope. Can be tracked separately.

- `src/Utils/formatPatientAge.ts:47`  (12-month cutoff)
  - **coderabbitai[bot]** (thread 3600594017)  [F4] [resolved]
      Withdrawing — the years/months path is correctly gated by the calendar-aware `years >= 1`
      check; `totalDays` only controls the sub-one-year branches. Concern does not apply.

- `src/Utils/formatPatientAge.ts:47`  (0Y 11mo boundary)
  - **greptile-apps[bot]** (thread 3599250068)  [F5] [resolved]
      The `0Y 11mo` output for a 364-day-old patient is fixed — branch now gates on `years >= 1`.

- `src/Utils/formatPatientAge.ts:31`  (YOB-only ordering)
  - **Copilot** (thread 3600609903)  [F6]
      The `years > 16` early return (line 31) happens before the `!obj.date_of_birth` guard
      (line 39), so patients with only `year_of_birth` show "Born …" for ages 1–16. Consider
      handling `!date_of_birth` first and returning whole years.

## Summary comments
- **github-actions[bot]** — 🎭 Playwright Test Results: ✅ Passed (332/332).
