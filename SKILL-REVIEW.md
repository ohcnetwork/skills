# Skill Review & Improvement Recommendations

**Scope:** Individual review of each care-loop skill, improvement opportunities, and alignment with Loop Engineering patterns.

---

## 1. care-diff-review — Intent/Legibility Lens

### Current State
- **Role:** Reconstructs what the code does and what requirement it fulfills, flags legibility gaps
- **Quality:** Excellent foundational work; methodology is sound and well-scoped
- **Scope:** Diff → intent + legibility findings (not approach/simplification)
- **Audience:** Individual developers, care-review dispatcher, care-loop Step 4a

### Strengths
✅ Clear separation of concerns (legibility vs. approach vs. UX)  
✅ Strong anti-pattern list (vague names, fat handlers, mixed flows)  
✅ Refactor-safety mode handles behavior-preserving-only changes well  
✅ "Legibility-sized, not a rewrite" guardrail prevents bloat  
✅ Correctly deprioritizes correctness as secondary (legibility is the job)  

### Improvement Opportunities

#### **1.1 — Intent reconstruction could be more systematic**
**Problem:** Step 2 (reconstruct intent) is prose-based but doesn't have a structured template or checklist.

**Impact:** Confidence scoring is subjective; different reviewers may reconstruct at different detail levels.

**Recommendation:**
- Add a **mini-checklist** after Step 2:
  ```
  - Does this change add behavior or modify existing?
  - What's the entry point (component mount? event handler? API call)?
  - What's the exit point (render output? side effect? data written)?
  - Does it touch shared state or only local/props?
  - Any fallback/edge paths?
  ```
- This doesn't over-formalize, but ensures consistent reconstruction depth
- Output: same prose, but backed by a mental model check

**Effort:** Very low; add 5–6 lines to the methodology region.

---

#### **1.2 — Legibility finding taxonomy could be tighter**
**Problem:** Findings (Step 3) are grouped as "misleading names," "purpose not evident," "fat handlers" but there's no structured severity/priority.

**Impact:** Long legibility reports become hard to triage; it's not clear which gaps block understanding vs. are style.

**Recommendation:**
- Add a **severity tier** to each legibility finding (using the same vocabulary as care-ux-review):
  - `Broken` — code is actively misleading or illegible (names/structure/flow)
  - `Convention` — violates a documented pattern in `CLAUDE.md`
  - `Polish` — minor/style; refactor-safe and low cost
  
- Example output:
  ```
  ## Legibility findings
  
  **Broken (blocks understanding)**
  - `releaseLocation()` does a reserve, not a release → rename to `markLocationAsReserved`
  
  **Convention** (repo style)
  - Handler comments should cite the event + expected side effect (see CLAUDE.md section 3.2)
  
  **Polish** (optional)
  - Inline comments describing the loop logic; extract to a named function if the names don't carry it
  ```

- This lets care-loop Step 4a route `Broken` findings to loop-back (Step 3) immediately, while deferring Polish

**Effort:** Low; restructure Step 3 output, add tier labels.

---

#### **1.3 — No guidance on reconstructing intent for very large or complex diffs**
**Problem:** For a 500-line diff across 10 files, the instruction "state plainly: what it does" is underconstrained.

**Impact:** Reviewers may produce overly-summary intents that obscure the change structure.

**Recommendation:**
- Add a **branching section in Step 2**:
  ```
  ## For large diffs (5+ files, 200+ lines)
  
  Instead of one unified intent, organize as:
  - Per file or per feature (if the change is structured that way)
  - Callout: "These features are modified; this feature is added; these are unchanged"
  - Cross-file data flow if it's material
  ```
- For care-loop runs, this structured format also feeds Step 4b (test-grader) better

**Effort:** Low; add conditional structure to Step 2.

---

#### **1.4 — Care-loop mode (writing intent.md) should explicitly say what test-grader will read**
**Problem:** Step 4 (the note for loop-invoked runs) tells you to write `intent.md` for step 4b, but doesn't say *what format* or *how detailed* test-grader needs.

**Impact:** Reviewers guess the level; care-test-grade sometimes doesn't have enough context to grade specs.

**Recommendation:**
- Link to care-test-grade's "Step 1 — Gather" section in the loop-invoked note
- Add: "Your intent becomes the `intent.md` ground truth for test-grading. Err toward **per-change** intent (each distinct behavior change) rather than one summary. Test-grader will grade whether the specs cover all changes you reconstructed."

**Effort:** Very low; clarify the handoff.

---

## 2. care-technical-review — Approach/Simplification Lens

