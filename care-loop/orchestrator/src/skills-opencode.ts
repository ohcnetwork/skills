// skills-opencode.ts — the DEFAULT role skills, backed by opencode + GitHub Copilot. Each is a thin
// wrapper over the opencode transport (promptStructured / `opencode run`) that satisfies a role port
// from ports.ts. Swapping "a better reviewer" = pass a different Reviewer to orchestrate.ts; these are
// just the batteries-included defaults.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runJudgmentSpawn, promptStructured } from "./opencode-runner.js";
import { runHelper } from "./shell.js";
import {
  reviewerMethodology,
  plannerMethodology,
  triagerMethodology,
} from "./skill-source.js";
import type { Implementer, Planner, Reviewer, Triager } from "./ports.js";

export interface SkillModels {
  provider?: string; // default "github-copilot"
  reviewer?: string; // judgment tier
  implementer?: string; // cheap maker tier
  triager?: string; // judgment tier
  planner?: string; // judgment tier (Opus — the PLAN phase, enforced at the gate)
  plannerRecon?: string; // fast (maker) tier — the INTERVIEW/recon phase; not gated (recon is navigation, not judgment)
}
const defaults = {
  provider: "github-copilot",
  reviewer: "claude-opus-4.8",
  implementer: "claude-sonnet-4.6",
  triager: "claude-opus-4.8",
  planner: "claude-opus-4.8",
  plannerRecon: "claude-sonnet-4.6",
};

// Parallel-exploration directive for the IMPLEMENTER (which forages via `opencode run`, outside the
// judgment transport). SSE-traced root cause of the ~6-min planner: strictly SERIAL exploration — one
// grep per model round-trip, ~3s apart, ~120 round-trips. opencode DOES execute batched tool calls
// concurrently; the model just needs to be told to emit them. The PLANNER now sources the same guidance
// from its methodology (the `care-planner` skill, Phase 1 — Recon) so it's part of "how you recon", not
// a competing addendum; this const carries it to the implementer's prompt. The triager sources the same
// guidance from ITS methodology (the `care-triager` skill — "Verify in PARALLEL"): verify-before-accept
// reads real code paths + adjacent files (judgment permission allows reads; the worktree is baked into
// the triager's prompt), so its exploration eats the same serial round-trip tax. Only the reviewer is
// exempt — it judges the inline diff, nothing to batch.
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

/** Loud breadcrumb when opencode reports a judgment spawn did NOT run on the pinned engine. The
 *  planner has a hard gate (plan.ts); reviewer/triager run headless with no human gate, so at minimum
 *  surface the tier miss (the ENG-559 silent-downgrade class) rather than trusting a downgraded judge. */
function warnIfWrongTier(
  role: string,
  pinned: string,
  reported: string | undefined,
  satisfied: boolean | undefined,
): void {
  if (satisfied === false) {
    console.warn(
      `[care-loop] WARNING: ${role} ran on '${reported ?? "unknown"}' but was pinned to '${pinned}' — model tier not satisfied.`,
    );
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
      });
    warnIfWrongTier("care-reviewer", model, modelReported, modelPinSatisfied);
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
    const reason = done
      ? dirty
        ? "opencode_uncommitted"
        : "opencode_committed"
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
            enum: ["address", "decline", "defer"],
            description:
              "address = auto-fix now, decline = won't (give reason), defer = needs a human",
          },
          missed_by: {
            type: "string",
            description:
              "which of OUR steps should have caught it first: care-reviewer | care-technical-review | care-ux-review | care-test-grade | novel (un-catchable pre-merge) | none (not an escape)",
          },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

