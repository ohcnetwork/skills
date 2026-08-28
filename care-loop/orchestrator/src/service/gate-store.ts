// The plan gate as rows. The child writes asks and reads answers; the service writes answers and
// reads asks. Neither side holds state the other needs, which is what lets a gate survive both the
// service restarting and the child exiting.

import type { DatabaseSync } from "node:sqlite";

/** Generous because a suspended run costs nothing to keep — no process, no slot. It bounds
 *  abandonment, not attention. */
export const DEFAULT_ASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type GateKind = "interview" | "approve";

export interface GateAsk {
  runId: string;
  askId: string;
  kind: GateKind;
  payload: unknown;
  answer: unknown | null;
  answeredBy: string | null;
  askedAt: string;
  answeredAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
}

/** What a poll found. The child branches on exactly these. */
export type GateState =
  | { state: "pending"; ask: GateAsk }
  | { state: "answered"; ask: GateAsk; answer: unknown }
  | { state: "cancelled"; ask: GateAsk }
  | { state: "expired"; ask: GateAsk }
  | { state: "missing" };

interface Row {
  run_id: string;
  ask_id: string;
  kind: string;
  payload: string;
  answer: string | null;
  answered_by: string | null;
  asked_at: string;
  answered_at: string | null;
  cancelled_at: string | null;
  expires_at: string;
}

const toAsk = (r: Row): GateAsk => ({
  runId: r.run_id,
  askId: r.ask_id,
  kind: r.kind as GateKind,
  payload: JSON.parse(r.payload) as unknown,
  answer: r.answer === null ? null : (JSON.parse(r.answer) as unknown),
  answeredBy: r.answered_by,
  askedAt: r.asked_at,
  answeredAt: r.answered_at,
  cancelledAt: r.cancelled_at,
  expiresAt: r.expires_at,
});

/** `payload` and `answer` are jsonb BLOBs, read back through `json()` so callers see text. */
const SELECT = `SELECT run_id, ask_id, kind, json(payload) AS payload, json(answer) AS answer,
                       answered_by, asked_at, answered_at, cancelled_at, expires_at
                  FROM gate_asks`;