### Current State
- **Role:** Judges proportionality of the solution (is it the simplest approach?)
- **Quality:** Very strong; clear guardrails against bias
- **Scope:** Diff → overengineering + simplification findings
- **Audience:** Individual developers, care-review dispatcher, care-loop Step 4a

### Strengths
✅ "Bias hard toward less code" is explicit and calibrated  
✅ "No changes warranted is a valid result" prevents fake findings  
✅ Strong reuse heuristics (existing components, hooks, utils)  
✅ Efficiency section correctly flags only **real** cost, not principle-based  
✅ Guardrails section catches over-indexing on metrics  

### Improvement Opportunities

#### **2.1 — Could benefit from a "what good looks like" reference section**
**Problem:** The skill says "the simplest solution" but doesn't show examples of proportionate vs. overengineered in the CARE codebase.

**Impact:** Reviewers must infer the baseline; new reviewers especially struggle with "what counts as overengineering here?"

**Recommendation:**
- Add a **Reference — proportionate solutions** section with 2–3 mini-examples from the CARE codebase:
  ```
  ### Example 1: Adding a validation banner
  
  **Overengineered:** new context, custom hook, state container, config system
  **Proportionate:** extract the banner to a reusable component (shadcn/Alert + icon), pass the content/icon as props
  
  **Lesson:** if it's genuinely one-off, a component is proportionate. Context is not.
  ```

- Link to the care-evals repo if there are example fixes that show "before/after simplification"

**Effort:** Medium; requires finding real examples and writing them up. But this becomes a strong training asset.

---

#### **2.2 — Redundancy section could distinguish "deduped" vs. "consolidated vs. derived"**
**Problem:** The skill says "drop state that mirrors props, other state, or server data" but doesn't clarify the remedy.

**Impact:** Reviewers may suggest combining two things that shouldn't be, or not realize when they can derive instead of duplicating.

**Recommendation:**
- Expand **Simplification → Remove redundancy** with a decision tree:
  ```
  ### Remove redundancy — the three cases
  
  **Mirrored state** (a local state that equals a prop)
  → Delete the state, read the prop directly
  
  **Computed value** (a state that could be derived from other state/props)
  → Delete the state, compute the value at render time (or useCallback if the deps are stable)
  
  **Cache** (a state that duplicates server data but only for performance)
  → Keep it; flag only if the cache invalidation is wrong
  ```

**Effort:** Low; add a structured decision tree.

---

#### **2.3 — Efficiency section needs a "real cost" metric (DOM nodes, queries, renders, bytes)**
**Problem:** "Efficiency — only where it's real" is good guardrail but vague. What's "real"?

**Impact:** Reviewers disagree on what's efficiency vs. premature optimization.

**Recommendation:**
- Add concrete threshold examples:
  ```
  **What counts as real efficiency gain:**
  - N extra network queries on a common flow (measure: query count in a typical user session)
  - Render cost: a component that re-renders 100+ times unnecessarily
  - DOM bloat: adding 1000+ DOM nodes when 100 would suffice
  - Bundle size: adding 50+ KB when equivalent exists in the repo
  
  **What's not real efficiency (skip):**
  - "This function does two things instead of one" (code clarity is different from efficiency)
  - "We could cache this" without measuring the cache-hit rate (premature)
  - Reducing 5ms to 3ms in an uncommon flow
  ```

**Effort:** Low; add examples with thresholds.

---

#### **2.4 — No explicit integration point with the loop's round-back / findings escalation**
**Problem:** The skill outputs "findings" but doesn't say which findings loop Step 4a → Step 3 loopback vs. which are advisory.

**Impact:** care-loop Step 4a has to infer a tiering system.

**Recommendation:**
- Add a **care-loop integration note** in the Output section:
  ```
  ### For care-loop runs (Step 4a invocation):
  
  Tier your findings for the orchestrator:
  
  **Loopback required (implement Step 3):**
  - Overengineering that blocks proportionality (unnecessary abstraction, new file when reuse is possible)
  - Redundancy that costs real efficiency (duplicate queries, cache invalidation bugs)
  
  **Advisory (round notes, no loopback):**
  - Polish simplifications that are good-but-optional
  - Refactoring that improves readability but doesn't change behavior
  ```

**Effort:** Very low; clarify the boundary.

---

## 3. care-ux-review — UX/Accessibility/Layout Lens

### Current State
- **Role:** Checks overflow, layout integrity, a11y, and Tailwind conventions (static + optional live)
- **Quality:** Excellent; very thorough with mobile-first and clinical context
- **Scope:** Diff (static) + Playwright browser automation (live, optional)
- **Audience:** Individual developers, care-review dispatcher, care-loop Steps 4a + 4c

