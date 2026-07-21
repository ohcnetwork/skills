// skills-opencode.ts — the DEFAULT role skills, backed by opencode + GitHub Copilot. Each is a thin
// wrapper over the opencode transport (promptStructured / `opencode run`) that satisfies a role port
// from ports.ts. Swapping "a better reviewer" = pass a different Reviewer to orchestrate.ts; these are
// just the batteries-included defaults.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runJudgmentSpawn,
  promptStructured,
  promptAgenticThenStructured,
  forkedFanOut,
  NO_EXPLORE_TOOLS,
  type SpawnCost,
} from "./opencode-runner.js";
import { runHelper } from "./shell.js";
import { parseFeedbackClusters } from "./feedback.js";
import {
  reviewerMethodology,
  plannerMethodology,
  triagerMethodology,
  testGraderMethodology,
  uxValidatorMethodology,
  ciFixerMethodology,
  playwrightMechanics,
} from "./skill-source.js";
import type {
  Implementer,
  Planner,
  Reviewer,
  Triager,
  TestGrader,
  UxValidator,
  CiFixer,
} from "./ports.js";
import type { TriageItem, CiFixPayload, CiFailure } from "./skill-result.js";

export interface SkillModels {
  provider?: string; // default "github-copilot"
  reviewer?: string; // judgment tier
  implementer?: string; // cheap maker tier
  triager?: string; // judgment tier
  planner?: string; // judgment tier (Opus — the PLAN phase, enforced at the gate)
  plannerRecon?: string; // fast (maker) tier — the INTERVIEW/recon phase; not gated (recon is navigation, not judgment)
  testGrader?: string; // 4b judgment tier
  uxValidator?: string; // 4c judgment tier
  ciFixer?: string; // maker tier — the CI-fix skill (Step 6b residual track)
}
const defaults = {
  provider: "github-copilot",
  reviewer: "claude-opus-4.8",
  implementer: "claude-sonnet-4.6",
  triager: "claude-opus-4.8",
  planner: "claude-opus-4.8",
  plannerRecon: "claude-sonnet-4.6",
  testGrader: "claude-opus-4.8",
  uxValidator: "claude-opus-4.8",
};

// Parallel-exploration directive for the IMPLEMENTER (which forages via `opencode run`, outside the
// judgment transport). SSE-traced root cause of the ~6-min planner: strictly SERIAL exploration — one
// grep per model round-trip, ~3s apart, ~120 round-trips. opencode DOES execute batched tool calls
// concurrently; the model just needs to be told to emit them. The PLANNER now sources the same guidance
// from its methodology (the `care-planner` skill, Phase 1 — Recon) so it's part of "how you recon", not
// a competing addendum; this const carries it to the implementer's prompt. The triager sources the same
// guidance from ITS methodology (the `care-triager` skill). Only the reviewer is exempt — it judges
// the inline diff, nothing to batch. HISTORY (SSE-measured 2026-07-15, care_fe eng-642, opus): the
// triager did NOT batch in one agent — ~1 tool/round-trip, maxConcurrent=1, ~90 tools over ~80 turns;
// prompt levers were INERT (per-item verify→verdict is intrinsically sequential in ONE context, unlike
// the planner's recon). So the lever was ORCHESTRATOR-LEVEL FAN-OUT (parallelize ACROSS files, not
// tool-calls within one agent) — now WIRED in opencodeTriager via `forkedFanOut` (map verify-per-file
// on the maker tier → judgment-tier reduce) for ≥2 clusters, single-spawn below threshold. See
// care-loop/PLAN-triager-fanout.md + PLAN-forked-fanout.md. Still needs the §8 triage eval to prove
// parity before it's trusted.
const BATCH_DIRECTIVE =
  "EXPLORE IN PARALLEL: when you need several independent searches or file reads, issue them as MULTIPLE " +
  "tool calls in a SINGLE step — never one at a time. Batch grep/glob/read aggressively (fire all the " +
  "symbol greps at once, then read all candidate files at once). Do NOT spawn subagents (the `task` tool); " +
  "explore directly. Minimize the number of sequential steps — that round-trip latency is the dominant cost.";

