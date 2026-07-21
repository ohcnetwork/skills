// plan-front.ts — the pluggable ENTRY of the plan stage (the part that "goes in front"). What differs
// per workflow is HOW the initial input arrives (terminal argv · a Jira ticket event · a PR event) —
// and because the same workflow that sources the input also carries the conversation, a front ALSO
// supplies the matching gate transport (plan-gate.ts). The invariant core `runPlan` is written once
// and never changes across transports; each new workflow adds only a `PlanFront` adapter.
//
//   const { input, gate } = await front.resolve();
//   await runPlan({ input, planner, gate });   // ← identical for terminal / jira / pr fronts

import type { PlanGate } from "./plan-gate.js";

/** The normalized initial input every workflow must produce for a plan run. `runDir` and `worktree`
 *  are derived by the front from (repo, branch) using the same convention as `start`, so the plan and
 *  the later autonomous loop resolve to the SAME run dir + worktree. */
export interface PlanInput {
  task: string;
  ticket: string; // ENG-### — baked into the PR title downstream
  branch: string;
  summary: string; // PR-title summary
  repo: string; // owner/name
  mainRepoPath: string; // the main checkout recon reads (read-only)
  worktree: string; // where `start` will later create the worktree
  runDir: string; // <skill-dir>/runs/<repo>-<branch-flat>
}

/** A pluggable front: source the initial input + provide the matching gate, then delegate to runPlan. */
export interface PlanFront {
  resolve(): Promise<{ input: PlanInput; gate: PlanGate }>;
}