### Strengths
✅ Hospital context is explicit (clinician time = patient care time)  
✅ Severity tiers map correctly to care-loop gates  
✅ Mobile-first; tests down to 320px (older Android, iPhone SE)  
✅ Sibling-surface validation prevents breaking shared components  
✅ Workflow efficiency section is thoughtful (multi-step wizard anti-pattern)  
✅ Long-content stress-testing strategy (inject 50+ chars) is good  

### Improvement Opportunities

#### **3.1 — Static mode could explicitly check CSS-in-JS issues (Tailwind @apply, nested rules)**
**Problem:** Modern Tailwind (v4) and component libraries sometimes use @apply or CSS nesting that can cause unexpected overflows. The skill only checks the HTML.

**Impact:** A CSS override that looks benign in the diff can break layout in subtle ways (z-index stacking, overflow encapsulation).

**Recommendation:**
- Add to Static mode **Overflow / layout** section:
  ```
  ### CSS layer checks (if any .css/.scss is in the diff)
  
  - Any @apply combining multiple utilities that could conflict (e.g., @apply w-full p-4 on an already-constrained parent)?
  - Nested selectors that override Tailwind defaults (especially overflow, flex-wrap, min-width)?
  - z-index layers that could break stacking context (compare to tailwind.config.js)?
  ```

- This is especially important for CAREUI components that may wrap Tailwind + custom CSS

**Effort:** Low; add 5–6 lines to the static methodology region.

---

#### **3.2 — Live mode authentication should document session persistence across surfaces**
**Problem:** Step 4c notes "the browser session persists login" but doesn't say what to do if you hit a logout or session expiry.

**Impact:** Live validation can fail mysteriously if the session drops between surfaces.

**Recommendation:**
- Add to Live mode **Auth** section:
  ```
  ### Session persistence & re-auth
  
  The session persists across navigations in one browser. If you hit a logout or session expiry:
  1. Restart the browser (a new session)
  2. Re-authenticate
  3. Resume validation
  
  Flag any surface that forces an unexpected logout — it's likely a bug or an auth flow change not mentioned in decisions.md.
  ```

**Effort:** Very low; clarify an edge case.

---

#### **3.3 — Live mode screenshot naming is fragile; could encode more metadata**
**Problem:** Screenshots are named `<surface-slug>-<width>.png`. If a surface has multiple states (expanded/collapsed, loading/loaded) the slug alone doesn't distinguish them.

**Impact:** care-loop Step 5 PR-comment builder can't easily associate finding → screenshot if one surface appears in two states.

**Recommendation:**
- Extend naming to include an optional state suffix:
  ```
  <surface-slug>[-<state>]-<width>.png
  
  Examples:
  - dashboard-375.png (default state)
  - patient-detail-expanded-768.png (expanded sidebar state)
  - patient-search-loading-1280.png (loading spinner state)
  ```

- Document: "If a surface has multiple distinct states (e.g., accordion expanded/collapsed), include the state in the filename."
- This is a **backward-compatible addition** — existing `surface-width` names still work.

**Effort:** Low; clarify the naming scheme in the Output section.

---

#### **3.4 — Workflow efficiency section could distinguish "design opportunity" from "bug"**
**Problem:** The skill flags multi-step wizards as Broken if they burden a frequent workflow. But sometimes a multi-step flow is intentional (destructive action, complex decision, regulatory requirement).

**Impact:** Reviewers often escalate workflow findings as Broken when they're actually design trade-offs.

**Recommendation:**
- Reframe the section with a **decision tree**:
  ```
  ### Workflow efficiency — distinguish design trade-off from bug
  
  **Is this a bug?** (flag as Broken)
  - A routine action (recording a vital, adding an order) now requires multiple screens when it didn't before
  - Unnecessary round-trips (fetch data, go to another screen, come back to edit)
  - A context switch (modal → page → back) that the code doesn't justify
  
  **Is this a design trade-off?** (flag as Polish or defer to design review)
  - A multi-step wizard for a complex decision (legitimate if each step narrows options)
  - A destructive-action confirmation (Broken only if the confirmation is duplicated or unclear)
  - A legally-required consent step (never block these; note the necessity)
  - A high-friction task that the user rarely does (Polish only)
  
  **Ask the planner (Step 1):** if the flow is disputed, it should have been surfaced in decisions.md.
  ```

**Effort:** Low; add decision guidance.

---