export class GateStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Posts an ask, or returns the one already posted under this id.
   *
   * Idempotent rather than `INSERT OR REPLACE` because a crash-only loop re-asks: a re-spawned child
   * posts the same id and must find its own row, including an answer given in the meantime.
   *
   * `askId` must be per ATTEMPT (`approve:2`, `approve:3`, …). With a bare `approve`, an amend
   * re-drafts, re-asks, finds the previous row already answered "amend", and the planner amends
   * forever against an answer nobody re-gave — one real planner call per lap.
   */
  ask(
    a: { runId: string; askId: string; kind: GateKind; payload: unknown },
    opts: { now?: Date; ttlMs?: number } = {},
  ): GateAsk {
    const existing = this.get(a.runId, a.askId);
    if (existing) return existing;
    const now = opts.now ?? new Date();
    const expires = new Date(now.getTime() + (opts.ttlMs ?? DEFAULT_ASK_TTL_MS));
    this.db
      .prepare(
        `INSERT INTO gate_asks (run_id, ask_id, kind, payload, asked_at, expires_at)
         VALUES (?, ?, ?, jsonb(?), ?, ?)`,
      )
      .run(a.runId, a.askId, a.kind, JSON.stringify(a.payload), now.toISOString(), expires.toISOString());
    return this.get(a.runId, a.askId)!;
  }

  get(runId: string, askId: string): GateAsk | null {
    const r = this.db
      .prepare(`${SELECT} WHERE run_id = ? AND ask_id = ?`)
      .get(runId, askId) as unknown as Row | undefined;
    return r ? toAsk(r) : null;
  }

  /** A run has at most one, because the child posts an ask and then blocks on it. */
  pending(runId: string, now: Date = new Date()): GateAsk | null {
    const r = this.db
      .prepare(
        `${SELECT} WHERE run_id = ? AND answer IS NULL AND cancelled_at IS NULL AND expires_at > ?
          ORDER BY asked_at DESC LIMIT 1`,
      )
      .get(runId, now.toISOString()) as unknown as Row | undefined;
    return r ? toAsk(r) : null;
  }

  /** A resume needs the interview it already conducted, whose id is not the one the journal
   *  recorded — that is the ask it suspended ON. */
  latestOfKind(runId: string, kind: GateKind): GateAsk | null {
    const r = this.db
      .prepare(`${SELECT} WHERE run_id = ? AND kind = ? ORDER BY asked_at DESC, ask_id DESC LIMIT 1`)
      .get(runId, kind) as unknown as Row | undefined;
    return r ? toAsk(r) : null;
  }

  /** The "needs you" list, which is the whole reason a gate gets answered before it expires. */
  pendingRuns(now: Date = new Date()): GateAsk[] {
    const rows = this.db
      .prepare(
        `${SELECT} WHERE answer IS NULL AND cancelled_at IS NULL AND expires_at > ?
          ORDER BY asked_at ASC`,
      )
      .all(now.toISOString()) as unknown as Row[];
    return rows.map(toAsk);
  }

  /** False when the ask is no longer answerable, so a caller who lost that race learns it rather
   *  than believing they unblocked a run. */
  answer(
    runId: string,
    askId: string,
    answer: unknown,
    answeredBy: string,
    now: Date = new Date(),
  ): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE gate_asks SET answer = jsonb(?), answered_by = ?, answered_at = ?
          WHERE run_id = ? AND ask_id = ?
            AND answer IS NULL AND cancelled_at IS NULL AND expires_at > ?`,
      )
      .run(JSON.stringify(answer), answeredBy, now.toISOString(), runId, askId, now.toISOString());
    return changes === 1;
  }

  /**
   * Two tables, one event: the answer is precisely what turns a suspended run back into claimable
   * work. Split, they leave a window where the ask is answered and the run is still `awaiting_gate`
   * — nothing would ever pick it up.
   *
   * The queue update is conditional, so answering for a run that is still live touches nothing;
   * that child sees the answer on its next poll and carries on.
   */
  answerAndReadmit(
    runId: string,
    askId: string,
    answer: unknown,
    answeredBy: string,
    now: Date = new Date(),
  ): { answered: boolean; readmitted: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const answered = this.answer(runId, askId, answer, answeredBy, now);
      if (!answered) {
        this.db.exec("ROLLBACK");
        return { answered: false, readmitted: false };
      }
      const { changes } = this.db
        .prepare("UPDATE queue SET status = 'pending' WHERE run_id = ? AND status = 'awaiting_gate'")
        .run(runId);
      this.db.exec("COMMIT");
      return { answered: true, readmitted: Number(changes) === 1 };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Cancellation travelling the channel the child is already blocked on. A signalled child skips its
   * `finally`, leaving its lockfile behind and writing no `run.end`; a revoked ask lets it unwind
   * normally instead. SIGTERM stays the escalation, not the opener.
   */
  cancel(runId: string, now: Date = new Date()): number {
    const { changes } = this.db
      .prepare(
        `UPDATE gate_asks SET cancelled_at = ?
          WHERE run_id = ? AND answer IS NULL AND cancelled_at IS NULL`,
      )
      .run(now.toISOString(), runId);
    return Number(changes);
  }

  /** Called on a short interval: a local read against a WAL database, unlike the GitHub calls
   *  elsewhere in the loop. */
  poll(runId: string, askId: string, now: Date = new Date()): GateState {
    const ask = this.get(runId, askId);
    if (!ask) return { state: "missing" };
    if (ask.answer !== null) return { state: "answered", ask, answer: ask.answer };
    if (ask.cancelledAt !== null) return { state: "cancelled", ask };
    if (Date.parse(ask.expiresAt) <= now.getTime()) return { state: "expired", ask };
    return { state: "pending", ask };
  }
}
