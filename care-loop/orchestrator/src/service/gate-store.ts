// service/gate-store.ts — the plan gate as rows ([[PLAN-loop-service]] §7).
//
// The ask and the answer are both committed rows, and the two sides never talk to each other, only to
// this table. That is what lets a gate survive the service restarting AND the child exiting: neither
// holds any state the other needs.
//
// The CHILD writes asks and reads answers (through `SqliteGateTransport`, driven by `HttpPlanGate`).
// The SERVICE writes answers and reads asks (through the `/gate` routes). Both go through this class
// so the two sides cannot drift into two different readings of one row.

import type { DatabaseSync } from "node:sqlite";

/** How long an unanswered ask stays answerable. Generous, because a suspended run costs nothing to
 *  keep — no process, no slot, no worktree (§7). It bounds abandonment, not attention. */
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

/** What a poll of one ask found. The child branches on exactly these four. */
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

/** `payload`/`answer` are BLOB columns written with `jsonb()` and read back with `json()`, matching
 *  `run_artifacts`: the parsed binary form is smaller and lets `json_extract` work without a reparse,
 *  and reading through `json()` means callers see ordinary text. */
const SELECT = `SELECT run_id, ask_id, kind, json(payload) AS payload, json(answer) AS answer,
                       answered_by, asked_at, answered_at, cancelled_at, expires_at
                  FROM gate_asks`;

export class GateStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Post an ask, or return the one already posted under this id.
   *
   * Idempotent by `(run_id, ask_id)` because a crash-only loop re-asks: a child that dies after
   * posting and is re-spawned posts the same id again and must find its own row — INCLUDING an answer
   * the human gave in the meantime — rather than blanking it and asking a second time. That is why
   * this is not an `INSERT OR REPLACE`.
   *
   * The id must be per ATTEMPT (`approve:2`, `approve:3`, …), never a bare `approve`. With a shared
   * id, `amend` re-drafts, re-asks, finds the previous row already answered `amend`, and the planner
   * amends forever against an answer nobody re-gave — through a `for (;;)` whose own comment says
   * amend re-drafts unbounded, at one real planner call per lap.
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

  /** The one open question for a run, if any. `GET /api/runs/:id/gate` and the claim path both ask
   *  this; a run has at most one, because the child posts an ask and then blocks on it. */
  pending(runId: string, now: Date = new Date()): GateAsk | null {
    const r = this.db
      .prepare(
        `${SELECT} WHERE run_id = ? AND answer IS NULL AND cancelled_at IS NULL AND expires_at > ?
          ORDER BY asked_at DESC LIMIT 1`,
      )
      .get(runId, now.toISOString()) as unknown as Row | undefined;
    return r ? toAsk(r) : null;
  }

  /** The most recent ask of a kind for a run. A resume needs the interview it already conducted, and
   *  the ask id for that is not the one the journal recorded (which is the ask it suspended ON). */
  latestOfKind(runId: string, kind: GateKind): GateAsk | null {
    const r = this.db
      .prepare(`${SELECT} WHERE run_id = ? AND kind = ? ORDER BY asked_at DESC, ask_id DESC LIMIT 1`)
      .get(runId, kind) as unknown as Row | undefined;
    return r ? toAsk(r) : null;
  }

  /** Every run with an open question — the FE's "needs you" list, which is the whole reason a gate
   *  gets answered before it expires. */
  pendingRuns(now: Date = new Date()): GateAsk[] {
    const rows = this.db
      .prepare(
        `${SELECT} WHERE answer IS NULL AND cancelled_at IS NULL AND expires_at > ?
          ORDER BY asked_at ASC`,
      )
      .all(now.toISOString()) as unknown as Row[];
    return rows.map(toAsk);
  }

  /** Resolve an ask by answering it. Returns false when it is no longer answerable — already
   *  answered, cancelled, or expired — because a caller who lost that race needs to know rather than
   *  believe they unblocked a run. */
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
   * Answer an ask AND re-admit its run, in one transaction.
   *
   * These are two writes to two tables and one event: the human's answer is precisely what turns a
   * suspended run back into claimable work. Splitting them would leave a window where the ask is
   * answered and the run is still `awaiting_gate` — a run nothing will ever pick up, waiting on a
   * question already settled, which is the exact silent stall the queue exists to prevent.
   *
   * The queue update is conditional on `awaiting_gate`, so answering a gate for a run that is still
   * live (inside its `wait_ms` window, child still polling) touches nothing — that child sees the
   * answer on its next poll and carries straight on.
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
   * Revoke every open ask for a run — cancellation travelling the channel the child is already
   * blocked on (§7).
   *
   * A signalled child skips its `finally`: it leaves its lockfile behind, writes no `run.end`, and
   * the run's last journal event stays a question nobody will answer. Writing it in the row instead
   * lets the child unwind through its normal path. SIGTERM remains the escalation, not the opener.
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

  /** One poll. The child calls this on a short interval — it is a local read against a WAL database,
   *  so the 60s that `pollPr` waits between rounds (a GitHub API call) has no bearing here. */
  poll(runId: string, askId: string, now: Date = new Date()): GateState {
    const ask = this.get(runId, askId);
    if (!ask) return { state: "missing" };
    if (ask.answer !== null) return { state: "answered", ask, answer: ask.answer };
    if (ask.cancelledAt !== null) return { state: "cancelled", ask };
    if (Date.parse(ask.expiresAt) <= now.getTime()) return { state: "expired", ask };
    return { state: "pending", ask };
  }
}