#### **3.5 — No guidance on testing dynamic content overflow (server-side HTML with variable length)**
**Problem:** The skill stresses long-content (inject 50+ chars) but doesn't address server-side variability (a name field from the database could be 100+ chars).

**Impact:** A field that looks fine with test data can overflow in production.

**Recommendation:**
- Add to Live mode **Long-content stress** section:
  ```
  ### Stress-test data length
  
  For any field sourced from server/database (patient name, order description, lab results), check:
  - The database schema's `max_length` or documented max
  - Real data examples (ask the user or check the test fixtures)
  - Inject a value at or above the max; re-screenshot and re-probe
  
  Common culprits:
  - Patient names (can be 100+ chars for name + title + suffix)
  - Clinical notes (arbitrary length, often truncated but not always)
  - Drug/lab names (lengthy standardized terminology)
  ```

**Effort:** Low; add guidance on data-sourced field testing.

---

## 4. care-test-grade — Checker Lens for Specs

### Current State
- **Role:** Grade whether test specs actually cover acceptance criteria (checker ≠ maker split)
- **Quality:** Excellent design; strong anti-patterns against circular reasoning
- **Scope:** Criteria (ground truth) + Intent (cross-check) + Specs (under grade)
- **Audience:** Step 4b in care-loop (checks implementer's e2e specs)

### Strengths
✅ Maker/checker split is foundational (prevents specs that rubber-stamp code)  
✅ Anti-circularity check is the core strength (spec ≠ code; spec = criteria)  
✅ Verdicts (Covered / Weak / Missing / Wrong) are well-calibrated  
✅ Only `Wrong` blocks; advisory doesn't create perverse incentives  
✅ Edge-case and negative-path grading catches incomplete specs  

### Improvement Opportunities

#### **4.1 — Missing explicit guidance on "faithfulness" testing (real flow vs. shortcuts)**
**Problem:** Step 2 mentions "exercises the real user flow, not a shortcut" but doesn't define what makes a flow "real."

**Impact:** Implementers cut corners (seed state, mock APIs) and grader struggles to call it out.

**Recommendation:**
- Add a **Faithfulness sub-section** in Step 2:
  ```
  ### Faithfulness — does the spec exercise the real user flow?
  
  **Real flow:** user action (click, type, submit) → app handles it → verify outcome
  
  **Shortcuts (flag as Weak):**
  - Seeding state directly (e.g., `page.goto("…?patientId=123")` instead of searching)
  - Mocking API responses without going through the real request
  - Asserting on internal state or implementation details (e.g., store.userCount)
  - Skipping a required interaction (e.g., accepting a consent modal) to speed up the test
  
  **Exception:** if the flow is blocked by slow/unreliable backend, clarify in the finding why the shortcut is necessary (e.g., "backend pagination is unreliable; testing with seeded data"). Flag for follow-up testing once the backend stabilizes.
  ```

**Effort:** Low; add a sub-section with examples.

---

#### **4.2 — No guidance on testing interaction patterns (modals, dropdowns, tabs) that specs often miss**
**Problem:** Implementers frequently write specs that test "the modal exists" but not "the modal closes on Escape" or "focus trap works."

**Impact:** A spec can be Green but miss core interaction guarantees.

**Recommendation:**
- Add to Step 2 a **Interaction pattern checklist**:
  ```
  ### Common interaction patterns — always include in specs
  
  If the spec touches any of these, the test should verify the full pattern:
  
  **Modals:** opened (trigger + appears) + closes (Escape key, outside click, close button)  
  **Dropdowns:** open (click/arrow), select (click/keyboard), close (Escape/outside), focus management  
  **Tabs:** select (click/arrow), content updates, focus stays on tab button  
  **Forms:** validation (pre-submit feedback), submission (happy path + error path)  
  **Lists/tables:** pagination (prev/next, page indicator), sorting (verify order), filtering  
  **Async operations:** loading state (spinner/skeleton), success (data rendered), error (retry shown)  
  
  A `Missing` verdict when a pattern is touched but the interaction isn't fully tested.
  ```

**Effort:** Medium; requires validating against Playwright best practices for each pattern.

---

#### **4.3 — Step 1 (Gather) doesn't address what to do if specs don't exist**
**Problem:** The skill says "Grade only when specs exist — the e2e track is optional, so 'no specs' is not a failure here." But it doesn't say **what to do next.**

**Impact:** care-loop Step 4b stalls if there are no specs; unclear whether to block or proceed.

**Recommendation:**
- Add to Step 1:
  ```
  ### If specs don't exist
  
  This is not a failure — the e2e track is optional. Report:
  ```
  No e2e specs provided; Step 4b test-grade passes (no specs to grade).
  
  Rationale: [cite whether specs are tracked in this repo's test plan, or if e2e is opt-in]
  ```
  
  Then proceed to return an empty table (all criteria are uncovered). The orchestrator may ask the implementer to add specs in the *next round* (if the loop runs), but doesn't block on absence.
  ```

**Effort:** Very low; clarify the no-spec path.

---

#### **4.4 — No explicit integration with loop Step 4b loopback (which findings cause implementer to loop back to Step 3)**
**Problem:** The skill outputs `Wrong` but doesn't say what the remedy is (fix the spec? fix the code?).

**Impact:** care-loop Step 4b implementer doesn't know whether to "rewrite the test" or "you wrote the wrong code, go back to Step 3."

**Recommendation:**
- Add to **Step 3 — Report & gate** section:
  ```
  ### For care-loop runs (Step 4b invocation):
  
  **If you find `Wrong`:**
  The spec contradicts the criteria. Before the implementer re-writes the test, **verify which is actually wrong:**
  1. Does the code fulfill the criterion? → spec is wrong; implementer fixes test (stays in Step 4b)
  2. Does the code NOT fulfill the criterion? → implementation is wrong; loop back to Step 3 (implementer re-codes)
  
  Report both the verdict and your assessment: "Wrong — criterion is X, spec asserts Y, code does Z. Verdict: **code is wrong, loop to Step 3** / **test is wrong, implementer fixes**."
  ```

**Effort:** Low; clarify the loopback path.

---

#### **4.5 — Coverage gaps should distinguish "partial coverage is ok" from "critical gap"**
**Problem:** A criterion covered by 1 spec is `Covered`, but a *critical* criterion covered by 1 weak spec should be higher priority for fixing.

**Impact:** Implementers often defer fixing weak specs on critical paths because the verdict is advisory.

**Recommendation:**
- Add a **priority flag** to Weak/Missing verdicts:
  ```
  ## Step 2 — Grade each acceptance criterion (extended)
  
  For every criterion, also mark **criticality**:
  - **Critical:** if the criterion is in the main user flow (failure breaks the feature)
  - **Secondary:** if it's a fallback/edge case or uncommon flow
  - **Polish:** if it's UX quality, not core behavior
  
  A `Weak` verdict on a **Critical** criterion should be highlighted in the report:
  ```
  Critical Weak Finding: "Submit button validation" is only asserted trivially.
  Recommend fixing before merge, not deferring.
  ```
  
  Non-critical `Weak` findings can legitimately ship.
  ```

**Effort:** Low; add a priority dimension.

---

## 5. care-loop-doctor — Diagnostic Tool

### Current State
- **Role:** Read a loopd run's journal + artifacts, judge it against 8-dimension rubric, report findings + backlog
- **Quality:** Excellent; journal-based diagnosis is sound; rubric is comprehensive
- **Scope:** Standalone tool; never runs or controls the loop
- **Audience:** Loop retrospective, self-improvement backlog, skill calibration

### Strengths
✅ Journal as primary evidence (no chat-session archaeology)  
✅ 8-dimension rubric covers all failure classes (model, termination, token, pipeline, validity, bot-round, trends, escapes)  
✅ Exact reads eliminate inference bias  
✅ Escape attribution (which step missed which class) feeds skill improvement  
✅ Durable backlog (IMPROVEMENTS.md) with fingerprinting prevents duplicate findings  
✅ Apply scope split (apply-now vs propose-only) respects tested-code boundaries  

### Improvement Opportunities

#### **5.1 — Dim 8 (escape attribution) lacks guidance on "credibility weighting" across runs**
**Problem:** A single `care-reviewer` missing a logic defect is noise; five consecutive runs missing the same class is a signal. But the skill doesn't guide how much data to accumulate.

**Impact:** Doctor may flag a finding after one run, causing skill changes that later show no real regression.

**Recommendation:**
- Add to rubric **Dim 8** section:
  ```
  ### Dim 8 — Escape attribution (cross-run signal detection)
  
  **Sample size & credibility:**
  - 1 escape: data point; record but don't propose a skill fix yet
  - 2–3 escapes (same class × missed_by): pattern emerging; propose a lighter fix (clarify guidance, add example)
  - 4+ escapes in 10 runs: strong pattern; propose a methodology change or skill revision
  
  **Cross-run trends:**
  - Aggregate `verdicts.md` across the last N runs (typically 3–5)
  - Group by `class × missed_by` pair
  - Weigh by recency (recent runs more credible than old; fixes may have landed)
  ```

**Effort:** Low; add credibility guidance.

---

#### **5.2 — No explicit guidance on "dim interactions" (findings that span multiple dimensions)**
**Problem:** A finding like "planner ran on Sonnet tier" (Dim 1) and "model cost was high" (Dim 3) are related, but the doctor doesn't call out the interaction.

**Impact:** Doctor may miss the real story (cheap model led to high retry count, which led to high cost).

**Recommendation:**
- Add a **Finding correlation** pass in the Analyze step:
  ```
  ## Analyze — correlation pass (after rating all 8 dimensions)
  
  Before reporting, check for finding interactions:
  - High `spawn.retry` count + wrong model tier → the tier choice may have caused retries
  - `budget.stop max_rounds` + high `addressCount` per round → loop isn't converging; maybe triage is missing a class
  - Model tier escalation used early + low cost for that round → escalation was necessary
  
  Mention interactions in the report as "Contributing factors" under the primary finding.
  ```

**Effort:** Low; add a correlation checklist.

---

#### **5.3 — No systematic way to track "which skills are improving" across diagnosis reports**
**Problem:** The doctor proposes skill improvements but doesn't track whether past improvements actually worked.

**Impact:** Skill regression detection is manual; the doctor can't automatically flag "we fixed this in the last month but it recurred."

**Recommendation:**
- Add a **regression tracker** to the IMPROVEMENTS.md format:
  ```
  ## IMP-N · <title>
  status: applied (2026-07-21) [regression detected 2026-07-25]
  first-seen: 2026-07-20 · seen: 2 · dimension: 8
  applied_by: <skill or file edit>
  regression_evidence: <report file + new date>
  ```
  
  When a doctor reports a finding that matches an earlier `applied` entry, the entry gets a `[regression]` marker and the finding references it.

**Effort:** Medium; requires tracking applied edits and cross-referencing.

---

#### **5.4 — Dim 3 (token economy) should distinguish "Opus judgment cost" from "Sonnet maker cost"**
**Problem:** The skill notes "Sonnet CLI implementer reports no usage, so cost_cum covers judgment spawns only." But doesn't guide how to interpret high cost when most spent is on retries.

**Impact:** Doctor can't distinguish "judgment was expensive because of retries" from "judgment tier was too weak."

**Recommendation:**
- Add to rubric **Dim 3** section:
  ```
  ### Cost breakdown guidance
  
  When reporting high cost, distinguish:
  - **Judgment spawn cost** — planner, reviewer, triager, test-grader (recorded in journal)
  - **Retry amplification** — same spawn run N times due to JobResult failures or logic errors
  - **Escalation cost** — re-running a spawn on a heavier model (e.g., implementer escalated to Opus)
  
  A finding like "high cost due to 4 reviewer retries" is different from "high cost due to judgment tier choice" — the remedy differs.
  
  Red flag: reviewer run × 10 times in a single round → likely a prompt/schema mismatch (skill fix), not a one-off issue.
  ```

**Effort:** Low; add breakdown examples.

---

#### **5.5 — Doctor should propose a "minimal reproducible example" format for escape → fixture conversion**
**Problem:** When the doctor flags an escape (bot caught something the reviewer missed), it says "the sidecar input.json is a ready-made care-evals fixture." But doesn't say how to actually create the fixture.

**Impact:** Doctor findings don't automatically feed care-evals; manual conversion is required.

**Recommendation:**
- Add to **SKILL.md** section on escape → fixture:
  ```
  ## Escape → care-evals fixture
  
  When a bot catches a real defect your reviewer's `findings` missed (Dim 8):
  
  1. **Extract the MRE (minimal reproducible example):**
     - Diff context (changed files + 5 lines before/after each change)
     - The bot's finding text (copy from feedback.md)
     - The verdict: what should your reviewer have caught? (e.g., `blocked` / `findings`)
  
  2. **Create a fixture in `care-evals/fixtures/`:**
     ```
     {
       "name": "reviewer-missed-logic-defect-2026-07-25",
       "diff": "<sidecar input.json diff content>",
       "expected_verdict": "blocked",
       "expected_class": "logic",
       "reason": "Loop de-referenced null after conditional that doesn't guarantee non-null"
     }
     ```
  
  3. **Run the eval:** `care-evals run --fixture reviewer-missed-logic-defect-2026-07-25 --model claude-opus-4.8`
  
  4. **Record in backlog:** `IMP-N · reviewer missed null de-ref logic defect (eval task: xxx)`
  ```

**Effort:** Medium; requires care-evals skill integration.

---

## 6. Loop Integration Points & Improvements

### FSM Feedback Loops

#### **6.1 — Step 4a/4b/4c parallel fan-out (not yet implemented)**
**Current:** Steps 4a (review), 4b (test-grade), 4c (ux-validate) run sequentially.

**Improvement Opportunity:** These can run in parallel (no shared context; checker ≠ maker). Once Step 3 completes, spawn all three and wait for all three to finish before proceeding.

**Impact:** ~30–40% reduction in wall-clock time per round (if these typically take 2–3 min each).

**Effort:** Medium; requires orchestrator runner changes to fan-out and wait.

---

#### **6.2 — Step 5 push shouldn't re-run `run_gate.sh` if nothing changed**
**Current:** Step 5 always runs the full gate (build, test, type-check).

**Improvement Opportunity:** If Step 4 gate passed and no changes were made since, skip the gate. If changes occurred post-4c (e.g., fixes from Step 4 loopback), run gate.

**Impact:** Reduced wall-clock time on convergent rounds (small fixes that don't need re-building).

**Effort:** Low; track "gate passed" in state.json and skip on repeat if no changes.

---

### Care-Loop Skill Handoff Improvements

#### **6.3 — care-diff-review should write structured intent summary (not just to intent.md)**
**Current:** care-diff-review writes `intent.md` for test-grader but the format is prose.

**Improvement Opportunity:** Parallel to the prose, write a structured intent JSON (`intent.json`) with per-change tiers:
```json
{
  "summary": "Add a validation banner for low-stock items",
  "changes": [
    {
      "file": "src/components/InventoryList.tsx",
      "intent": "Render a low-stock warning banner above the list if any item is <10 units",
      "class": "UX/information"
    },
    {
      "file": "src/hooks/useInventoryAlerts.ts",
      "intent": "Add hook to compute low-stock items from the inventory data",
      "class": "logic"
    }
  ]
}
```

**Impact:** care-test-grade can automatically check coverage (spec per change class) and catch incomplete specs.

**Effort:** Medium; extend care-diff-review and care-test-grade.

---

#### **6.4 — Verdicts should reference the spec they target (forward & backward links)**
**Current:** care-triager writes verdicts; implementer reads them and applies fixes. No way to trace verdict → spec → fix.

**Improvement Opportunity:** When triager marks an item `address`, add an optional `spec_id` field (if the finding is about test coverage) or `test_file` (if it's a test-related fix).

**Impact:** care-loop PR comment builder can link verdict → relevant test/code for better context.

**Effort:** Low; extend verdicts.md schema.

---

## /Goal in Loop Engineering & Care-Loop Alignment

### What is /Goal?

In Loop Engineering, `/goal` is a pattern for **goal-driven orchestration**:

1. **Goal definition** — explicit statement of what success looks like (e.g., "Land this PR merged to main with CI passing and code reviewed")
2. **Goal decomposition** — breaking into sub-goals (plan, implement, review, test, fix feedback)
3. **Goal-directed search** — orchestrator picks the next action based on which sub-goal to tackle
4. **Goal achievement detection** — periodic check "are we done?" (all sub-goals met → success)
5. **Goal-driven loopback** — if progress stalls, re-evaluate the goal or constraints

### How Care-Loop Aligns with /Goal

✅ **Implicit goal-driven structure:**
- **Goal:** Merge a change to the main branch, approved and passing CI + bot feedback
- **Sub-goals:** Plan approved → Implement → Reviewed cleanly → Tests pass → CI green → Feedback addressed → Merged
- **Goal progress:** state.json step (1, 2, 3, ..., 7) tracks position toward goal
- **Goal convergence:** Round loop (5 → 6a → 6b → 5) keeps pursuing the goal until CI green + feedback empty

✅ **Goal-directed FSM:**
- Every state transition (planning FSM in `fsm.ts`) is motivated by making progress toward the implicit goal
- Failures loopback to earlier steps (4 findings → Step 3; 6a verdicts → Step 6b) to keep pursuing the goal

✅ **Goal achievement detection:**
- `step.enter "7"` + `run.end{outcome:"converged"}` signals goal success
- Checkpoint/defer signals "goal is paused; waiting for external input"

### Why Not Formalize /Goal in Care-Loop?

**Current approach is sufficient because:**

1. **Single implicit goal per run** — each care-loop run has one change request; the goal is clear (merge it). No need for dynamic goal switching.
2. **Goal is encoded in the run context** — the run dir, PR, branch — not in a separate goal document.
3. **FSM is deterministic and complete** — the state machine already captures all legal transitions; adding a goal structure would be redundant.

**When /goal would become valuable:**

1. **Multi-objective runs** — if a single run could tackle multiple tickets or changes simultaneously (not current)
2. **Dynamic goal adjustment** — if a human could pause and change the goal mid-run (currently: run → checkpoint → goal is the same)
3. **Goal hierarchy** — if an "epic-level" goal contained multiple parallel care-loop runs

### Recommendation: Formalize Minimally (if at all)

**Current:** Goal is implicit in run context (change request) + FSM transitions.

**Option A (minimal formalization, not recommended):**
- Add a `goal.json` at run start:
  ```json
  {
    "ticket": "ENG-729",
    "scope": "Add low-stock alerts to inventory screen",
    "success_criteria": [
      "CI passes",
      "No review findings requiring loopback",
      "Merged to main"
    ],
    "deadline": null
  }
  ```
- **Benefit:** doctor can check "did the run achieve its stated goal?"
- **Cost:** extra boilerplate; goal is already in baseline.md + criteria.md

**Option B (recommended):** Keep implicit

- Goal is encoded in the run (branch + task.md + baseline.md + criteria.md + 7-step FSM)
- Doctor implicitly checks goal success by looking at run outcome (state.json step=7, outcome=converged)
- No extra formalism needed

**Verdict:** The FSM + state machine is care-loop's version of /goal. It's goal-driven (every step moves toward merge), but the goal is implicit and baked into the run context. Formalizing it further would add ceremony without clarity.

---

## Summary Table: Quick Improvement Checklist

| Skill | Priority | Improvement | Effort | Impact |
|-------|----------|-------------|--------|--------|
| care-diff-review | Medium | Add intent reconstruction mini-checklist | Low | Better consistency |
| care-diff-review | Medium | Tier legibility findings (Broken/Convention/Polish) | Low | Better triage for loop |
| care-diff-review | Low | Add guidance for large diffs | Low | Clarify edge case |
| care-technical-review | Low | Add "proportionate solutions" reference examples | Medium | Training asset |
| care-technical-review | Medium | Distinguish derived vs. deduplicated vs. cached state | Low | Clearer guidance |
| care-technical-review | Medium | Add real efficiency thresholds | Low | Reduce false positives |
| care-ux-review | Low | Check CSS @apply / nesting for overflow issues | Low | Catch subtle breaks |
| care-ux-review | Low | Document session re-auth for live mode | Very Low | Edge case clarity |
| care-ux-review | Low | Extend screenshot naming for state variants | Low | Better PR linking |
| care-ux-review | Medium | Distinguish workflow design trade-offs from bugs | Low | Reduce false Broken |
| care-ux-review | Low | Add server-side data length stress-test guidance | Low | Production-realistic |
| care-test-grade | Medium | Add faithfulness sub-section (real flow vs. shortcuts) | Low | Catch shortcut specs |
| care-test-grade | Medium | Add interaction pattern checklist | Medium | Catch missing specs |
| care-test-grade | Low | Clarify no-spec path | Very Low | Reduce ambiguity |
| care-test-grade | Medium | Clarify loop loopback path (code vs. test wrong) | Low | Better remediation |
| care-test-grade | Low | Add criticality flag to findings | Low | Prioritize fixes |
| care-loop-doctor | Medium | Add credibility weighting for escape attribution | Low | Reduce noise findings |
| care-loop-doctor | Low | Add finding correlation pass | Low | Surface interactions |
| care-loop-doctor | Medium | Track regression detection | Medium | Closed-loop improvement |
| care-loop-doctor | Low | Distinguish cost breakdown | Low | Better diagnosis |
| care-loop-doctor | Medium | Propose fixture template for escapes → care-evals | Medium | Auto-feed evals |

---

## Recommended Priority Order

**Phase 1 (immediate, high-value):**
1. care-diff-review: Tier legibility findings (care-loop integration)
2. care-technical-review: Real efficiency thresholds (reduce false positives)
3. care-test-grade: Faithfulness sub-section + interaction checklist (critical for specs)
4. care-ux-review: Distinguish design trade-offs from bugs (reduce false Broken)

**Phase 2 (medium-term, skill quality):**
1. care-diff-review: Intent reconstruction checklist
2. care-technical-review: Simplification decision tree
3. care-test-grade: Criticality flag
4. care-loop-doctor: Escape → fixture template

**Phase 3 (long-term, platform-level):**
1. care-test-grade: Structured intent JSON for auto-coverage checking
2. care-loop-doctor: Regression detection + correlation pass
3. Loop integration: Step 4a/4b/4c fan-out, step 5 gate caching

---

**End of Skill Review**
