// `POST /api/runs` inserts a pending row and returns; the supervisor claims rows, spawns a child per
// run, and writes the terminal status when it exits. The child never sees this table.

import type { DatabaseSync } from "node:sqlite";
import { mintRunId } from "../run-id.js";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "../run-index.js";

export const QUEUE_STATUSES = [
  "pending",
  "running",
  // Live but not claimable: the child exited at a gate on purpose, and the human's answer re-admits
  // it. Distinct from `pending` because "waiting on a human" and "waiting on capacity" render
  // differently and `queue_position` is meaningless for the first.
  "awaiting_gate",
  "done",
  "failed",
  "cancelled",
] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** What "occupies" a branch for admission control. A suspended run counts: its run dir and journal
 *  are mid-flight, and a second run on that branch IS that run. */
export const LIVE_STATUSES: readonly QueueStatus[] = ["pending", "running", "awaiting_gate"];

export interface QueueRow {
  id: number;
  runId: string;
  status: QueueStatus;
  requestedBy: string;
  repo: string;
  branch: string;
  task: string;
  ticket: string;
  summary: string;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  error: string | null;
}

export interface QueueFilter {
  status?: QueueStatus[];
  requestedBy?: string;
  repo?: string;
  branch?: string;
  limit?: number;
  offset?: number;
}

export interface EnqueueRequest {
  requestedBy: string;
  repo: string;
  branch: string;
  task: string;
  ticket: string;
  summary: string;
}

interface Row {
  id: number;
  run_id: string;
  status: string;
  requested_by: string;
  repo: string;
  branch: string;
  task: string;
  ticket: string;
  summary: string;
  enqueued_at: string;
  started_at: string | null;
  finished_at: string | null;
  attempts: number;
  error: string | null;
}

/** Shares `/runs`' defaults, and clamps in one place so the `limit` a client asked for and the one
 *  the response reports cannot disagree. */
export function resolveQueuePaging(f: QueueFilter = {}): { limit: number; offset: number } {
  const raw = Math.trunc(f.limit ?? DEFAULT_LIST_LIMIT);
  return {
    limit: Number.isFinite(raw) ? Math.min(Math.max(raw, 1), MAX_LIST_LIMIT) : DEFAULT_LIST_LIMIT,
    offset: Math.max(0, Math.trunc(f.offset ?? 0)),
  };
}

const toRow = (r: Row): QueueRow => ({
  id: r.id,
  runId: r.run_id,
  status: r.status as QueueStatus,
  requestedBy: r.requested_by,
  repo: r.repo,
  branch: r.branch,
  task: r.task,
  ticket: r.ticket,
  summary: r.summary,
  enqueuedAt: r.enqueued_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  attempts: r.attempts,
  error: r.error,
});