function git(dir: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Error thrown when a judgment spawn ran on the wrong engine. Halts the run loudly rather than
 *  letting it proceed on an un-pinned tier — the reviewer/triager/test-grader/ux-validator
 *  counterpart to the planner's `plan_wrong_tier` gate ([plan.ts:90]). BS-1 in HARNESS-COVERAGE.md. */
export class WrongTierError extends Error {
  constructor(
    readonly role: string,
    readonly pinned: string,
    readonly reported: string | undefined,
  ) {
    super(
      `[care-loop] ${role} ran on '${reported ?? "unknown"}' but was pinned to '${pinned}' — model tier not satisfied.`,
    );
    this.name = "WrongTierError";
  }
}

/** Enforce the judgment model pin. `satisfied === false` is intentional (mirrors the planner gate):
 *  `undefined` means opencode couldn't verify the engine (a local model, or a test fake) — not a
 *  failure, so the pin only fires on an explicit mismatch. Throws to stop the run; the journal's
 *  `spawn.result.model` already records which engine actually ran, so the doctor sees the tier. */
export function assertRightTier(
  role: string,
  pinned: string,
  reported: string | undefined,
  satisfied: boolean | undefined,
): void {
  if (satisfied === false) {
    throw new WrongTierError(role, pinned, reported);
  }
}

/** Build the reviewer system prompt, incorporating the canonical lens methodologies from the
 *  skill source files so the reviewer never drifts from the actual review criteria. The diff
 *  is supplied inline — git/subagent/confirm instructions are excluded from the loaded regions. */
function buildReviewerSystem(diff: string): string {
  // The `+++ b/….tsx` diff header is the reliable signal a .tsx file changed (a `.tsx` substring in
  // an import line of a non-tsx diff would false-trigger). Loads the ux-review static lens for layout.
  const hasTsx = /\+\+\+ b\/.*\.tsx/.test(diff);
  const methodology = reviewerMethodology({ tsx: hasTsx });
  // CRITICAL: the injected lens methodology contains EXPLORATION verbs written for an interactive host
  // with tools ("check the other usages… always check those", "read the actual control flow"). The
  // headless judgment spawn also has read/grep tools, so without this bound it goes agentic exploring
  // the repo and blows past the judgment timeout (observed live: ENG-613 reviewer timed out at 240s).
  // Override those verbs here: apply the criteria to the INLINE diff only, reasoning about other
  // usages from the diff rather than reading them. This mirrors stripping the git/confirm mechanics.
  const base =
    "You are the care-loop reviewer (judgment tier). The diff to review is supplied inline below and is " +
    "COMPLETE. Review using ONLY the inline diff: do NOT read other files, open or survey the repository, " +
    "run git, grep for usages, spawn subagents, or confirm with a user — you are on a strict time budget. " +
    "Where the methodology says to check other usages or read files, reason about them FROM THE INLINE " +
    'DIFF instead. Apply the review criteria below. Set verdict="pass" if clean, "findings" for ' +
    'non-blocking notes, "blocked" ONLY for a real defect that must be fixed before merge. Fill ' +
    "model_used. Respond ONLY as the required JobResult.";
  if (!methodology) return base;
  return `${base}\n\n=== REVIEW METHODOLOGY (apply its CRITERIA to the inline diff; ignore its file-reading/exploration steps) ===\n${methodology}\n=== END METHODOLOGY ===`;
}

/** Default reviewer: opencode structured output (JobResult), model-pinned to the judgment tier. */
export function opencodeReviewer(models: SkillModels = {}): Reviewer {
  const provider = models.provider ?? defaults.provider;
  const model = models.reviewer ?? defaults.reviewer;
  // The skill-sourced reviewer carries a large methodology; give it a little more headroom than the
  // 240s default (bounded exploration keeps it fast, but the richer criteria think longer). Override
  // via OC_REVIEWER_TIMEOUT_MS.
  const timeoutMs = Number(process.env.OC_REVIEWER_TIMEOUT_MS) || 360_000;
  return async ({ diff, round }) => {
    const startedAt = new Date().toISOString();
    const { jobResult, modelReported, modelPinSatisfied, cost } =
      await runJudgmentSpawn({
        role: "care-reviewer",
        providerID: provider,
        modelID: model,
        system: buildReviewerSystem(diff),
        task: `Review this diff.\n\n=== DIFF ===\n${diff}\n=== END DIFF ===`,
        runId: "review",
        round,
        timeoutMs,
        // The reviewer reasons from the INLINE diff only (buildReviewerSystem forbids exploration).
        // Enforce that as a capability, not just a prompt: with no read/grep/glob tools, the
        // structured-output turn can't collapse into the non-converging serial-tool spiral that
        // burned the full wall-clock (ENG-613 @240s, ENG-747 @360s) — it emits directly.
        tools: NO_EXPLORE_TOOLS,
      });
    assertRightTier("care-reviewer", model, modelReported, modelPinSatisfied);
    return {
      schema: "care-loop/skill-result@1",
      skill: "care-reviewer",
      round,
      terminalState: jobResult.terminal_state,
      verdict: jobResult.verdict,
      reasonCode: jobResult.reason_code,
      payload: {
        findings: (jobResult.findings ?? []).map((f) => ({
          class: f.class,
          file: f.file,
          lineHint: f.line_hint,
          note: f.note,
        })),
      },
      cost,
      modelUsed: jobResult.model_used ?? modelReported,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  };
}

/** Default implementer: `opencode run` scoped to the worktree (tools on), model-pinned to the cheap tier.
 *  CRITICAL: the maker is EDIT-ONLY. Left unrestricted, the opencode `build` agent freelances the whole
 *  loop — it will commit, push, and even open its own PR (observed live: ENG-613 → PR #16558), bypassing
 *  the orchestrator's controlled gate/push/PR. So git-write + gh are hard-denied via OPENCODE_PERMISSION
 *  (belt) and forbidden in the prompt (suspenders). The orchestrator owns commit/push/PR.
 *  Success = the run exited 0 AND the worktree changed (HEAD moved or dirty tree). */
const IMPLEMENTER_PERMISSION = JSON.stringify({
  // Read files anywhere without prompting — a fresh worktree symlinks node_modules/generated sources
  // to the main checkout, so reads resolve OUTSIDE the worktree; without this, opencode's headless
  // external_directory=ask would stall the maker up to its timeout (the same gate that hung the reviewer).
  external_directory: "allow",
  bash: {
    "*": "allow", // wildcard first; specific denies below win (last match)
    "gh*": "deny",
    "git push*": "deny",
    "git commit*": "deny",
    "git worktree*": "deny",
    "git branch*": "deny",
    "git checkout*": "deny",
    "git switch*": "deny",
    "git reset*": "deny",
    "git rebase*": "deny",
    "git merge*": "deny",
    "git tag*": "deny",
  },
});
const IMPLEMENTER_PREAMBLE =
  "You are the implementer. ONLY edit source files in this worktree to accomplish the task. Do NOT " +
  "commit, push, create branches, open or edit pull requests, or run `gh` — the orchestrator owns all " +
  "version control and the PR. Just make the code change and stop.\n\n" +
  // Same parallel-exploration lever as the planner: the maker also forages (locate the code, read
  // context) before editing; batching those reads/searches cuts the serial round-trip chain. Prompt-level
  // here (the implementer runs via `opencode run`, not the judgment transport that hard-disables `task`).
  BATCH_DIRECTIVE +
  "\n\nTask:\n";

/** Read the approved plan artifacts from the run dir and format them for the implementer prompt, so the
 *  maker builds to the PLAN (acceptance criteria + interview decisions/non-goals), not just the raw task.
 *  Returns "" when there is no plan (e.g. a --skip-plan run) — the implementer then works from the task
 *  alone, exactly as before. This closes the plan→implement handoff gap (the plan's criteria — e.g.
 *  "also update the two Playwright specs" — otherwise never reached the maker). */
function planContext(runDir: string): string {
  const read = (name: string): string => {
    try {
      return readFileSync(join(runDir, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  const criteria = read("criteria.md");
  const decisions = read("decisions.md");
  const blocks: string[] = [];
  if (criteria)
    blocks.push(
      `## Acceptance criteria — your change must satisfy ALL of these\n${criteria}`,
    );
  if (decisions)
    blocks.push(
      `## Decisions from the plan interview — follow these exactly; respect the non-goals\n${decisions}`,
    );
  return blocks.length
    ? `\n\n=== APPROVED PLAN (implement to this) ===\n${blocks.join("\n\n")}\n=== END PLAN ===`
    : "";
}

export function opencodeImplementer(models: SkillModels = {}): Implementer {
  const provider = models.provider ?? defaults.provider;
  const model = models.implementer ?? defaults.implementer;
  return async ({ task, worktree, runDir, round, findings }) => {
    const startedAt = new Date().toISOString();
    const before = git(worktree, "rev-parse", "HEAD").out.trim();
    const body = findings
      ? `${task}\n\nAddress these review/gate findings; change only what's needed:\n${findings}`
      : task;
    const prompt = IMPLEMENTER_PREAMBLE + body + planContext(runDir);
    const r = runHelper({
      cmd: "opencode",
      args: [
        "run",
        "--dir",
        worktree,
        "--model",
        `${provider}/${model}`,
        prompt,
      ],
      env: { ...process.env, OPENCODE_PERMISSION: IMPLEMENTER_PERMISSION },
      logPath: join(runDir, "agents", `implementer-r${round}.log`),
      timeoutMs: 300_000,
    });
    const after = git(worktree, "rev-parse", "HEAD").out.trim();
    const porcelain = git(worktree, "status", "--porcelain").out.trim();
    const dirty = porcelain.length > 0;
    const changed = dirty || (after !== "" && after !== before);
    const done = r.exit === 0 && changed;
    // Distinguish a clean no-op (exit 0 + nothing changed = items already fixed) from a genuine
    // failure (nonzero exit / timeout). default-wiring maps reasonCode "exit_0_no_change" → "noop"
    // so the loop terminates gracefully instead of burning retries (MED-C).
    const noop = r.exit === 0 && !changed;
    const reason = done
      ? dirty
        ? "opencode_uncommitted"
        : "opencode_committed"
      : noop
        ? "exit_0_no_change"
        : `exit_${r.exit}_no_change`;
    const filesChanged = porcelain
      ? porcelain
          .split("\n")
          .map((l) => l.slice(3).trim())
          .filter(Boolean)
      : [];
    return {
      schema: "care-loop/skill-result@1",
      skill: "implementer",
      round,
      terminalState: done ? "done" : "failed",
      verdict: done ? "implemented" : "failed",
      reasonCode: reason,
      payload: { filesChanged, staged: false, timedOut: r.exit === 124 },
      modelUsed: model,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  };
}

// Triager returns typed verdict tallies — its own structured shape (not the reviewer JobResult).
const TRIAGE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      description: "one entry per distinct feedback item",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["class", "verdict", "missed_by", "reason"],
        properties: {
          source: {
            type: "string",
            description: "bot / reviewer name or comment ref",
          },
          class: {
            type: "string",
            description:
              "correctness | legibility | overengineering | ux | test | other",
          },
          verdict: {
            enum: ["address", "decline"],
            description:
              "address = auto-fix now; decline = won't (give reason) — false positive, outdated, not worth it, OR out of scope. The loop handles everything; nothing is deferred to a human.",
          },
          missed_by: {
            type: "string",
            description:
              "which of OUR steps should have caught it first: care-reviewer | care-technical-review | care-ux-review | care-test-grade | novel (un-catchable pre-merge) | none (not an escape)",
          },
          severity: {
            type: "string",
            enum: ["high", "medium", "low", "none"],
            description:
              "bot-declared severity, normalized. CodeRabbit tags appear inline in the digest: 🔴Critical/🟠Major→high, 🟡Minor→medium, 🧹Nitpick→low. Copilot severity is a GitHub-UI-only field (never in the comment body) → always none. Greptile carries no structured severity → none. Omit or set none when no tag is present.",
          },
          reason: { type: "string" },
          threads: {
            type: "array",
            items: { type: "number" },
            description:
              "the GitHub thread id(s) this verdict covers — the numbers from the feedback digest's `(thread NNN)` refs. When you dedup several bot comments into one item, union ALL their thread ids. Empty for items derived only from summary comments.",
          },
        },
      },
    },
  },
} as const;

// Per-cluster verify schema for the fan-out MAP (PLAN-triager-fanout §2/§3): the TRIAGE_SCHEMA item
// shape plus `needs_cross_file` — a fork sets it when a verdict genuinely depends on a file it wasn't
// given, and the reduce re-resolves those against the full diff (§3.3) before the final verdict list.
const CLUSTER_VERIFY_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      description: "one entry per distinct finding on THIS file",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "class",
          "verdict",
          "missed_by",
          "reason",
          "needs_cross_file",
        ],
        properties: {
          source: {
            type: "string",
            description: "bot / reviewer name or comment ref",
          },
          class: {
            type: "string",
            description:
              "correctness | legibility | overengineering | ux | test | other",
          },
          verdict: { enum: ["address", "decline"] },
          missed_by: {
            type: "string",
            description:
              "care-reviewer | care-technical-review | care-ux-review | care-test-grade | novel | none",
          },
          severity: {
            type: "string",
            enum: ["high", "medium", "low", "none"],
            description:
              "bot-declared severity: CodeRabbit 🔴Critical/🟠Major→high, 🟡Minor→medium, 🧹Nitpick→low; Copilot/Greptile→none",
          },
          reason: { type: "string" },
          threads: {
            type: "array",
            items: { type: "number" },
            description:
              "the GitHub thread id(s) from this file's `(thread NNN)` refs that this finding covers; union all when one finding spans several bot comments",
          },
          needs_cross_file: {
            type: "boolean",
            description:
              "true if the verdict depends on a file NOT provided to you; the reduce resolves it against the full diff",
          },
        },
      },
    },
  },
} as const;

