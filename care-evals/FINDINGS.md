# care-evals — findings & how-to (durable digest)

Persistent summary for future sessions. The raw per-run outputs under `results/` are **gitignored and
regenerable** — this file is the reference that survives deleting them. Dated roll-ups
(`results/LADDER-*.md`, `results/UX-*.md`) hold the fuller tables while they exist.

care-evals is the **control arm** of self-improving skills: run care-* skills on fixed fixtures with
known ground truth, grade the output, and get before/after deltas that arm the human gate. (Doctor
discovers from live runs; evals verify a fix.)

## How to run (reliable path, 2026-07-13)

```bash
# 1) start ONE warm server (authed GitHub Copilot — the reliable, credit-free tier path)
opencode serve --port 4599 >/tmp/oc_serve.log 2>&1 &

# 2) run a task / sweep (from care-evals/runner)
python3 run_eval.py <task|comma-list|all> --adapter opencode --model github-copilot/claude-haiku-4.5 \
        --results-dir ../results/<label>
```

**Adapters (`--adapter`):**
- `opencode` — serve HTTP, sync `POST /session/{id}/message`, fresh session + tools disabled per call. **Use this.**
  - `github-copilot/<model>` = authed copilot: `claude-haiku-4.5 / claude-sonnet-4.6 / claude-opus-4.8`, `gpt-5.x`, `gemini-*` — **reliable, credit-free (the tier-ladder path).**
  - `opencode/<model>` = free (`deepseek-v4-flash-free`, …) — **flaky under sustained load** (intermittent 500s / empty output); spot checks only.
- `mock` — replays `tasks/<id>/mock_response.md`; zero model; **fixture self-test** (run before trusting a real result).
- `openrouter` — OpenAI SDK → OpenRouter; key from repo `.env`. **NO CREDIT right now — do not use.**
- `opencode-run` — legacy `opencode run` CLI; **wedges under batch load; avoid.**
- `sdk` — `claude` CLI; not installed in this environment.

Fidelity: the runner inlines each skill's **real `SKILL.md`** + inputs into the prompt, so editing a
skill actually moves the numbers.

## Findings to date — the cost answer is PER-SKILL

| skill | verdict | evidence |
|---|---|---|
| **care-test-grade** | **Haiku suffices** — after a rubric + fixture fix (resolved 2026-07-17) | The old "free suffices" verdict was on the 2-task suite, which couldn't discriminate. Expanding to 4 tasks (tg-03/04) exposed a **rubric under-specification**, not a tier gap: a presence-only assert of a value-criterion was ground-truthed `Weak`, but **both Haiku and Sonnet graded it `Wrong`→block**. **Decision (skill owner): the models were right — presence-instead-of-value is `Wrong` (the spec verifies nothing the criterion claims → must be rewritten).** Fixes shipped: (1) sharpened the `care-test-grade` Weak-vs-Wrong rubric line (Weak = verifies the claim but thinly; Wrong = doesn't verify the claim: contradicts / asserts unrelated behavior / asserts presence-instead-of-value); (2) re-grounded fixtures — **tg-04** AC2 `Weak`→`Wrong`/block (also the IMP-10 guard: fix routes back to the plan), **tg-01** AC2 redesigned to a genuine thin-but-faithful `Weak`, **tg-02** AC2 re-grounded to a legitimate `Weak` (first-row-only distinctness; two models independently flagged it) making it a mixed precision + Weak-not-block control. **Result: Haiku 4/4** (was 3/4). The sharper rubric is genuinely stricter — it correctly surfaced tg-02's thin AC2 that the old rubric let pass. **Sonnet 4/4** after the grader parser fix (2026-07-20): its tg-01 "FAIL 0.5" was a grader parse artifact — the AC2 `Verdict` column read `Weak` (correct) but the `Finding` column "fail on a **wrong** value" tripped the rightmost-token parser → `Wrong`. Column-aware parsing (`by_column`) fixed it → tg-01 now grades `Weak`, real acc 0.75, PASS. The only remaining Sonnet miss was AC1 `Weak` vs truth `Covered` (defensibly stricter), inside the pass threshold. **tg-04 passes on Sonnet too** (Wrong/block, acc 1.0), so the decision holds across tiers. See the parser-robustness lesson below. |
| **care-review** | needs **≥ Haiku** (not free) | **Full tier ladder now complete (2026-07-13): Haiku 4.5 = Sonnet 4.6 = Opus 4.8, all 6/6 @ score 1.00, fp 0.** No fixture in the suite separates the tiers. Free: 4/5 miss cr-01's correctness bug AND are unreliable (mimo returns empty on cr-03). |
| **care-ux-review** | **Haiku** (after a skill fix) | Haiku 5/5 on the extended skill (incl. 320px + workflow). |

