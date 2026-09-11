// The `PlanGate` the service spawns its children with. HTTP is how the human answers, not how the
// child listens: the child polls SQLite directly, which it already opens to write every run event, so
// this needs no HTTP client, service URL, or credentials. Neither side holds state the other needs,
// so a gate survives the service being restarted or crashed.
//
// A gate is a SUSPEND POINT, not a blocking wait. A run parked on a human has already done every
// expensive thing it will do before approval, and holds a slot for nothing — so the child waits
// briefly, exits, and resumes when the answer arrives.

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
  /** Short: tuned to "a human is probably looking at it right now", not "someone will get to it". */
  waitMs?: number;
  /** A local read against a WAL database, so it can be far tighter than the loop's GitHub polls. */
  pollMs?: number;
  /** How long the ask stays answerable once posted. Long, because a suspended run costs nothing. */
  ttlMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onAsk?: (askId: string, kind: GateKind, payload: unknown) => void;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Derived from the ask's CONTENT, so it is per attempt rather than a bare `approve` — with a shared
 * id an amend re-asks, finds the previous row already answered "amend", and the planner amends
 * forever at one model call per lap.
 *
 * Hashed rather than counted because a counter lives in memory, and a re-spawned child restarts it
 * at 1 — colliding a different second draft with the first draft's answer. A hash gets both cases
 * at once: identical content re-asks idempotently, different content asks afresh.
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
  // Guards the one case a content hash cannot: an amendment whose re-draft returns byte-identical
  // hashes to the ask just answered "amend" and would replay it into the unbounded loop above.
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
      // Unreachable — the row was just written — but silently treating it as pending would spin
      // against a row someone deleted.
      if (state.state === "missing") throw new GateExpiredError(askId);
      if (now().getTime() >= deadline) throw new GateSuspendedError(askId);
      await sleep(pollMs);
    }
  };

  return {
    async interview(questions: PlanQuestion[]): Promise<PlanAnswer[]> {
      if (questions.length === 0) return [];
      // One row for the whole batch: the frontend renders one form and the child wants one
      // round-trip, so a row per question would be three representations of one interaction.
      return (await resolve("interview", questions)) as PlanAnswer[];
    },
    async approve(ask: ConsolidatedAsk): Promise<ApprovalDecision> {
      return (await resolve("approve", ask)) as ApprovalDecision;
    },
  };
}
