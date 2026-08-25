// plan-gate.ts — the interaction sub-seam of the plan stage (the swappable "how do we talk to the
// human" transport). `runPlan` (plan.ts) depends ONLY on this interface, never on a concrete
// transport, so a terminal readline adapter (gate-terminal.ts) is interchangeable with a future
// Jira-comment / PR-comment adapter that posts the questions and POLLS for replies (like pollPr).
// Both methods are async on purpose: the terminal adapter resolves inline as the human types, while
// a comment adapter resolves only once replies arrive. Nothing here has behavior — it's the contract.

/** One batched interview question. `id` is stable so an async transport can correlate replies. */
export interface PlanQuestion {
  id: string;
  prompt: string;
}

/** The human's answer to a `PlanQuestion`, correlated by `id`. */
export interface PlanAnswer {
  id: string;
  answer: string;
}

/** The single consolidated human gate (SKILL.md): plan + push authorization + test approach, with
 *  the MANDATORY `Planned by:` line surfaced so a wrong-tier plan is caught at the one review moment. */
export interface ConsolidatedAsk {
  plannedBy: string; // the planner's self-identified model — mandatory; not-Opus ⇒ reject
  summary: string; // one-line scope of the change
  criteria: string[]; // testable acceptance criteria
  classification: string; // trivial | standard | complex
  testPlan: string; // recommended spec(s) / test-surface intent
  pushAuthNote: string; // what approval authorizes (push + open/update PR on origin)
}

/** The human's decision at the gate. `amend` carries free-text the planner folds into a re-draft. */
export type ApprovalDecision =
  | { decision: "approve" }
  | { decision: "reject" }
  | { decision: "amend"; amendment: string };

/** The interaction transport. A `PlanFront` (plan-front.ts) pairs one of these with an input source. */
export interface PlanGate {
  /** Relay the batched questions to the human; resolve with their answers (order/count may differ). */
  interview(questions: PlanQuestion[]): Promise<PlanAnswer[]>;
  /** Present the consolidated ask; resolve with approve / amend / reject. */
  approve(ask: ConsolidatedAsk): Promise<ApprovalDecision>;
}

// ── Gate outcomes that are not answers ────────────────────────────────────────────────────────────
//
// Part of the CONTRACT, not of one adapter: any transport may be revoked or may run out of patience,
// and `runPlan` has to unwind the same way whichever one is in use. The readline adapter never raises
// these (a terminal gate's equivalents are ctrl-C and walking away); a polling adapter raises all
// three. Declared here so the loop can catch them without importing a transport.

/** The caller should stop waiting and EXIT, freeing its slot. Not an error: the ask stays open and
 *  the run resumes when someone answers it ([[PLAN-loop-service]] §7). */
export class GateSuspendedError extends Error {
  constructor(readonly askId: string) {
    super(`gate ${askId} is still unanswered — suspending`);
  }
}

/** The ask was revoked — a cancel, delivered through the channel the caller was already blocked on,
 *  so it can unwind through its normal path instead of being signalled mid-await. */
export class GateCancelledError extends Error {
  constructor(readonly askId: string) {
    super(`gate ${askId} was cancelled`);
  }
}

/** Nobody answered within the ask's lifetime. The run is abandoned rather than suspended again. */
export class GateExpiredError extends Error {
  constructor(readonly askId: string) {
    super(`gate ${askId} expired unanswered`);
  }
}

/**
 * A suspended plan stage, restored from wherever the transport persisted it.
 *
 * Assembled by the CALLER (which owns the store) and handed to `runPlan` as plain data, so the loop
 * gains a resume path without gaining a dependency on the service. Everything here was already
 * durable before the run suspended — the plan artifacts are on disk, and these are the two things
 * that only existed in memory.
 */
export interface PlanRestore {
  kind: "interview" | "approve";
  askId: string;
  /** The interview, so a resume never re-asks a human what they already answered. */
  questions: PlanQuestion[];
  answers: PlanAnswer[];
  /** The draft the human was looking at — carries `plannedBy` and `classification`, which are the
   *  only two fields the approval path reads off the in-memory draft. */
  ask?: ConsolidatedAsk;
  /** Their decision, if they have given one. */
  answer?: ApprovalDecision;
}