- "Judgment = Opus" is **too blunt** — it's skill-specific.
- The suite has **hit its ceiling as a discriminator** for care-review: the full tier ladder (Haiku→Sonnet→Opus, all via Copilot) is a clean 6/6 across the board, so **no current fixture tells you where Haiku breaks** — only that Haiku is *sufficient* for this bug difficulty. cr-06 (cross-file) was the hardest attempt and Haiku still matched frontier. n=1 per cell — variance runs still pending.
- **Copilot rate-limit artifact, not capability:** the first Opus batch dropped cr-05/cr-06 (empty results under rapid Opus calls). Rerun in isolation, Opus scored 1.0 on both — the gap was transport, not the model. Space out rapid frontier calls.

## Skill improvements shipped (verified by an eval delta)

- **care-ux-review/SKILL.md** — added (1) a **smallest-device 320px** check (rubric only reasoned to
  375px), and (2) a **"Workflow efficiency (hospital context)"** rubric section + intro framing
  ("clinician time is patient-care time"). Before: Haiku missed ux-03 (320) + ux-04 (4-screen wizard).
  After: Haiku 5/5. This is the "no skill edit without an eval delta" rule in action.

## Operational lessons (these bit us — heed them)

- **A failing CLEAN control is usually a fixture bug, not a model failure.** Clean-control
  `must_not_flag` signals must be **unambiguous wrong-claim phrases** — broad words (`float`,
  `fixed width`) substring-match the model's *praise* and produce false "FAILs". Bit us 3× (tg-02,
  cr-05, ux-05). Always **`--adapter mock` self-test** a new fixture first; re-derive a red control by hand.
- **GRADER BUG — FIXED 2026-07-20.** test-grade verdicts *were* parsed as the rightmost verdict-vocab
  token in each `| ACn |` table row, so a verdict word in the NOTE column mis-scored the row. It bit
  two ways: (1) fixture authoring — a verdict word in `mock_response.md` note prose; (2) **real model
  outputs — unfixable by fixture edits.** 2026-07-17 Sonnet graded tg-01 AC2 `Weak` (correct) but its
  `Finding` column said "fail on a **wrong** value" → parsed `Wrong` → task FAILed at acc 0.5 when
  real acc was 0.75. **Fix shipped:** `_grade_test_grade` now calls `parse_verdict_table(..., by_column=True)`,
  a column-aware read that takes the cell **immediately after the id cell** (the verdict column) and
  ignores any verdict words in later note/finding columns; it falls back to a prose scan only when no
  such table row exists (`runner/grader.py`: `_row_cells` / `_verdict_after_id_cell` / the `by_column`
  branch). Verified: the four fixtures still self-test 4/4 under mock, and **re-grading the saved
  2026-07-18 Sonnet tg-01 output recovered 0.5→0.75 (FAIL→PASS)** — AC2 now reads `Weak` from the
  `Verdict` column instead of `Wrong` from the `Finding` column. (Triage/ci-fix still use the
  `leftmost` reader — robust there because their verdict is the first column after the id and the id
  isn't a verdict word; column-aware could extend to them later but wasn't needed.)
