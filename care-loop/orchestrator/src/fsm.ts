// fsm.ts — the deterministic transition function (PLAN-orchestrator-architecture §2, principle #1:
// "no LLM in the control loop"). Pure, table-driven, unit-testable without any LLM/git/opencode.
// Every scheduling decision is `transition(step, signal, ctx) → { next, reason }` over validated
// inputs only (a normalized Signal derived from a JobResult verdict, a helper exit code, or budget).

import type { Step } from "./state.js";
import type { Signal } from "./roles.js";

export interface FsmConfig {
  /** Ordered review steps enabled for this run. Half-pipe = ["4a"]; full = ["4a","4b","4c"]. */
  reviewSteps: Step[];
  /** Max genuine implement attempts (a broken change) before escalate→abort. */
  maxImplementRetries: number;
  /** Max maker wall-clock timeouts before escalate→abort (separate from retries). Default 2. */
  maxImplementTimeouts?: number;
}

export interface Transition {
  next: Step;
  reason: string;
}

export class FsmError extends Error {}

/** After a review step passes, the next enabled review step, or gate (5) when none remain. */
function nextReviewOrGate(cur: Step, cfg: FsmConfig): Step {
  const i = cfg.reviewSteps.indexOf(cur);
  return i >= 0 && i + 1 < cfg.reviewSteps.length ? cfg.reviewSteps[i + 1] : "5";
}

/**
 * Pure transition. `attempt` is the current attempt count for retryable steps (implement).
 * Throws FsmError on an (step × signal) pair with no defined edge — an undefined transition is a
 * bug to surface loudly, never a silent no-op.
 */
export function transition(
  step: Step,
  signal: Signal,
  ctx: { attempt?: number; cfg: FsmConfig },
): Transition {
  const { cfg } = ctx;
  const attempt = ctx.attempt ?? 1;

  // Budget stop is honored from any step, actioned at this boundary (§8).
  if (signal === "budget-stop") return { next: "aborted", reason: "budget_stop" };

  switch (step) {
    case "1": // plan (gate handled by the caller; here we only model the plan spawn outcome)
      if (signal === "advance") return { next: "2", reason: "plan_ready" };
      if (signal === "needs_input") return { next: "1", reason: "plan_interview" };
      if (signal === "escalate") return { next: "aborted", reason: "plan_abort" };
      break;

    case "2": // setup — worktree/branch via git helper
      if (signal === "helper-ok" || signal === "advance") return { next: "3", reason: "worktree_ready" };
      if (signal === "helper-fail") return { next: "aborted", reason: "setup_failed" };
      break;

    case "3": // implement (maker) + inner gate
      if (signal === "advance") return { next: cfg.reviewSteps[0] ?? "5", reason: "implemented" };
      if (signal === "retry")
        return attempt < cfg.maxImplementRetries
          ? { next: "3", reason: `implement_retry_${attempt}` }
          : { next: "aborted", reason: "implement_exhausted" };
      if (signal === "escalate") return { next: "aborted", reason: "implement_escalated" };
      break;

    case "4a":
    case "4b":
    case "4c":
      if (signal === "advance") return { next: nextReviewOrGate(step, cfg), reason: `${step}_pass` };
      if (signal === "loopback") return { next: "3", reason: `${step}_findings` };
      break;

    case "5": // gate + push
      if (signal === "gate-ok" || signal === "advance") return { next: "5-await", reason: "gate_passed" };
      if (signal === "gate-fail") return { next: "3", reason: "gate_red" };
      break;

    case "5-await": // CI wait
      if (signal === "advance") return { next: "6a", reason: "ci_green" };
      if (signal === "needs_input") return { next: "5-await", reason: "ci_timeout_checkpoint" };
      break;

    case "6a": // triage
      if (signal === "converged") return { next: "7", reason: "converged_clean" };
      if (signal === "advance") return { next: "6b", reason: "address_verdicts" };
      if (signal === "needs_input") return { next: "6a", reason: "defer_to_human" };
      break;

    case "6b": // apply
      if (signal === "advance") return { next: "5", reason: "applied_next_round" };
      if (signal === "retry")
        return attempt < cfg.maxImplementRetries
          ? { next: "6b", reason: `apply_retry_${attempt}` }
          : { next: "aborted", reason: "apply_exhausted" };
      break;
  }

  throw new FsmError(`fsm: no transition for step=${step} signal=${signal}`);
}