export class QueueStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Mints the run id here so `POST /api/runs` can answer with it synchronously; the child receives
   *  it as `CARE_RUN_ID`. */
  enqueue(req: EnqueueRequest, now: Date = new Date()): QueueRow {
    const runId = mintRunId(now.getTime());
    this.db
      .prepare(
        `INSERT INTO queue (run_id, status, requested_by, repo, branch, task, ticket, summary, enqueued_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, req.requestedBy, req.repo, req.branch, req.task, req.ticket, req.summary, now.toISOString());
    return this.byRunId(runId)!;
  }

  byRunId(runId: string): QueueRow | null {
    const r = this.db
      .prepare("SELECT * FROM queue WHERE run_id = ?")
      .get(runId) as unknown as Row | undefined;
    return r ? toRow(r) : null;
  }

  byId(id: number): QueueRow | null {
    const r = this.db.prepare("SELECT * FROM queue WHERE id = ?").get(id) as unknown as Row | undefined;
    return r ? toRow(r) : null;
  }

  /** Shared by `list` and `count`, so a page and its `total` cannot come from two predicates — the
   *  paginated-list bug that only shows up on page two. */
  private whereFor(f: QueueFilter): { sql: string; params: (string | number)[] } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (f.status?.length) {
      clauses.push(`status IN (${f.status.map(() => "?").join(", ")})`);
      params.push(...f.status);
    }
    if (f.requestedBy !== undefined) {
      clauses.push("requested_by = ?");
      params.push(f.requestedBy);
    }
    if (f.repo !== undefined) {
      clauses.push("repo = ?");
      params.push(f.repo);
    }
    if (f.branch !== undefined) {
      clauses.push("branch = ?");
      params.push(f.branch);
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  }

  list(filter: QueueFilter = {}): QueueRow[] {
    const { sql, params } = this.whereFor(filter);
    const { limit, offset } = resolveQueuePaging(filter);
    const rows = this.db
      .prepare(`SELECT * FROM queue${sql} ORDER BY enqueued_at ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as Row[];
    return rows.map(toRow);
  }

  count(filter: QueueFilter = {}): number {
    const { sql, params } = this.whereFor(filter);
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM queue${sql}`).get(...params) as unknown as {
      n: number;
    };
    return r.n;
  }

  /** Rows per status, in one query. `/stats` used to count a *page* of rows, so the moment the queue
   *  outgrew one page the dashboard's totals quietly stopped being totals. */
  statusCounts(): Record<QueueStatus, number> {
    const out = Object.fromEntries(QUEUE_STATUSES.map((s) => [s, 0])) as Record<QueueStatus, number>;
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM queue GROUP BY status")
      .all() as unknown as { status: string; n: number }[];
    for (const r of rows) if (r.status in out) out[r.status as QueueStatus] = r.n;
    return out;
  }

  /**
   * Counting pending rows only makes this a countdown to zero: as rows are claimed they leave the
   * count, so a caller polling their own row watches it fall. Zero means nothing is queued ahead —
   * the run may still be blocked on its branch, which is a separate field.
   */
  position(runId: string): number | null {
    const me = this.byRunId(runId);
    if (!me) return null;
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM queue
          WHERE status = 'pending'
            AND (enqueued_at < ? OR (enqueued_at = ? AND id < ?))`,
      )
      .get(me.enqueuedAt, me.enqueuedAt, me.id) as unknown as { n: number };
    return r.n;
  }

  /** Admission control belongs to the service, not the loop: the per-run lockfile already guarantees
   *  one writer, and whether a second request queues or is rejected is scheduling policy. */
  liveOn(repo: string, branch: string): QueueRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM queue WHERE repo = ? AND branch = ? AND status IN ('pending','running','awaiting_gate')
         ORDER BY enqueued_at ASC LIMIT 1`,
      )
      .get(repo, branch) as unknown as Row | undefined;
    return r ? toRow(r) : null;
  }

  /**
   * Claims the oldest pending row the supervisor may start, or null.
   *
   * `BEGIN IMMEDIATE` takes the write lock up front, so two supervisors cannot both read the same
   * pending row and both spawn it; the conditional UPDATE is the belt to that braces.
   *
   * A row whose (repo, branch) already has a live row is SKIPPED, not failed — it becomes claimable
   * when the first finishes. Skipping is necessary because the run dir and worktree both derive from
   * `${repo}-${branch}`, so a second run on a branch is not a competing run, it IS the first one.
   *
   * `startable` is how the filesystem gets a vote, covering runs the queue did not start (a terminal
   * launched one holds the very same lockfile). It runs INSIDE the transaction: it only reads the
   * filesystem, so it cannot deadlock, and holding the write lock across it makes "checked the lock,
   * then claimed" one decision rather than a race with the next tick.
   *
   * Candidates are the oldest pending row PER (repo, branch), not the oldest overall — otherwise a
   * branch with fifty queued rows and a live lock fills the scan window and starves every other.
   */
  claim(
    opts: { now?: Date; startable?: (row: QueueRow) => boolean; scan?: number } = {},
  ): QueueRow | null {
    const now = opts.now ?? new Date();
    const scan = opts.scan ?? 25;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.db
        .prepare(
          `SELECT q.* FROM queue q
            WHERE q.status = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM queue r
                 WHERE r.repo = q.repo AND r.branch = q.branch
                   AND r.status IN ('running', 'awaiting_gate')
              )
              AND q.id = (
                SELECT MIN(p.id) FROM queue p
                 WHERE p.repo = q.repo AND p.branch = q.branch
                   AND p.status = 'pending'
              )
            ORDER BY q.enqueued_at ASC, q.id ASC
            LIMIT ?`,
        )
        .all(scan) as unknown as Row[];

      const candidate = candidates.find((r) => !opts.startable || opts.startable(toRow(r)));
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      const { changes } = this.db
        .prepare(
          `UPDATE queue SET status = 'running', started_at = ?, attempts = attempts + 1
            WHERE id = ? AND status = 'pending'`,
        )
        .run(now.toISOString(), candidate.id);
      if (changes !== 1) {
        this.db.exec("ROLLBACK");
        return null;
      }
      this.db.exec("COMMIT");
      return this.byId(candidate.id);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** For a row claimed but never spawned, when the supervisor died in the gap. `attempts` is not
   *  decremented: it counts claims, and a row that keeps being orphaned should stay visible. */
  release(id: number): boolean {
    const { changes } = this.db
      .prepare("UPDATE queue SET status = 'pending', started_at = NULL WHERE id = ? AND status = 'running'")
      .run(id);
    return changes === 1;
  }

  /** Record a terminal outcome for a claimed row. */
  finish(id: number, status: "done" | "failed", error: string | null = null, now: Date = new Date()): void {
    this.db
      .prepare("UPDATE queue SET status = ?, finished_at = ?, error = ? WHERE id = ?")
      .run(status, now.toISOString(), error, id);
  }

  /** Parks a claimed row on a human: still live, still owning its run dir and blocking its branch,
   *  but unclaimable until `GateStore.answerAndReadmit` re-admits it alongside the answer. */
  suspend(id: number): boolean {
    const { changes } = this.db
      .prepare("UPDATE queue SET status = 'awaiting_gate' WHERE id = ? AND status = 'running'")
      .run(id);
    return changes === 1;
  }

  /** False when the row is already terminal: a finished run cannot be un-run, and saying so is more
   *  useful than silently succeeding. */
  cancel(runId: string, now: Date = new Date()): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE queue SET status = 'cancelled', finished_at = ?
          WHERE run_id = ? AND status IN ('pending','running','awaiting_gate')`,
      )
      .run(now.toISOString(), runId);
    return changes === 1;
  }

  /** Rows left `running` by a supervisor that died — each a claim on a process that no longer
   *  exists. The supervisor reconciles these against the lockfiles at boot. */
  orphaned(): QueueRow[] {
    return this.list({ status: ["running"] });
  }
}
