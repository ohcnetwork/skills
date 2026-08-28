# Scope — care-ux-review **live/visual eval mode** (JS-probe-graded, 3 viewports)

Status: **design / scoped, not built.** This is recommendation #3 of
[`care-loop/UX-REVIEW-RESEARCH.md`](../care-loop/UX-REVIEW-RESEARCH.md) — the "real fix" for the
spatial-geometry defect classes that a diff-only lens is structurally weak at. Recommendations #1
(rubric add: vertical `min-h-0` / nested-scroll idiom) and #2 (one nested-scroll gap-probe, ux-09/10)
are **landed**; this doc scopes #3 so it can be built without re-deriving the design.

## Why (the one-paragraph case)

Text/static gates "validate source artifacts, not browser rendering" (Augment) and LLM spatial
reasoning is "brittle on complex, multi-hop geometric reasoning" (spatial-reasoning survey) — exactly
the axis our tablet-band (ux-06/07) and nested-scroll (ux-09) probes exercise. The literature's answer
is not more static fixtures nor an LLM-vision judge, but **explicit numeric structure**: JS layout
probes (`scrollWidth`/`clientWidth`, page overflow, scroll usability) read off the *real render*. That
keeps the grader in care-evals' **deterministic layer-1** spirit — no vision model, no flake — while
grading each bug *the way it actually manifests*. Static and live are **complementary lenses**
(finding #5), not either/or: static flags the suspicious pattern → live confirms it against pixels.

## The load-bearing distinction: two different browsers

Do not conflate these — they are different surfaces with different reliability needs:

| | Skill's **live mode** (SKILL.md Mode 2) | Eval's **live grader** (this doc) |
|---|---|---|
| Who drives | the model, mid-review | the harness, deterministically |
| Browser | MCP (Playwright MCP / `preview_*` / claude-in-chrome) | **headless `playwright` (Python), no model** |
| Output | tiered `Broken/Convention/Polish` findings | pass/fail from JS-probe booleans |
| Flake surface | model + browser | browser only (probes are exact) |

The eval grader must stay **model-free** to remain the control arm (cheap, CI-able, authoritative).
So it uses **playwright-python driving headless chromium + JS probes**, *not* the MCP browser. The MCP
browser is the skill's concern. This is the single most important design decision here.

## What has to be built

### 1. A new task kind: `live-render`

Reuse the **existing** ux fixtures (ux-06/07/09 and their clean controls ux-08/10) — they already pin a
`base_sha` and add a component via `fixture.patch`. A `live-render` task adds two things a static task
doesn't have:

- **`story.tsx`** — a mount driver. The fixtures are *bare components* with props (ux-09's
  `PatientDetailSheet` needs `open`, `onOpenChange`, `summary`, `observations`), not routes. The story
  imports the fixture component and renders it with **representative + stress props** (e.g. `open
  = true`, a 50-item `observations` array so the scroller has something to fail on). This is the real
  marginal fixture cost — one small file per fixture.
- **`probes.json`** — the deterministic expectation, per viewport (see §4).

Keep `task.md` frontmatter, add `kind: live-render` and a `viewports: [375, 768, 1280]` field.

### 2. A staged, bootable care_fe with a harness route

Staging reuses `_stage_care_review`'s machinery (worktree at `base_sha` + `git apply fixture.patch`)
— but into a **persisted worktree** (not the throwaway temp dir), because we need to run a dev server
against it, plus:

- Drop `story.tsx` into the worktree at a fixed harness path, e.g.
  `src/pages/__eval__/<task-id>.tsx`.
- Register a throwaway route `#/__eval__/<task-id>` → the story. Either a tiny router injection or a
  standalone Vite entry (`eval-harness.html` + `main.eval.tsx`) that mounts the story with providers
  (QueryClient, i18n, theme) — a standalone entry is cleaner and avoids touching app routing. Decide at
  build time; the standalone entry is the recommendation.
- Boot: `npm run dev` (Vite) in the worktree, capture the port, **wait-for-ready** (poll the URL until
  200). One dev server can serve every task's harness route — boot once per sweep, not per task.

> **Prereq the doc must call out:** this needs `npm install` to have run in the care_fe checkout and a
> free port. Unlike the static grader (fully offline), the live grader has a real toolchain dependency
> — gate it behind an explicit `--live` flag / `--care-fe` presence and **skip with a clear message**
> when unavailable, exactly as the skill's live mode skips when no browser MCP is present.

### 3. The render + probe loop (playwright-python)

Per task × per viewport in `[375, 768, 1280]`:

1. `page.set_viewport_size({width, height})` (heights 812 / 1024 / 800 to match the skill's Mode 2).
2. `page.goto(harness_url)`; wait for the story's root test-id (`[data-eval-root]`) to attach.
3. Run the **JS probes** (`page.evaluate`) — §4.
4. `page.screenshot()` → `results/<label>/<task>-<width>.png` (for the human + optional layer-2 judge;
   filename suffix mirrors the skill's `-<width>` convention so the same tooling can place them).
5. Collect `console` errors (fail-loud on React errors).

### 4. The probe contract (deterministic layer-1 grader)

The probes are the whole point — three booleans that catch the three geometry classes, all reading
explicit numeric structure off the real DOM (the "Cartesian format outperforms" finding):

```js
// (a) page-level horizontal overflow — catches fixed-width / sub-320 / tablet-band escape
const pageOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;

// (b) element clipped — text cut off with no honest overflow affordance
//     for a target [data-eval-probe="clip"]: content wider than box, no scroll/clamp
const clipped = el.scrollWidth > el.clientWidth + 1
             && getComputedStyle(el).overflowX === 'visible';

// (c) scroll usability — THE nested-scroll (min-h-0) probe.
//     A declared scroller that actually engages: it is overflow-y:auto/scroll AND its content
//     exceeds its box (so it CAN scroll) AND the box is bounded (didn't grow to content).
const style = getComputedStyle(el);
const declaresScroll = ['auto', 'scroll'].includes(style.overflowY);
const contentExceeds = el.scrollHeight > el.clientHeight + 1;   // there is something to scroll
const bounded        = el.clientHeight < window.innerHeight;    // didn't grow past the viewport
const scrollerWorks  = declaresScroll && contentExceeds && bounded;
// ux-09 failure signature: declaresScroll === true but contentExceeds === false
//   (grew to min-height:auto so scrollHeight == clientHeight) OR bounded === false
//   (the sheet body escaped the viewport). Either → scrollerWorks === false.
```

`probes.json` per task names the target selectors + the expected booleans **per viewport**:

```jsonc
{
  "schema": "care-evals/probes-live@1",
  "viewports": {
    "375":  { "page_overflow": false, "scrollers": [{ "sel": "[data-eval-probe=body]", "works": true },
                                                      { "sel": "[data-eval-probe=log]",  "works": true }] },
    "768":  { "page_overflow": false, "scrollers": [ /* … */ ] },
    "1280": { "page_overflow": false, "scrollers": [ /* … */ ] }
  }
}
```

Grade = **exact-match of measured booleans to expected**, mirroring the enum-exact-match style
`grader.py` already uses for test-grade/triage/ci-fix. The clean controls (ux-08/10) expect all-green;
the defect fixtures (ux-06/07/09) expect the specific viewport where the break appears to go red on the
specific probe (ux-06/07: `page_overflow: true` **only at 768**; ux-09: `scrollers[*].works: false`).
The `Grading` shape is unchanged: `layer: "deterministic"`, `detail` carries the per-viewport measured
booleans + a diff against expected. No new grading philosophy — a new probe backend.

### 5. Runner wiring

Add a `kind == "live-render"` branch to `run_task` in `run_eval.py`, alongside the existing per-skill
branches:

```
stage worktree(base_sha)+patch (persisted)  ->  drop story.tsx + harness entry
  ->  boot dev server (once per sweep)  ->  playwright render loop × viewports
  ->  probes  ->  grade against probes.json  ->  Grading (+ screenshots as artifacts)
```

It does **not** call an `adapter` (there is no model in this path) — so the JobResult's
`model_used`/`cost_usd` are empty/0 and it slots into `benchmark.md`/`ladder.md` as a $0, model-free
row. The abort-criterion tally (`>=9/10 valid JobResults`) still applies.

### 6. Reliability checklist (Kinney/Augment — "fix these four and it's boring")

Because we grade on **JS booleans, not pixel diffs**, most visual-regression flake sources don't bite
us — call this out as the payoff of the JS-probe choice. Still apply:

- `animations: 'disabled'` (Playwright) / `* { transition: none !important }` injected — avoid probing
  mid-transition.
- Wait for fonts (`document.fonts.ready`) before measuring — layout shifts on late font load.
- Ignore scrollbar gutter in the page-overflow probe (`+1` slack already absorbs sub-pixel; or measure
  `clientWidth` not `innerWidth` if a gutter is present).
- Pin the chromium build (playwright's bundled one) for reproducibility.

No font-pinning-in-Docker needed for booleans; note it *would* be needed if we ever add pixel diffs.

### 7. Optional layer-2 — image judge for the aesthetic residue only

The JS probes catch *geometry*. They do **not** catch "looks off but doesn't overflow" (mis-aligned,
ugly wrap, wrong emphasis). Per finding #3, do **not** put a vision model in the deterministic grader;
instead offer an **optional** `--judge-adapter` image pass (reuse the existing layer-2 seam in
`grader.py`) that reads the saved screenshots and scores only the aesthetic residue. Advisory, never
gating — same contract as today's prose judge.

## Sequencing (when built)

1. **Vertical slice first:** ux-09 only — story.tsx + probes.json + the playwright loop + the
   scroll-usability probe. Prove the `scrollerWorks` boolean goes **red on ux-09, green on ux-10**
   end-to-end. That single result validates the whole machine (the hard part is the scroll probe, not
   the plumbing).
2. Add ux-06/07/08 (page-overflow probe, tablet band) — reuses the same loop.
3. Wire `benchmark.md`/`ladder.md` rows; flip the "live mode = out" non-goal in
   [`SKILL.md`](./SKILL.md) to "live grader = in (JS-probe, model-free); MCP live *review* still the
   skill's job."

## Open questions (decide at build, not now)

- **Harness route vs standalone Vite entry** — recommend standalone entry (`main.eval.tsx`) to avoid
  touching app routing and to control the provider stack; confirm care_fe's providers are cheap to mock.
- **Persisted worktree lifecycle** — one per sweep, torn down at the end; or a single reused
  `~/.cache/care-evals/live-wt`. Recommend per-sweep temp with `git worktree remove` in a `finally`.
- **Selector stability** — depend on `data-eval-probe` attributes added *in `story.tsx`* (wrapping the
  fixture), never on the fixture's own class names, so probes don't couple to Tailwind churn.

## Non-goals (still)

Pixel-diff / screenshot-baseline regression (we grade booleans, not images). Continuous running.
Any autonomy. The MCP-driven live *review* (that's the skill, SKILL.md Mode 2 — already specified).