/** The change under review = branch vs base (committed) + uncommitted edits (mirrors orchestrate's
 *  defaultDiffOf). The big shared, cache-warmed context for the fan-out base. Guarded so a bad base
 *  ref yields "" (no diff) rather than git's stderr leaking into the prompt. */
function computeDiff(worktree: string, base: string): string {
  const c = git(worktree, "diff", `${base}...HEAD`);
  const u = git(worktree, "diff", "HEAD");
  return (c.code === 0 ? c.out : "") + (u.code === 0 ? u.out : "");
}

/** Default triager (Step 6a). Two paths behind a threshold (PLAN-triager-fanout §4):
 *  - **fan-out** when there's a `worktree` to verify against AND ≥2 file-clusters — `forkedFanOut`
 *    warms the methodology+diff once, forks a per-file verify (maker tier), then a judgment-tier reduce
 *    dedups / Scope-Governors / resolves `needs_cross_file` into the final verdict list;
 *  - **single-spawn** (the proven original) for sub-threshold feedback or when no worktree is baked in.
 *  `worktree` is baked in here — like `apply`/`gate`/`push` close over `cfg.worktree` in default-wiring
 *  — so the feedback's repo-relative paths resolve (reads permitted by JUDGMENT_PERMISSION). `base` is
 *  the branch's base ref (default-wiring passes `cfg.base`), used only to compute the fan-out diff. */
