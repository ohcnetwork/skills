// service-gate.ts — the `PlanGate` the loop-service spawns its children with ([[PLAN-loop-service]] §7).
//
// The plan called this `HttpPlanGate`. HTTP is how the HUMAN answers; it is not how the child listens.
// The child polls SQLite directly — it already opens the database to write every run event, so this
// needs no HTTP client, no service URL, and no credentials in the child. The property that buys is
// worth the naming pedantry: **a gate survives the service being restarted, redeployed, or crashed**,
// because neither side holds state the other needs. Both talk only to `gate_asks`.
//
// The other half of the design is that a gate is a SUSPEND POINT, not a blocking wait. A run parked
// on a human has already done every expensive thing it will do before approval — recon, interview,
// draft, all written to disk — and holds a concurrency slot for nothing. So the child waits briefly,
// then exits, and the run resumes when the answer arrives.

import { createHash } from "node:crypto";
import {
  GateCancelledError,
  GateExpiredError,
  GateSuspendedError,
  type ApprovalDecision,
  type ConsolidatedAsk,
  type PlanAnswer,
  type PlanGate,
  type PlanQuestion,
} from "./plan-gate.js";

export { GateCancelledError, GateExpiredError, GateSuspendedError };
import type { GateKind, GateStore } from "./service/gate-store.js";

export interface ServicePlanGateOptions {
  runId: string;
  store: GateStore;
  /** How long to stay alive polling before suspending. Short, because this is the expensive wait —
   *  it is tuned to "a human is probably looking at it right now", not to "someone will get to it". */
  waitMs?: number;
  /** Poll interval. A local read against a WAL database, so this is cheap; the 60s `pollPr` waits
   *  between rounds is the cost of a GitHub API call and has no bearing here. */
  pollMs?: number;
  /** How long the ask stays answerable once posted. Long, because a suspended run costs nothing. */
  ttlMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onAsk?: (askId: string, kind: GateKind, payload: unknown) => void;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The ask id, derived from the CONTENT of the ask.
 *
 * It must be per attempt, never a bare `approve`: with a shared id, `amend` re-drafts, re-asks, finds
 * the previous row already answered `amend`, and the planner amends forever against an answer nobody
 * re-gave — through a `for (;;)` whose own comment says amend re-drafts unbounded, at one real
 * planner call per lap.
 *
 * Content-derived rather than counted, because a counter lives in memory and a re-spawned child
 * restarts it at 1 — which would make a *different* second draft collide with the first draft's
 * answer. A hash gets both cases right at once: identical content re-asks idempotently (what a
 * crash-only loop needs), different content asks afresh (what amend needs).
 */
export function askIdFor(kind: GateKind, payload: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  return `${kind}:${digest}`;
}

export function servicePlanGate(o: ServicePlanGateOptions): PlanGate {
  const now = o.now ?? (() => new Date());
  const sleep = o.sleep ?? sleepReal;
  const waitMs = o.waitMs ?? 10 * 60_000;
  const pollMs = o.pollMs ?? 2_000;
  // Ask ids this process has already taken an answer from. Guards the one case a content hash cannot:
  // an amendment whose re-draft comes back byte-identical would hash to the ask just answered `amend`,
  // and replay it. Rare, but the failure is the unbounded loop above, so it is worth two lines.
  const consumed = new Set<string>();

  const resolve = async (kind: GateKind, payload: unknown): Promise<unknown> => {
    let askId = askIdFor(kind, payload);
    for (let n = 2; consumed.has(askId); n++) askId = `${askIdFor(kind, payload)}#${n}`;

    const ask = o.store.ask({ runId: o.runId, askId, kind, payload }, { now: now(), ttlMs: o.ttlMs });
    o.onAsk?.(askId, kind, ask.payload);

    const deadline = now().getTime() + waitMs;
    for (;;) {
      const state = o.store.poll(o.runId, askId, now());
      if (state.state === "answered") {
        consumed.add(askId);
        return state.answer;
      }
      if (state.state === "cancelled") throw new GateCancelledError(askId);
      if (state.state === "expired") throw new GateExpiredError(askId);
      // `missing` cannot happen — we just wrote the row — but treating it as pending would spin
      // silently against a row someone deleted, so it is loud instead.
      if (state.state === "missing") throw new GateExpiredError(askId);
      if (now().getTime() >= deadline) throw new GateSuspendedError(askId);
      await sleep(pollMs);
    }
  };

  return {
    async interview(questions: PlanQuestion[]): Promise<PlanAnswer[]> {
      if (questions.length === 0) return [];
      // ONE row for the whole batch, not one per question: the frontend renders one form and the
      // child wants one round-trip, so a row per question would be three representations of one
      // interaction.
      return (await resolve("interview", questions)) as PlanAnswer[];
    },
    async approve(ask: ConsolidatedAsk): Promise<ApprovalDecision> {
      return (await resolve("approve", ask)) as ApprovalDecision;
    },
  };
}