/** Default triager: opencode structured output with the triage-tally schema, judgment tier. */
// `worktree` is the branch checkout under review (the code the PR reflects). Baked in here — like
// `apply`/`gate`/`push` close over `cfg.worktree` in default-wiring — so the triager's methodology
// ("verify-before-accept" / "Verify in PARALLEL") has real code to read. Without it the feedback's
// repo-relative paths don't resolve against the server cwd and verification is impossible (the reads
// are permitted by JUDGMENT_PERMISSION.external_directory:allow). Optional so the smoke test still runs.
export function opencodeTriager(
  models: SkillModels = {},
  worktree?: string,
): Triager {
  const provider = models.provider ?? defaults.provider;
  const model = models.triager ?? defaults.triager;
  // The injected triage methodology + multi-item feedback push past the 240s default.
  // Same fix as the reviewer: give extra headroom, override via env for CI/slow models.
  const timeoutMs = Number(process.env.OC_TRIAGER_TIMEOUT_MS) || 360_000;
  return async ({ round, feedbackPath }) => {
    const startedAt = new Date().toISOString();
    const feedback = readFileSync(feedbackPath, "utf8");
    const methodology = triagerMethodology();
    const repoLine = worktree
      ? `Repo under review (read-only, absolute paths): ${worktree}\n` +
        "The feedback's `path:line` references are RELATIVE to this repo root — resolve and read them " +
        "there (and their adjacent files) to verify each finding before you verdict it.\n\n"
      : "";
    const system =
      "You are the care-loop triager (judgment tier). Given the pre-digested bot feedback, apply the " +
      "triage methodology below and return ONE item per distinct piece of feedback. For each: decide a " +
      "verdict (address / decline / defer), classify it, and attribute missed_by = which of OUR pipeline " +
      "steps should have caught it first (care-reviewer | care-technical-review | care-ux-review | " +
      "care-test-grade), or 'novel' if it was genuinely un-catchable before merge, or 'none' if it isn't " +
      "an escape (praise, or our own already-known finding). Return ONLY the items array as the required JSON." +
      (methodology
        ? `\n\n=== TRIAGE METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`
        : "");
    const { data, modelReported, modelPinSatisfied, cost } =
      await promptStructured(
        {
          role: "care-triager",
          providerID: provider,
          modelID: model,
          system,
          task: repoLine + feedback,
          round,
          timeoutMs,
        },
        TRIAGE_SCHEMA,
      );
    warnIfWrongTier("care-triager", model, modelReported, modelPinSatisfied);
    // Tallies are DERIVED from the per-item verdicts (the FSM branches on these counts, ci-round.ts);
    // the items themselves are the dim-8 escape-attribution record persisted to verdicts.md.
    const items = (Array.isArray(data.items) ? data.items : []).map(
      (it: any) => ({
        source: it.source,
        class: it.class,
        missedBy: it.missed_by,
        verdict: it.verdict,
        reason: it.reason,
      }),
    );
    const addressCount = items.filter(
      (i: any) => i.verdict === "address",
    ).length;
    const declineCount = items.filter(
      (i: any) => i.verdict === "decline",
    ).length;
    const deferCount = items.filter((i: any) => i.verdict === "defer").length;
    return {
      schema: "care-loop/skill-result@1",
      skill: "care-triager",
      round,
      terminalState: "done",
      verdict:
        deferCount > 0 ? "defer" : addressCount > 0 ? "address" : "clean",
      reasonCode: "triaged",
      payload: { addressCount, declineCount, deferCount, items },
      cost,
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
    "the nearest reusable pattern, then return a batched list of interview questions whose answers would " +
    "change the diff. The only filter is 'does the answer change the diff?'. Return NO questions if truly " +
    "none apply. Respond ONLY as the required JSON.";
  if (!methodology) return base;
  return `${base}\n\n=== PLANNER METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`;
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
    "identity. If the user amended the plan, fold the amendment in and rewrite. Respond ONLY as the required JSON.";
  if (!methodology) return base;
  return `${base}\n\n=== PLANNER METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===`;
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
      const { data, cost } = await promptStructured(
        {
          role: "care-planner",
          providerID: provider,
          modelID: reconModel,
          system: buildPlannerInterviewSystem(),
          task: `Ticket ${ticket}. Task: ${task}\nRepo (read-only, absolute paths): ${mainRepoPath}\nRecon, then ask the questions that would change the diff.`,
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
    const { data, modelReported, modelPinSatisfied, cost } =
      await promptStructured(
        {
          role: "care-planner",
          providerID: provider,
          modelID: planModel,
          system: buildPlannerPlanSystem(),
          task: `Ticket ${ticket}. Task: ${task}\nRepo (read-only, absolute paths; the Q&A below already cites the relevant files): ${mainRepoPath}\n\nInterview Q&A (contains the recon findings — rely on these):\n${qa}${amendBlock}\n\nProduce the plan.`,
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