export function opencodeTriager(
  models: SkillModels = {},
  worktree?: string,
  base?: string,
): Triager {
  const provider = models.provider ?? defaults.provider;
  const model = models.triager ?? defaults.triager; // judgment tier — reduce + single-spawn
  const mapModel = models.plannerRecon ?? defaults.plannerRecon; // maker tier — per-cluster verify (recon-like)
  // The injected triage methodology + multi-item feedback push past the 240s default.
  // Same fix as the reviewer: give extra headroom, override via env for CI/slow models.
  const timeoutMs = Number(process.env.OC_TRIAGER_TIMEOUT_MS) || 360_000;
  return async ({ round, feedbackPath, runDir }) => {
    const startedAt = new Date().toISOString();
    const feedback = readFileSync(feedbackPath, "utf8");
    const methodology = triagerMethodology();
    const { clusters, summary } = parseFeedbackClusters(feedback);
    // Inject the approved plan (criteria.md + decisions.md) so the triager can citation-decline
    // bot feedback that contradicts the plan. Mirrors implementer's planContext; the triager's
    // methodology already says to decline findings that contradict decisions.md, but it was
    // never given the file — causing plan-contradicting bots to keep getting `address`-verdicted.
    const readRunFile = (name: string): string => {
      if (!runDir) return "";
      try {
        return readFileSync(join(runDir, name), "utf8").trim();
      } catch {
        return "";
      }
    };
    const planBlock = (() => {
      const criteria = readRunFile("criteria.md");
      const decisions = readRunFile("decisions.md");
      const parts: string[] = [];
      if (criteria)
        parts.push(`## Acceptance criteria (authoritative spec)\n${criteria}`);
      if (decisions)
        parts.push(
          `## Decisions + non-goals from the plan interview\n${decisions}`,
        );
      return parts.length
        ? `\n\n=== APPROVED PLAN (authoritative — citation-decline any finding that contradicts this) ===\n${parts.join("\n\n")}\n=== END APPROVED PLAN ===`
        : "";
    })();
    // Use the fan-out path whenever we have a worktree AND at least one file-cluster. Even a single
    // cluster benefits: the fan-out PRE-READS each cluster's file and inlines it, so the model never
    // goes agentic reading the repo (the single-spawn+worktree path does, which hangs on a flaky
    // Copilot with no bound). Single-spawn is now only for the no-worktree degraded case.
    const useFanOut = !!worktree && clusters.length >= 1;

    let rawItems: any[] = [];
    let cost: SpawnCost | undefined;
    let modelReported: string | undefined;
    let modelPinSatisfied: boolean | undefined;

    // Single-spawn path (the proven original): used directly for the no-worktree / sub-threshold case,
    // and as the fan-out FALLBACK — if forkedFanOut throws (e.g. its load-bearing base warm-up fails) we
    // still produce a triage instead of failing the step. Bounded by timeoutMs via the async transport,
    // so the old "single-spawn+worktree hangs on a flaky Copilot with no bound" risk no longer applies.
    const runSingleSpawn = async () => {
      const repoLine = worktree
        ? `Repo under review (read-only, absolute paths): ${worktree}\n` +
          "The feedback's `path:line` references are RELATIVE to this repo root — resolve and read them " +
          "there (and their adjacent files) to verify each finding before you verdict it.\n\n"
        : "";
      const system =
        "You are the care-loop triager (judgment tier). Given the pre-digested bot feedback, apply the " +
        "triage methodology below and return ONE item per distinct piece of feedback. For each: decide a " +
        "verdict (address = auto-fix, or decline = won't, incl. out-of-scope, with a reason — the loop " +
        "handles everything, nothing is deferred to a human), classify it, and attribute missed_by = which of OUR pipeline " +
        "steps should have caught it first (care-reviewer | care-technical-review | care-ux-review | " +
        "care-test-grade), or 'novel' if it was genuinely un-catchable before merge, or 'none' if it isn't " +
        "an escape (praise, or our own already-known finding). Copy each item's `(thread NNN)` id(s) from the " +
        "feedback into its threads[] (union them when you dedup several comments).\n\n" +
        "IMPORTANT — `[addressed round N]` tags in the feedback mean the implementer already applied a fix " +
        "for this thread in round N; the bot thread is still open only because GitHub resolution happens at " +
        "the end of the loop. Read the file to verify the fix is present (you have repo access via the worktree path); " +
        "if it is, verdict it `decline` with reason `fix already applied in round N`. Only verdict it `address` " +
        "if you can show the fix is absent or was regressed (cite the specific line)." +
        (planBlock ? planBlock : "") +
        (methodology
          ? `\n\n=== TRIAGE METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`
          : "") +
        "\n\nVerify each finding against the cited code first, then END your turn with your triage as a " +
        "plain-prose list (one line per item: verdict, class, missed_by, thread id(s), reason) — do NOT emit " +
        "JSON yet; a follow-up turn will ask you to format it.";
      // TWO-TURN split: this fallback path reads worktree files to verify — agentic exploration, which
      // under a `format` constraint collapses into the serial spin (see promptAgenticThenStructured).
      // Turn A verifies with NO format, Turn B emits the items as JSON in the same warm session.
      const emitSystem =
        "You are the care-loop triager. In your previous turn you produced the triage items. Emit EXACTLY " +
        "those items as the required JSON — one entry per item, preserving verdict/class/missed_by/reason " +
        "and the `(thread NNN)` id(s) in threads[]. Do NOT read or verify anything further, and do NOT " +
        "change any verdict. Return ONLY the items array as the required JSON.";
      const out = await promptAgenticThenStructured(
        {
          role: "care-triager",
          providerID: provider,
          modelID: model,
          reconSystem: system,
          task: repoLine + feedback,
          emitSystem,
          emitInstruction: "Emit your triage items as the required JSON now.",
          round,
          timeoutMs,
        },
        TRIAGE_SCHEMA,
      );
      rawItems = Array.isArray(out.data.items) ? out.data.items : [];
      cost = out.cost;
      modelReported = out.modelReported;
      modelPinSatisfied = out.modelPinSatisfied;
    };

    if (useFanOut) {
      // Fall back to single-spawn if the fan-out throws. Map forks + reduce already degrade internally;
      // this try/catch covers a base-warm-up / server-startup / deadline failure so the step still completes.
      try {
        // ── fan-out path (map per file-cluster → reduce) ──────────────────────────────────────────
        const diff = base ? computeDiff(worktree!, base) : "";
        // Pre-read each cluster's file so forks can verdict in a single shot (no tool calls).
        // Eliminates the agentic multi-turn exploration that made the slowest fork take 193s.
        const fileContents = new Map<string, string>();
        for (const c of clusters) {
          try {
            fileContents.set(
              c.file,
              readFileSync(join(worktree!, c.file), "utf8"),
            );
          } catch {
            // File may not exist (deleted in the diff) — the fork handles this via the diff context.
          }
        }
        const res = await forkedFanOut({
          provider,
          base: {
            system:
              "You are the care-loop triager verifying ONE file's review findings. The shared context is " +
              "the FULL change diff (for cross-file awareness). Each fork prompt includes the CURRENT file " +
              "content so you can verify findings WITHOUT reading the repo. Set needs_cross_file=true only " +
              "when a verdict genuinely depends on a file NOT provided to you. Return items[] for THIS file only. " +
              "Copy the `(thread NNN)` id from each finding into that item's threads[] so it can be replied to.\n\n" +
              "IMPORTANT — `[addressed round N]` tags in the findings mean the implementer already applied a fix " +
              "for this thread in round N; the bot thread is still open only because GitHub resolution happens at " +
              "the end of the loop. Verify the fix is present in the CURRENT FILE block: if the fix is there, " +
              "verdict it `decline` with reason `fix already applied in round N`. Only verdict it `address` if " +
              "you can show the fix is absent or was regressed (cite the specific line)." +
              (planBlock ? planBlock : "") +
              (methodology
                ? `\n\n=== TRIAGE METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`
                : ""),
            context: diff,
          },
          map: {
            model: mapModel,
            schema: CLUSTER_VERIFY_SCHEMA,
            forkTimeoutMs: 45_000,
            tasks: clusters.map((c) => {
              const content = fileContents.get(c.file);
              const fileBlock = content
                ? `\n\n=== CURRENT FILE: ${c.file} ===\n${content}\n=== END FILE ===`
                : `\n\n(File ${c.file} not found on disk — use the diff context to verify.)`;
              return {
                id: c.file,
                prompt: `Findings on \`${c.file}\`:\n\n${c.text}\n\nVerify each against the code below and return items[].${fileBlock}`,
              };
            }),
          },
          reduce: {
            model,
            schema: TRIAGE_SCHEMA,
            // The reduce runs on the judgment tier and COLD vs the warm base prefix (reduce.model !=
            // map.model), so a large diff + many file-clusters can push the synthesis past the fan-out
            // default 90s cap — degrading to an un-deduped flatten. Give it dedicated headroom (still
            // bounded by the run-scoped `timeoutMs`, which closes the server). Override via env.
            timeoutMs:
              Number(process.env.OC_TRIAGER_REDUCE_TIMEOUT_MS) || 180_000,
            prompt: (r) =>
              "Consolidate these per-file verified findings into the FINAL triage verdict list. Dedup " +
              "overlapping bot findings; apply the Scope Governor and promote in-scope bug-class siblings " +
              "(the full diff is in your shared context); for any item flagged needs_cross_file, resolve it " +
              "now using the full diff; fold in the bot summary comments below. Return ONE item per distinct " +
              "finding with its missed_by attribution. UNION the threads[] ids of every bot comment you " +
              "merge into a single item — none may be dropped (each thread gets a reply). " +
              "CITATION DECLINES: any finding that contradicts the APPROVED PLAN (injected in the base system context) " +
              "must be `decline`d with reason citing the specific plan criterion or decision — even if the bot " +
              "marks it Critical.\n\n=== PER-FILE VERIFIED FINDINGS ===\n" +
              r
                .map(
                  (x) =>
                    `## ${x.id}${x.error ? ` (VERIFY FAILED: ${x.error})` : ""}\n${JSON.stringify(x.data)}`,
                )
                .join("\n\n") +
              (summary ? `\n\n=== BOT SUMMARY COMMENTS ===\n${summary}` : ""),
          },
          concurrency: 5,
          timeoutMs,
        });
        const reduced = res.reduce?.data;
        if (reduced && Array.isArray(reduced.items)) {
          rawItems = reduced.items;
          cost = res.reduce?.cost;
        } else {
          // reduce failed → degrade: flatten the per-file verified items (no global dedup/Scope Governor).
          rawItems = res.map.flatMap((m) =>
            m.data && Array.isArray(m.data.items) ? m.data.items : [],
          );
        }
      } catch (e) {
        console.log(
          `[triager] fan-out failed, falling back to single-spawn: ${(e as Error).message?.slice(0, 100)}`,
        );
        await runSingleSpawn();
      }
    } else {
      await runSingleSpawn();
    }

    assertRightTier("care-triager", model, modelReported, modelPinSatisfied);
    // Tallies are DERIVED from the per-item verdicts (the FSM branches on these counts, ci-round.ts);
    // the items themselves are the dim-8 escape-attribution record persisted to verdicts.md.
    const items = rawItems.map((it: any) => ({
      source: it.source,
      class: it.class,
      missedBy: it.missed_by,
      severity: it.severity as TriageItem["severity"] | undefined,
      verdict: it.verdict,
      reason: it.reason,
      threads: Array.isArray(it.threads)
        ? it.threads.filter((n: any): n is number => typeof n === "number")
        : undefined,
    }));
    const addressCount = items.filter((i) => i.verdict === "address").length;
    const declineCount = items.filter((i) => i.verdict === "decline").length;
    return {
      schema: "care-loop/skill-result@1",
      skill: "care-triager",
      round,
      terminalState: "done",
      verdict: addressCount > 0 ? "address" : "clean",
      reasonCode: "triaged",
      payload: { addressCount, declineCount, items },
      cost,
      modelUsed: model,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  };
}

// ── Test-grader (Step 4b) ─────────────────────────────────────────────────────────────────────────
// Single-spawn promptStructured with pre-read inputs (criteria.md + spec files extracted from the
// diff). Pre-reading eliminates agentic file exploration — the same lever that cut the triager from
// 255s to 55s. Fan-out per spec file is architecturally identical to the triager fan-out (map=grade
// per spec file, reduce=aggregate criterion coverage) but most PRs have 1-3 spec files so single-spawn
// is sufficient; add fan-out if a large spec suite causes timeout or quality issues.
//
// `worktree` is the main repo path used to pre-read spec files (read-only, like the triager).
// If absent (e.g. --skip-plan or no worktree), the grader falls back to reasoning from the diff alone.

const TEST_GRADE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["verdict", "criteria_grades"],
  properties: {
    verdict: {
      enum: ["pass", "wrong", "advisory"],
      description:
        "pass = all criteria Covered; wrong = any criterion has Wrong grade (blocks → loopback to e2e author); advisory = Weak/Missing only",
    },
    criteria_grades: {
      type: "array",
      description: "one entry per acceptance criterion",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "verdict", "criticality"],
        properties: {
          criterion: { type: "string" },
          verdict: { enum: ["Covered", "Weak", "Missing", "Wrong"] },
          criticality: { enum: ["Critical", "Secondary", "Polish"] },
          finding: { type: "string", description: "what is wrong or missing" },
          fix: { type: "string", description: "minimal fix suggestion" },
        },
      },
    },
  },
} as const;

