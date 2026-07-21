// ports.ts — the swappable seams of the orchestrator, in one place (PLAN §"ports & adapters", lean cut).
//
// The drivers already take these via dependency injection; this file just NAMES them so you can plug
// a different reviewer, implementer, triager — or a whole different loop — without touching the core.
// Nothing here has behavior; it's the catalog of contracts. Default implementations live in
// skills-opencode.ts (role skills), github.ts (OctokitGitHub), shell.ts (git/gate).

import type {
  SkillResult,
  ReviewPayload,
  ImplementPayload,
  TriagePayload,
  TestGradePayload,
  UxValidatePayload,
  PlannerPayload,
  CiFixPayload,
  CiFailure,
} from "./skill-result.js";
import type { PlanAnswer, PlanQuestion } from "./plan-gate.js";

// ── Infra seams (existing) ──────────────────────────────────────────────────────────────────────
export type {
  GitHubApi,
  PrInfo,
  CheckSummary,
  CiConclusion,
} from "./github.js"; // GitHub I/O (adapter: OctokitGitHub)
export type { Bot } from "./poll.js"; // reviewer-bot set for the CI wait
export type {
  SpawnFn,
  SpawnResult,
  HelperFn,
  HelperOutcome,
} from "./pipeline.js"; // build-driver DI
export type {
  TriageResult,
  TriageFn,
  ApplyFn,
  GateFn,
  PushFn,
} from "./ci-round.js"; // ci-round DI

// The unified skill envelope every role wrapper returns (skill-result.ts). Re-exported here so the
// skill layer has one import site for the contract.
export type {
  SkillResult,
  SkillArtifact,
  ReviewPayload,
  ReviewFinding,
  ImplementPayload,
  TriagePayload,
  TriageItem,
  TestGradePayload,
  TestGradeFinding,
  UxValidatePayload,
  UxFinding,
  PlannerPayload,
  CiFixPayload,
  CiFailure,
} from "./skill-result.js";

// The interactive plan-stage seams (plan-gate.ts / plan-front.ts) — one import site for the contract.
export type {
  PlanGate,
  PlanQuestion,
  PlanAnswer,
  ConsolidatedAsk,
  ApprovalDecision,
} from "./plan-gate.js";
export type { PlanFront, PlanInput } from "./plan-front.js";

/** Injectable clock — real by default, stubbed in tests so waits are instant/deterministic. */
export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** Worktree provisioning seam — makes a fresh `git worktree add` runnable (the generated/ignored
 *  artifacts a checkout needs: node_modules, generated sources, env). Default = symlink from the main
 *  checkout (provision.ts); a cloud worker can swap in `npm ci` + a real generate step. */
export type Provisioner = (input: {
  worktree: string;
  mainRepoPath: string;
}) => { exit: number; summary: string };

// ── Role-skill seams (the plug points for "a better reviewer/implementer/triager") ───────────────
// Every role wrapper returns the SAME SkillResult<Payload> envelope (skill-result.ts) — uniform,
// pluggable, and doctor-ready. The deterministic drivers (pipeline SpawnFn, ci-round TriageFn) still
// consume MINIMAL digests; orchestrate.ts adapts these envelopes down for the FSM (roleSpawn /
// reduceTriage), so the drivers themselves never see the envelope.

export interface ReviewInput {
  diff: string; // the change under review
  runDir: string;
  round: number;
  step?: string; // FSM step that invoked this skill (for log attribution)
}
export type Reviewer = (
  input: ReviewInput,
) => Promise<SkillResult<ReviewPayload>>;

export interface ImplementInput {
  task: string;
  worktree: string; // the maker edits here
  runDir: string;
  round: number;
  findings?: string; // review/triage findings to address on a re-round
  step?: string; // FSM step that invoked this skill (for log attribution)
}
export type Implementer = (
  input: ImplementInput,
) => Promise<SkillResult<ImplementPayload>>;

export interface TriageInput {
  pr: number;
  round: number;
  runDir: string;
  feedbackPath: string;
}
export type Triager = (
  input: TriageInput,
) => Promise<SkillResult<TriagePayload>>;

/** Test-grader — the 4b judgment skill. Grades spec files against acceptance criteria from the plan. */
export interface TestGradeInput {
  diff: string; // the change under review (spec paths extracted from this)
  runDir: string;
  round: number;
  step?: string; // FSM step that invoked this skill (for log attribution)
}
export type TestGrader = (
  input: TestGradeInput,
) => Promise<SkillResult<TestGradePayload>>;

/** UX-validator — the 4c judgment skill. Static UX review of the diff (diff-bounded, like 4a). */
export interface UxValidateInput {
  diff: string;
  runDir: string;
  round: number;
  step?: string; // FSM step that invoked this skill (for log attribution)
}
export type UxValidator = (
  input: UxValidateInput,
) => Promise<SkillResult<UxValidatePayload>>;

/** CI-fixer — the modular seam for handling remote CI failures (Step 6b ci-fix track).
 *  Default implementation = human-handoff (edits nothing). Swap in a real playwright/lint/tsc
 *  skill by passing a different CiFixer to defaultSeams; per-failure-type dispatch lives INSIDE
 *  the skill — the orchestrator never needs to change. */
export interface CiFixInput {
  ciFailures: CiFailure[]; // failing checks as reported by listFailingChecks
  worktree: string;
  runDir: string;
  round: number;
  findings?: string; // gate-error feedback on a re-apply (MED-B gate loopback)
}
export type CiFixer = (input: CiFixInput) => Promise<SkillResult<CiFixPayload>>;

/** Planner — the 4th role skill (Step 1). One spawn runs one phase: `interview` (recon → questions)
 *  or `plan` (draft the artifacts). `round` is a monotonic per-run spawn counter (interview=1, first
 *  draft=2, each amend increments) so the logging decorator writes distinct input/result sidecars. */
export interface PlannerInput {
  task: string;
  ticket: string;
  mainRepoPath: string; // recon reads here (read-only)
  runDir: string;
  round: number;
  phase: "interview" | "plan";
  questions?: PlanQuestion[]; // plan phase: the interview questions (carry recon context) to reuse
  answers?: PlanAnswer[]; // plan phase: the interview answers to fold in
  amendment?: string; // plan phase: free-text amendment from a gate re-draft
  step?: string; // FSM step that invoked this skill (for log attribution)
}
export type Planner = (
  input: PlannerInput,
) => Promise<SkillResult<PlannerPayload>>;
