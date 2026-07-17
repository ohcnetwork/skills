// roles.ts — role vocabulary + verdict→signal classification (PLAN-orchestrator-architecture §2/§3).
//
// The FSM must switch ONLY on a role's terminal_state/verdict, never on artifact prose (§3). This
// file is the one place that maps a JobResult's typed verdict to the normalized control Signal the
// pure FSM consumes. Keeping it separate keeps fsm.ts free of any per-role knowledge.

export type Role =
  | "care-planner"
  | "implementer"
  | "care-reviewer"
  | "care-test-grader"
  | "care-ux-validator"
  | "care-triager";

export type TerminalState = "done" | "needs_input" | "blocked" | "failed";

/** Normalized control signal — the ONLY thing the FSM branches on. */
export type Signal =
  | "advance" // step succeeded → move forward
  | "converged" // 6a found zero address items + CI green → the run is done
  | "loopback" // judgment wants a fix → back to implement (step 3)
  | "retry" // maker failed but attempts remain → same step
  | "escalate" // retries exhausted
  | "needs_input" // planner interview → gate/checkpoint
  | "helper-ok"
  | "helper-fail"
  | "gate-ok"
  | "gate-fail"
  | "budget-stop";

/**
 * Single source of truth for the verdict(s) that send a JUDGMENT skill's result back to implement
 * (step 3). Activating/adding a judgment skill declares its blocking verdict HERE and nowhere else —
 * classifyJob reads this table instead of a per-role switch. A role absent from the map (planner,
 * triager) never loops back on a "done" result.
 */
export const LOOPBACK_VERDICTS: Partial<Record<Role, string[]>> = {
  "care-reviewer": ["blocked"],
  "care-test-grader": ["wrong"],
  "care-ux-validator": ["overflow", "blocked"],
};

/**
 * Map a role's JobResult outcome to a Signal. Pure; switches only on terminal_state + verdict.
 * - maker (implementer): failure → retry (the ladder decides escalate); success → advance.
 * - judgment (reviewer/grader/ux): a blocking verdict (LOOPBACK_VERDICTS) → back to implement;
 *   anything else terminal-done (pass, findings-applied) → advance.
 */
export function classifyJob(
  role: Role,
  terminalState: TerminalState,
  verdict: string,
): Signal {
  if (terminalState === "needs_input") return "needs_input";
  if (terminalState === "failed" || terminalState === "blocked") {
    return role === "implementer" ? "retry" : "loopback";
  }
  // terminalState === "done"
  if (role === "implementer") return "advance";
  return LOOPBACK_VERDICTS[role]?.includes(verdict) ? "loopback" : "advance";
}

/** The judgment role that owns each review step. */
export function roleForStep(step: string): Role | null {
  switch (step) {
    case "4a":
      return "care-reviewer";
    case "4b":
      return "care-test-grader";
    case "4c":
      return "care-ux-validator";
    default:
      return null;
  }
}