/** Extract spec/test file paths referenced in a diff (lines like `+++ b/tests/foo.spec.ts`). */
function specPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = /^\+\+\+ b\/(.+\.spec\.tsx?|.+\.test\.tsx?)$/.exec(line);
    if (m) paths.add(m[1]);
  }
  return [...paths];
}

/** Default test-grader (Step 4b): single-spawn with pre-read criteria + spec files. */
export function opencodeTestGrader(
  models: SkillModels = {},
  worktree?: string,
): TestGrader {
  const provider = models.provider ?? defaults.provider;
  const model = models.testGrader ?? defaults.testGrader;
  const timeoutMs = Number(process.env.OC_TEST_GRADER_TIMEOUT_MS) || 360_000;
  return async ({ diff, runDir, round }) => {
    const startedAt = new Date().toISOString();
    const methodology = testGraderMethodology();

    // Pre-read criteria.md from the run dir (written by Step 1 planner).
    let criteriaBlock = "";
    try {
      const criteria = readFileSync(join(runDir, "criteria.md"), "utf8").trim();
      if (criteria)
        criteriaBlock = `\n\n=== ACCEPTANCE CRITERIA (from Step 1 plan) ===\n${criteria}\n=== END CRITERIA ===`;
    } catch {
      /* no plan → grade without criteria, advisory only */
    }

    // Pre-read spec files so the grader can verdict in a single shot without tool calls.
    const specPaths = specPathsFromDiff(diff);
    const specBlocks: string[] = [];
    for (const p of specPaths) {
      if (!worktree) break;
      try {
        const content = readFileSync(join(worktree, p), "utf8");
        specBlocks.push(
          `=== SPEC FILE: ${p} ===\n${content}\n=== END SPEC FILE ===`,
        );
      } catch {
        /* file deleted in the diff — skip */
      }
    }

    const hasSpecs = specPaths.length > 0;
    if (!hasSpecs) {
      // No spec files in this diff — grade is skipped (specs are optional).
      return {
        schema: "care-loop/skill-result@1",
        skill: "care-test-grader",
        round,
        terminalState: "done",
        verdict: "pass",
        reasonCode: "no_specs",
        payload: { hasSpecs: false, criteriaGrades: [] },
        modelUsed: model,
        startedAt,
        endedAt: new Date().toISOString(),
      };
    }

    const system =
      "You are the care-loop test-grader (Step 4b, judgment tier). The acceptance criteria and spec " +
      "files are supplied inline — do NOT read additional files, survey the repository, or confirm with " +
      "a user. Grade each acceptance criterion against the specs below, applying the methodology. " +
      'Set verdict="wrong" if any criterion is Wrong (blocks); "pass" if all Covered; "advisory" otherwise. ' +
      "Respond ONLY as the required JSON." +
      (methodology
        ? `\n\n=== GRADING METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`
        : "");

    const task =
      `Grade the following specs against the acceptance criteria.\n\n` +
      `=== DIFF (for context) ===\n${diff}\n=== END DIFF ===${criteriaBlock}\n\n` +
      (specBlocks.length > 0
        ? specBlocks.join("\n\n")
        : specPaths
            .map(
              (p) =>
                `(Spec file ${p} not found on disk — reason from the diff.)`,
            )
            .join("\n"));

    const out = await promptStructured(
      {
        role: "care-test-grader",
        providerID: provider,
        modelID: model,
        system,
        task,
        round,
        timeoutMs,
      },
      TEST_GRADE_SCHEMA,
    );

    const grades: any[] = Array.isArray(out.data?.criteria_grades)
      ? out.data.criteria_grades
      : [];
    assertRightTier(
      "care-test-grader",
      model,
      out.modelReported,
      out.modelPinSatisfied,
    );
    return {
      schema: "care-loop/skill-result@1",
      skill: "care-test-grader",
      round,
      terminalState: "done",
      verdict: (out.data?.verdict as string) ?? "advisory",
      reasonCode: "graded",
      payload: {
        hasSpecs: true,
        criteriaGrades: grades.map((g: any) => ({
          criterion: g.criterion,
          verdict: g.verdict,
          criticality: g.criticality,
          finding: g.finding,
          fix: g.fix,
        })),
      },
      cost: out.cost,
      modelUsed: out.modelReported ?? model,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  };
}

// ── UX-validator (Step 4c) ─────────────────────────────────────────────────────────────────────────
// Diff-bounded like the 4a reviewer — the static care-ux-review lens applied as a full dedicated pass.
// Fan-out per .tsx file is a natural fit (pre-read each file, map=per-file UX check,
// reduce=consolidate by severity) and mirrors the triager architecture exactly. Deferred pending
// quality data from single-spawn runs; add if large .tsx-heavy PRs hit timeout or need parallelism.

const UX_VALIDATE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason_code"],
  properties: {
    verdict: {
      enum: ["pass", "findings", "overflow", "blocked"],
      description:
        "pass = clean; findings = Convention/Polish only (advisory, advance); overflow = layout/overflow Broken (loopback); blocked = a11y/UX Broken defect (loopback)",
    },
    reason_code: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "note"],
        properties: {
          severity: { enum: ["Broken", "Convention", "Polish"] },
          file: { type: "string" },
          line_hint: { type: "string" },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

/** Default UX-validator (Step 4c): diff-bounded static UX review, same transport as the 4a reviewer.
 *  Uses only the care-ux-review static methodology (not blended with diff-review/technical-review).
 *  Verdict "overflow"/"blocked" → loopback; "findings"/"pass" → advance. */
export function opencodeUxValidator(models: SkillModels = {}): UxValidator {
  const provider = models.provider ?? defaults.provider;
  const model = models.uxValidator ?? defaults.uxValidator;
  const timeoutMs = Number(process.env.OC_UX_VALIDATOR_TIMEOUT_MS) || 360_000;
  return async ({ diff, round }) => {
    const startedAt = new Date().toISOString();
    const methodology = uxValidatorMethodology();
    const system =
      "You are the care-loop UX-validator (Step 4c, judgment tier). The diff is supplied inline and is " +
      "COMPLETE. Apply the static UX review methodology below using ONLY the inline diff: do NOT read " +
      "other files, open the repository, or confirm with a user. Identify Broken/Convention/Polish issues " +
      'only on changed surfaces. Set verdict="overflow" for layout/overflow Broken issues, "blocked" for ' +
      'other a11y/UX Broken issues, "findings" for Convention/Polish only, "pass" if clean. ' +
      "Respond ONLY as the required JSON." +
      (methodology
        ? `\n\n=== UX REVIEW METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`
        : "");

    const out = await promptStructured(
      {
        role: "care-ux-validator",
        providerID: provider,
        modelID: model,
        system,
        task: `Review this diff for UX/layout issues.\n\n=== DIFF ===\n${diff}\n=== END DIFF ===`,
        round,
        timeoutMs,
      },
      UX_VALIDATE_SCHEMA,
    );

    const findings: any[] = Array.isArray(out.data?.findings)
      ? out.data.findings
      : [];
    assertRightTier(
      "care-ux-validator",
      model,
      out.modelReported,
      out.modelPinSatisfied,
    );
    return {
      schema: "care-loop/skill-result@1",
      skill: "care-ux-validator",
      round,
      terminalState: "done",
      verdict: (out.data?.verdict as string) ?? "findings",
      reasonCode: (out.data?.reason_code as string) ?? "ux_reviewed",
      payload: {
        findings: findings.map((f: any) => ({
          severity: f.severity,
          file: f.file,
          lineHint: f.line_hint,
          note: f.note,
        })),
      },
      cost: out.cost,
      modelUsed: out.modelReported ?? model,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  };
}

// ── CI-fixer (Step 6b ci-fix track) ─────────────────────────────────────────────────────────────
// An edit-only maker (same permission as the implementer) prompted with pre-read CI failure context
// (annotations, check names), the diff, and plan context (criteria.md/decisions.md). The methodology
// carries the test-vs-code classification + guardrails. Outcome: "fixed" (worktree changed), "noop"
// (infra/flake, no edit), or "handoff" (too complex, human needed).

/** Is any failing check a Playwright / e2e spec? Gates the conditional injection of the
 *  playwright mechanics region (CARE selector/assertion idioms + flaky triage) — irrelevant noise
 *  for a tsc/lint/unit failure, load-bearing for an e2e assertion edit. Matches on the check name,
 *  an extracted job-log that reads like a Playwright assertion, OR an annotation path that looks
 *  like a spec / lives under tests/. Exported for unit testing. */
export function isPlaywrightFailure(ciFailures: CiFailure[]): boolean {
  return ciFailures.some(
    (f) =>
      /playwright|e2e|end.to.end/i.test(f.name) ||
      /playwright|\.spec\.tsx?[:(]|toHaveText|toContainText|locator\(/i.test(
        f.log ?? "",
      ) ||
      (f.annotations ?? []).some((a) =>
        /\.spec\.tsx?$|(^|\/)tests\//.test(a.path),
      ),
  );
}

/** Render the failing-check context into the fixer prompt — name, summary, runner annotations, and
 *  (most importantly) the extracted job-log failure detail. Exported for unit testing. */
export function formatCiFailures(
  ciFailures: import("./skill-result.js").CiFailure[],
): string {
  if (!ciFailures.length) return "(no CI failure details available)";
  return ciFailures
    .map((f) => {
      const parts = [`### ${f.name}`];
      if (f.summary) parts.push(`Summary: ${f.summary}`);
      if (f.annotations?.length) {
        parts.push("Annotations:");
        for (const a of f.annotations) {
          parts.push(`  - ${a.path}:${a.line} — ${a.message}`);
        }
      }
      if (f.log) {
        // The real failure detail (which spec, expected-vs-received) — the annotations are usually
        // just runner noise ("shard N failed"). This is what the fixer actually reasons over.
        parts.push("Failure log (extracted from the job log):");
        parts.push("```");
        parts.push(f.log);
        parts.push("```");
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

export function opencodeCiFixer(
  models: SkillModels = {},
  worktree?: string,
  base?: string,
): CiFixer {
  const provider = models.provider ?? defaults.provider;
  const model = models.ciFixer ?? models.implementer ?? defaults.implementer;
  return async ({
    ciFailures,
    runDir,
    round,
    findings: gateFindingsOverride,
  }) => {
    const startedAt = new Date().toISOString();
    const methodology = ciFixerMethodology();
    const before = worktree
      ? git(worktree, "rev-parse", "HEAD").out.trim()
      : "";

    const readRunFile = (name: string): string => {
      try {
        return readFileSync(join(runDir, name), "utf8").trim();
      } catch {
        return "";
      }
    };

    // Build the CI failure context block.
    const failureBlock = `=== FAILING CI CHECKS ===\n${formatCiFailures(ciFailures)}\n=== END FAILING CI CHECKS ===`;

    // Plan context (criteria + decisions) — same pattern as the implementer's planContext().
    const criteria = readRunFile("criteria.md");
    const decisions = readRunFile("decisions.md");
    const planParts: string[] = [];
    if (criteria)
      planParts.push(
        `## Acceptance criteria — the new behaviour must satisfy ALL of these\n${criteria}`,
      );
    if (decisions)
      planParts.push(
        `## Decisions from the plan interview — follow these exactly; respect the non-goals\n${decisions}`,
      );
    const planBlock = planParts.length
      ? `\n\n=== APPROVED PLAN ===\n${planParts.join("\n\n")}\n=== END PLAN ===`
      : "";

    // Diff context so the fixer can see what changed.
    let diffBlock = "";
    if (worktree && base) {
      const diff = git(worktree, "diff", `${base}...HEAD`).out;
      if (diff)
        diffBlock = `\n\n=== CHANGE DIFF ===\n${diff}\n=== END DIFF ===`;
    }

    // Build the prompt: gate-loopback findings override the normal CI-fix flow.
    let body: string;
    if (gateFindingsOverride) {
      body =
        `Your previous CI fix did not pass the local gate. Fix these errors, change only what's needed:\n${gateFindingsOverride}\n\n` +
        `Original CI failures for context:\n${failureBlock}${planBlock}${diffBlock}`;
    } else {
      body =
        `Remote CI is red after all bot review feedback was addressed. Read the failing checks below, ` +
        `classify each failure (test stale / code wrong / infra-flake), and make the minimal edit.\n\n` +
        `${failureBlock}${planBlock}${diffBlock}`;
    }

    const methodologyBlock = methodology
      ? `\n\n=== CI-FIX METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`
      : "";

    // A failing e2e check → append the CARE Playwright mechanics (selector/assertion idioms, flaky
    // triage) so a spec edit follows the repo's conventions. Skipped for tsc/lint/unit failures,
    // where it would be noise. Conditional injection mirrors reviewerMethodology({ tsx }).
    const pwMechanics = playwrightMechanics();
    const playwrightBlock =
      pwMechanics && isPlaywrightFailure(ciFailures)
        ? `\n\n=== CARE PLAYWRIGHT MECHANICS (a failing check is an e2e/Playwright spec — follow these conventions for any spec edit; do NOT author new tests) ===\n${pwMechanics}\n=== END PLAYWRIGHT MECHANICS ===`
        : "";

    const prompt =
      IMPLEMENTER_PREAMBLE + body + methodologyBlock + playwrightBlock;

    const r = runHelper({
      cmd: "opencode",
      args: [
        "run",
        "--dir",
        worktree ?? runDir,
        "--model",
        `${provider}/${model}`,
        prompt,
      ],
      env: { ...process.env, OPENCODE_PERMISSION: IMPLEMENTER_PERMISSION },
      logPath: join(runDir, "agents", `ci-fixer-r${round}.log`),
      timeoutMs: 300_000,
    });

    const after = worktree ? git(worktree, "rev-parse", "HEAD").out.trim() : "";
    const porcelain = worktree
      ? git(worktree, "status", "--porcelain").out.trim()
      : "";
    const dirty = porcelain.length > 0;
    const changed = dirty || (after !== "" && after !== before);
    const filesChanged = porcelain
      ? porcelain
          .split("\n")
          .map((l) => l.slice(3).trim())
          .filter(Boolean)
      : [];

    // Classify the outcome:
    // - exit 0 + tree changed → "fixed"
    // - exit 0 + tree clean → "noop" (fixer decided not to edit, likely infra/flake)
    // - nonzero exit → "handoff" (fixer failed or timed out)
    const outcome: CiFixPayload["outcome"] =
      r.exit === 0 && changed ? "fixed" : r.exit === 0 ? "noop" : "handoff";

    return {
      schema: "care-loop/skill-result@1",
      skill: "care-ci-fix",
      round,
      terminalState: outcome === "handoff" ? "failed" : "done",
      verdict: outcome,
      reasonCode:
        outcome === "fixed"
          ? dirty
            ? "ci_fix_uncommitted"
            : "ci_fix_committed"
          : outcome === "noop"
            ? "ci_fix_no_change"
            : `ci_fix_exit_${r.exit}`,
      payload: { outcome, filesChanged },
      modelUsed: model,
      startedAt,
      endedAt: new Date().toISOString(),
    };
  };
}

// ── Planner (Step 1) ─────────────────────────────────────────────────────────────────────────────
// Two one-shot spawns per the relay mechanics (the `care-planner` skill): interview (recon → batched
// questions) then plan (draft the artifacts). Both run read-only (JUDGMENT_PERMISSION in
// opencode-runner: edit/bash/webfetch deny, external_directory allow) so recon can READ the main repo
// via native read/grep/glob tools (absolute paths under mainRepoPath) without a headless permission stall.
// TIER SPLIT: the interview/recon spawn is turn-heavy foraging (navigation, not judgment) and runs on
// the FAST maker tier (models.plannerRecon) — the dominant cost of the ~8-min planner was opus's
// per-turn latency × many recon turns, and prompt-caching (verified honored through the Copilot proxy)
// already covers the transcript re-processing, so a cheaper per-turn model is the real speed lever. The
// PLAN spawn — the judgment call the gate enforces (plan.ts modelPinSatisfied) — stays on the judgment tier.

const PLANNER_INTERVIEW_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "prompt"],
        properties: { id: { type: "string" }, prompt: { type: "string" } },
      },
      description:
        "batched questions whose answers would change the diff; empty if none",
    },
  },
} as const;

const PLANNER_PLAN_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: [
    "scope",
    "files",
    "approach",
    "criteria",
    "classification",
    "plannedBy",
  ],
  properties: {
    scope: { type: "string" },
    files: {
      type: "array",
      items: { type: "string" },
      description: "real paths confirmed by recon",
    },
    approach: { type: "string" },
    criteria: {
      type: "array",
      items: { type: "string" },
      description: "testable acceptance criteria",
    },
    nonGoals: { type: "array", items: { type: "string" } },
    testSurface: {
      type: "string",
      description: "routes / data-testids / ARIA the e2e author needs",
    },
    uiSurfaces: {
      type: "string",
      description: "ui-surfaces.md body; only when .tsx is touched",
    },
    classification: { enum: ["trivial", "standard", "complex"] },
    plannedBy: {
      type: "string",
      description:
        "your model identity, e.g. 'Opus 4.8' — for the mandatory Planned by line",
    },
  },
} as const;

export function buildPlannerInterviewSystem(): string {
  const methodology = plannerMethodology();
  const base =
    "You are the care-loop planner in the INTERVIEW phase. Recon the repository " +
    "read-only (native read/grep/glob under the given absolute repo path) to confirm the real files and " +
    "the nearest reusable pattern, then produce a batched list of interview questions whose answers would " +
    "change the diff. The only filter is 'does the answer change the diff?'. Return NO questions if truly " +
    "none apply. End your turn with your recon findings and the numbered list of interview questions in " +
    "plain prose — do NOT emit JSON yet; a follow-up turn will ask you to format them.";
  if (!methodology) return base;
  return `${base}\n\n=== PLANNER METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`;
}

/** Turn B (emit) system for the interview: the recon already happened agentically in Turn A; this turn
 *  only serialises the questions into the schema. No exploration — that's the whole point of the split
 *  (structured output over an agentic loop causes the serial-spin; see promptAgenticThenStructured). */
export function buildPlannerInterviewEmitSystem(): string {
  return (
    "You are the care-loop planner, still in the INTERVIEW phase. In your previous turn you completed " +
    "the recon and produced a numbered list of interview questions. Now emit EXACTLY those questions as " +
    "the required JSON — one entry per question, preserving their order and intent. Do NOT explore, read, " +
    "or grep anything further, and do NOT invent new questions. If you produced no questions, return an " +
    "empty list. Respond ONLY as the required JSON."
  );
}

function buildPlannerPlanSystem(): string {
  const methodology = plannerMethodology();
  const base =
    "You are the care-loop planner (judgment tier) in the PLAN phase. The interview questions below " +
    "already contain the recon findings (real file paths + line numbers + the nearest reusable patterns) " +
    "— RELY on them as your grounding and read at most one or two files ONLY to confirm a specific detail; " +
    "do NOT re-survey the repository. Using the task + the interview Q&A (and any amendment), produce the " +
    "plan: scope, files, approach, testable acceptance criteria, non-goals, a test-surface contract " +
    "(routes / data-testids / ARIA labels the e2e author needs), ui-surfaces (ONLY if the change touches " +
    "src/**/*.tsx), a change classification (trivial | standard | complex), and plannedBy = your own model " +
    "identity. If the user amended the plan, fold the amendment in and rewrite. End your turn with the full " +
    "plan written out in plain prose — do NOT emit JSON yet; a follow-up turn will ask you to format it.";
  if (!methodology) return base;
  return `${base}\n\n=== PLANNER METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`;
}

/** Turn B (emit) system for the PLAN phase: the plan was drafted agentically in Turn A; this turn only
 *  serialises it into the schema. No further file reads — same split rationale as the interview phase
 *  (structured output over an agentic loop causes the serial-spin; see promptAgenticThenStructured). */
function buildPlannerPlanEmitSystem(): string {
  return (
    "You are the care-loop planner in the PLAN phase. In your previous turn you drafted the full plan. " +
    "Now emit EXACTLY that plan as the required JSON — scope, files, approach, criteria, nonGoals, " +
    "testSurface, uiSurfaces (only if the change touches src/**/*.tsx), classification, and plannedBy = " +
    "your own model identity. Do NOT read, grep, or explore anything further, and do NOT change the plan. " +
    "Respond ONLY as the required JSON."
  );
}

/** Default planner: opencode structured output. The INTERVIEW/recon phase runs on the fast (maker) tier
 *  (models.plannerRecon); the PLAN phase runs on the judgment tier (models.planner) and is the one
 *  enforced at the gate (plan.ts modelPinSatisfied). See the TIER SPLIT note above. */
export function opencodePlanner(models: SkillModels = {}): Planner {
  const provider = models.provider ?? defaults.provider;
  const planModel = models.planner ?? defaults.planner; // judgment tier — the gated PLAN phase
  const reconModel = models.plannerRecon ?? defaults.plannerRecon; // fast tier — the INTERVIEW/recon phase
  // Planning is heavier than a reviewer/triager spawn (recon over the repo), so it gets a more
  // generous cap than the default 240s judgment timeout. Override via OC_PLANNER_TIMEOUT_MS.
  const timeoutMs = Number(process.env.OC_PLANNER_TIMEOUT_MS) || 480_000;
  return async ({
    task,
    ticket,
    mainRepoPath,
    phase,
    questions,
    answers,
    amendment,
    round,
  }) => {
    const startedAt = new Date().toISOString();
    const envelope = (
      payload: import("./skill-result.js").PlannerPayload,
      verdict: string,
      reasonCode: string,
      usedModel: string,
      plannedBy?: string,
      cost?: import("./opencode-runner.js").SpawnCost,
    ) => ({
      schema: "care-loop/skill-result@1" as const,
      skill: "care-planner",
      round,
      terminalState: "done" as const,
      verdict,
      reasonCode,
      payload,
      cost,
      modelUsed: plannedBy ?? usedModel,
      startedAt,
      endedAt: new Date().toISOString(),
    });

    if (phase === "interview") {
      // TWO-TURN split: Turn A explores agentically with NO `format` (structured output over an
      // agentic tool loop collapses it into a non-convergent serial spin — measured), Turn B emits the
      // questions as JSON in the same warm session. See promptAgenticThenStructured.
      const { data, cost } = await promptAgenticThenStructured(
        {
          role: "care-planner",
          providerID: provider,
          modelID: reconModel,
          reconSystem: buildPlannerInterviewSystem(),
          task: `Ticket ${ticket}. Task: ${task}\nRepo (read-only, absolute paths): ${mainRepoPath}\nRecon, then produce the questions that would change the diff.`,
          emitSystem: buildPlannerInterviewEmitSystem(),
          emitInstruction:
            "Emit the interview questions from your recon as the required JSON now.",
          round,
          timeoutMs,
        },
        PLANNER_INTERVIEW_SCHEMA,
      );
      const questions = Array.isArray(data.questions) ? data.questions : [];
      return envelope(
        { phase: "interview", questions },
        "questions",
        "interview",
        reconModel,
        undefined,
        cost,
      );
    }

    const qa =
      (questions ?? []).length > 0
        ? (questions ?? [])
            .map(
              (q) =>
                `- Q(${q.id}): ${q.prompt}\n  A: ${(answers ?? []).find((a) => a.id === q.id)?.answer ?? "(no answer)"}`,
            )
            .join("\n")
        : (answers ?? []).map((a) => `- (${a.id}) ${a.answer}`).join("\n") ||
          "(no interview Q&A)";
    const amendBlock = amendment
      ? `\n\nUser amendment to fold in and rewrite around:\n${amendment}`
      : "";
    // TWO-TURN split (same fix as the interview phase): Turn A drafts the plan agentically with NO
    // `format` (it reads a file or two to confirm details — structured output over that tool loop
    // spins), Turn B emits the plan as JSON in the same warm session.
    const { data, modelReported, modelPinSatisfied, cost } =
      await promptAgenticThenStructured(
        {
          role: "care-planner",
          providerID: provider,
          modelID: planModel,
          reconSystem: buildPlannerPlanSystem(),
          task: `Ticket ${ticket}. Task: ${task}\nRepo (read-only, absolute paths; the Q&A below already cites the relevant files): ${mainRepoPath}\n\nInterview Q&A (contains the recon findings — rely on these):\n${qa}${amendBlock}\n\nProduce the plan.`,
          emitSystem: buildPlannerPlanEmitSystem(),
          emitInstruction:
            "Emit the plan you just drafted as the required JSON now.",
          round,
          timeoutMs,
        },
        PLANNER_PLAN_SCHEMA,
      );
    const plannedBy =
      (typeof data.plannedBy === "string" && data.plannedBy) || modelReported;
    return envelope(
      {
        phase: "plan",
        scope: data.scope,
        files: Array.isArray(data.files) ? data.files : [],
        approach: data.approach,
        criteria: Array.isArray(data.criteria) ? data.criteria : [],
        nonGoals: Array.isArray(data.nonGoals) ? data.nonGoals : [],
        testSurface: data.testSurface,
        uiSurfaces: data.uiSurfaces,
        classification: data.classification,
        plannedBy,
        modelPinSatisfied,
      },
      "planned",
      data.classification ?? "standard",
      planModel,
      plannedBy,
      cost,
    );
  };
}
