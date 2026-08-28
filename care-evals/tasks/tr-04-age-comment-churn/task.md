---
id: tr-04-age-comment-churn
skill: care-triager
tier: judgment
kind: converged-round-churn
args: develop
---

# tr-04 — Triage a converged round without manufacturing churn

**Provenance:** verbatim from the live `care_fe-format-patient-age` run (PR #16578), round 8 —
the triager sidecar `care-triager-r8.result.json` and the round-8 `feedback.md`. The code under
review ([fixture.patch](./fixture.patch)) is the real `formatPatientAge` / `getRelativeDateSuffix`
byte-for-byte as they stood at commit `ccc4b25` (round 8), **relocated verbatim into a standalone
`src/Utils/formatPatientAge.ts`** so the fixture is a self-contained new-file patch that applies on
any base (the live change edited the existing `src/Utils/utils.ts`; only the file home moved, not a
character of the code or comments). The bot findings are the round-8 threads verbatim, re-anchored
to the relocated line numbers.

By round 8 the change had converged: the only real logic fix (the `totalDays >= 364` → `years >= 1`
"0Y 11mo" boundary bug) landed in round 1, and every subsequent round was cosmetic. This fixture
captures the round-8 bot set, where a **correct triage is all-decline** and the loop should exit at
Step 7. In the live run the triager instead verdicted the comment nit `address`, spending another
build → CI → review cycle to reword a comment for the fourth time.

Six findings, all `decline`:

- **F1** (thread 3602360177) — Copilot: the comment parenthetical `diff('years') >= 17` doesn't
  literally match the code `years > 16`. **Equivalent for integer `years`**, and the same line was
  already reworded in rounds 4/6/7 (`[addressed round N]` tags). This is comment bikeshedding →
  **decline** (`polish — not a loop-back` / `comment already reworded`). This is the graded leak: in
  the live run it was `address`, and the reworded comment drew the *next* round's nit. **Critical.**
- **F2** (threads 3602458595 / 3602360154) — the abbreviated year-suffix space, where CodeRabbit
  ("add the space") and Copilot ("remove the space") gave **opposing** advice. Resolved by the
  `17 Y` vs `16Y 6mo` ternary; both threads `[resolved]` → **decline** (`resolved by thread N`, don't
  re-open the contradiction).
- **F3** (thread 3600593499) — i18n suffix finding the bot itself withdrew as out of scope →
  **decline**.
- **F4** (thread 3600594017) — 12-month cutoff, bot withdrew (branch gated on `years >= 1`) →
  **decline**.
- **F5** (thread 3599250068) — the `0Y 11mo` boundary, already fixed in round 1 → **decline**
  (verify the fix is present).
- **F6** (thread 3600609903) — Copilot claims a YOB-only regression for ages 1–16. Verify-before-
  accept: showing "Born …" for YOB-only patients is approved plan behavior and the guard ordering is
  intentional → **decline**. **Critical** (requires real verification, not a resolved-thread copy).

Ground truth: [expected.json](./expected.json). Only **F1 and F6** are exact-graded: they are the two
still-open findings that require active judgment, and both must be `decline`. F2–F5 are `[resolved]`/
withdrawn-thread distractors — the skill itself calls resolved threads *"skippable,"* so `skip` and
`decline` are both correct dispositions (either keeps `addressCount` at 0); grading them on an exact
`decline` token would contradict the skill, so they are present to force sorting but not exact-graded.
A passing triager declines F1 (comment-churn/recurrence rule) and F6 (verify-before-accept), skips or
declines the resolved four, manufactures **no** `address` item, and lets the loop converge at Step 7 —
instead of the rounds 3–9 churn the live run actually spent. missed_by is recorded but not graded.