- **Read the API docs before engineering around a tool.** Days of "timeouts" were the wrong opencode
  endpoint (async admit-poll) + `id` vs `modelID`; the sync endpoint + tools-off fixed everything.
- Grading is signal-based recall (substring) over `must_flag` + `must_not_flag` FP count; optional
  LLM-judge layer (`runner/grader-agent.md`). A word-boundary/negation-aware matcher would cut the
  clean-control fragility.

## Fixtures inventory (`tasks/`)

- **care-review:** cr-01 discount-math (3 defects) · cr-02 clean · cr-03 nullish `||`/`??` · cr-04
  offset off-by-one · cr-05 complex-clean · cr-06 cross-file regression (discriminator).
- **care-test-grade:** tg-01 rubber-stamp specs (one of each verdict; AC2 = thin-but-faithful Weak) ·
  tg-02 mixed control (AC1/AC3 Covered = precision · AC2 = genuine Weak-not-block) · tg-03
  asserts-unrelated (Wrong flavor — green toast stands in for the recomputed value) · tg-04
  surrogate-dodge (Wrong/block — presence-instead-of-value dodge of a fixture-absent invoice number;
  IMP-10 guard, fix routes back to plan). **Three distinct block triggers:** rubber-stamp buggy value
  (tg-01), unrelated behavior (tg-03), presence-instead-of-value (tg-04).
- **care-ux-review:** ux-01 overflow · ux-02 no-mobile · ux-03 320px small-device · ux-04
  navigation-burden (4-screen BP wizard) · ux-05 complex-clean.

## Frontier tier-ladder baseline — 2026-07-13 (complete)

All three tiers run on the full 6-fixture care-review suite via Copilot (credit-free). Haiku fixtures
span three run dirs (`ladder-haiku` cr-01/02 · `harder/haiku` cr-03/04/05 · `discriminator` cr-06);
Sonnet + Opus in `results/frontier-2026-07-13/`.

| Fixture | Haiku 4.5 | Sonnet 4.6 | Opus 4.8 |
|---|---|---|---|
| cr-01-invoice-discount-bug | PASS | PASS | PASS |
| cr-02-clean-status-badge | PASS | PASS | PASS |
| cr-03-copay-nullish | PASS | PASS | PASS |
| cr-04-pager-offbyone | PASS | PASS | PASS |
| cr-05-grouped-totals-clean | PASS | PASS | PASS |
| cr-06-shared-unit-mismatch | PASS | PASS | PASS |
| **Total** | **6/6** | **6/6** | **6/6** |

All cells score 1.00, stddev 0.00, fp 0 (clean controls cr-02/cr-05 correctly signalled clean).
**Conclusion:** the `Opus → Haiku` pin for care-review is fully validated *on this suite* — but the
suite can no longer discriminate. Finding Haiku's actual ceiling needs a genuinely harder bug class.

**Operational decision (2026-07-13):** continue running care-review on **Opus** for now. The ladder
proves Haiku is *sufficient on tested difficulty*, not that it holds on the harder classes below;
frontier access is reliable + credit-free via Copilot, so there's no cost pressure to downshift yet.

## Open / next

- **Author harder bug classes** — the real test of whether care-review can leave Opus. Priority order:
  (1) **large multi-file / cross-module invariant** (cause and symptom in different files — highest
  chance of separating tiers), (2) **race/ordering** (async interleaving, stale-closure, effect-cleanup
  ordering), (3) **security-adjacent** (authz checks, injection sinks, unsafe deserialization). Run each
  across the full ladder now that the credit wall is gone.
- **Variance runs** (n≈5) on the correctness/UX fixtures — confirm single-run PASSes aren't luck.
- Grader hardening (word-boundary matching) to reduce clean-control signal fragility.
