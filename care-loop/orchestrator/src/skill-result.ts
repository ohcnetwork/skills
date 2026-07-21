// skill-result.ts — the ONE return envelope every skill wrapper shares (PLAN: unified skill contract).
//
// A "skill" is any swappable step of the loop (reviewer, implementer, triager, and — later — planner,
// ux-validator, test-grader). They all do the same thing: take some input, produce a verdict + a typed
// payload + (Phase 2) log artifacts. Unifying their RETURN shape means a new skill plugs in without
// touching the drivers, and the doctor-loop can read every skill's output the same way.
//
// Layer boundary (deliberate): this envelope is the SKILL layer's contract. The deterministic drivers
// (pipeline SpawnFn, ci-round TriageFn) still consume MINIMAL digests — thin adapters reduce this
// envelope for the FSM (roleSpawn / reduceTriage in orchestrate.ts). The envelope never enters the
// pure control loop.
//
// This is distinct from jobresult.ts: JobResult@1 is the opencode STRUCTURED-OUTPUT wire schema the
// reviewer LLM must return; a wrapper parses that into this envelope. Different concerns, on purpose.

import type { PlanQuestion } from "./plan-gate.js";

export interface SkillArtifact {
  name: string; // logical name, e.g. "diff" | "findings" | "raw"
  path: string; // run-dir-relative path to the sidecar file (Phase 2 writes these)
  sha256: string; // content hash — the journal event points at the artifact by hash (Phase 2)
}

/** The common wrapper envelope. `P` is the role-specific payload (see the *Payload types below). */
export interface SkillResult<P = unknown> {
  schema: "care-loop/skill-result@1";
  skill: string; // "care-reviewer" | "implementer" | "care-triager" | future ids
  round: number;
  terminalState: "done" | "needs_input" | "blocked" | "failed";
  verdict: string; // role-specific enum (the FSM switches on this, via the adapter)
  reasonCode: string; // machine-readable outcome for the FSM + doctor
  payload: P; // typed, role-specific (the rich content the doctor cares about)
  // Optional metadata — populated best-effort; Phase-2 logging leans on these.
  runId?: string;
  step?: string;
  artifacts?: SkillArtifact[];
  evidence?: string[];
  modelUsed?: string;
  cost?: { inputTokens?: number; outputTokens?: number; usdEst?: number };
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

// ── Per-role payloads ────────────────────────────────────────────────────────────────────────────

export interface ReviewFinding {
  class: string; // "correctness" | "overengineering" | "legibility" | "other"
  file: string;
  lineHint?: string;
  note: string;
  applied?: boolean; // did the maker act on it (filled later, when known)
}
export interface ReviewPayload {
  findings: ReviewFinding[];
}

export interface ImplementPayload {
  filesChanged: string[]; // worktree paths touched
  staged: boolean; // whether the maker staged (edit-only maker → false; orchestrator stages at step 5)
  timedOut: boolean; // hit the wall-clock cap (transient — own retry budget)
}

/** One triaged feedback item — the per-comment address/decline the doctor uses to tune skills. */
export interface TriageItem {
  source?: string; // bot / reviewer name
  id?: string; // comment id
  path?: string;
  line?: number;
  class?: string; // correctness | legibility | overengineering | ux | test | other
  /** Bot-declared severity, normalized across bots. CodeRabbit tags every finding inline
   *  (🔴 Critical/🟠 Major → "high"; 🟡 Minor → "medium"; 🧹 Nitpick → "low"). Copilot's
   *  severity badge is a GitHub-UI-only field that never appears in the comment body, so
   *  Copilot items are always "none". Greptile prose carries no structured severity → "none".
   *  "none" also covers untagged CodeRabbit items. */
  severity?: "high" | "medium" | "low" | "none";
  missedBy?: string; // which of OUR steps should have caught it first: care-reviewer | care-technical-review | care-ux-review | care-test-grade | novel | none — the dim-8 escape-attribution signal
  verdict: "address" | "decline"; // two verdicts only — the loop handles everything, nothing is deferred to a human (out-of-scope items are declined with a reason)
  reason?: string;
  threads?: number[]; // GitHub review-thread comment id(s) this verdict covers (from the feedback digest's `(thread NNN)` refs); Step 7 replies + resolves these. Union of all deduped bot comments' ids.
}
export interface TriagePayload {
  addressCount: number;
  declineCount: number;
  items?: TriageItem[]; // per-item detail (Phase 2 enriches the triage schema to fill this)
}

// ── Step-4b / 4c payloads ────────────────────────────────────────────────────────────────────────

export interface TestGradeFinding {
  criterion: string;
  verdict: "Covered" | "Weak" | "Missing" | "Wrong";
  criticality: "Critical" | "Secondary" | "Polish";
  finding?: string; // what is weak/missing/wrong
  fix?: string; // minimal fix suggestion
}
export interface TestGradePayload {
  hasSpecs: boolean; // false when no spec files were found in the diff (grade is skipped)
  criteriaGrades: TestGradeFinding[];
}

export interface UxFinding {
  severity: "Broken" | "Convention" | "Polish";
  file: string;
  lineHint?: string;
  note: string;
}
export interface UxValidatePayload {
  findings: UxFinding[];
}

/** CI-fixer payload — returned by the CiFixer port (Step 6b ci-fix track). */
export interface CiFixPayload {
  /** fixed = committed a change; handoff = can't fix (human checkpoint); noop = nothing to do */
  outcome: "fixed" | "handoff" | "noop";
  filesChanged: string[];
}

/** A single failing CI check as reported by listFailingChecks. */
export interface CiFailure {
  name: string; // check-run name or legacy-status context
  summary?: string; // truncated output summary, when available
  annotations?: { path: string; line: number; message: string }[]; // runner-level annotations
  log?: string; // extracted failure detail from the Actions job log (the real assertion/stack)
}

/** Planner payload — the 4th skill. A planner spawn runs in one of two phases: `interview` (recon →
 *  batched questions) or `plan` (draft the artifacts). The typed plan fields below are STRUCTURAL, not
 *  optional-by-convenience: downstream runners consume them — `criteria` is read directly by the Step-4b
 *  test-grader, `testSurface` by the Step-3 e2e author, `uiSurfaces` by Step-4c ui-validate. `plannedBy`
 *  is the planner's model self-identification, surfaced as the mandatory `Planned by:` gate line. */
export interface PlannerPayload {
  phase: "interview" | "plan";
  questions?: PlanQuestion[]; // interview phase
  // plan phase (all present when phase === "plan"):
  scope?: string;
  files?: string[]; // real paths confirmed by recon
  approach?: string;
  criteria?: string[]; // testable acceptance criteria → criteria.md
  nonGoals?: string[]; // explicit boundary → decisions.md
  testSurface?: string; // routes / data-testids / ARIA the e2e author needs → baseline.md
  uiSurfaces?: string; // ui-surfaces.md body (only when .tsx touched)
  classification?: "trivial" | "standard" | "complex";
  plannedBy?: string; // model self-id → mandatory `Planned by:` line; kept as display only
  /** opencode's own pin check (modelReported.includes(configuredJudgmentModel)) — the enforcement
   *  gate in plan.ts aborts `plan_wrong_tier` only when this is explicitly false, never on the
   *  self-report string. Undefined = model unverifiable → no abort (safe fallback). */
  modelPinSatisfied?: boolean;
}
