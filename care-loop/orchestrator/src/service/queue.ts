// service/queue.ts — the request queue ([[PLAN-loop-service]] §4).
//
// The service is always on. `POST /api/runs` inserts a pending row and returns; the supervisor claims
// rows, spawns a `care-loopd` child per run, and writes the terminal status when it exits. The child
// never sees this table — it gets a run dir and flags, exactly as a human would from the CLI.

import type { DatabaseSync } from "node:sqlite";
import { mintRunId } from "../run-id.js";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from "../run-index.js";

export const QUEUE_STATUSES = ["pending", "running", "done", "failed", "cancelled"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/** Statuses a run can still move from — what "occupies" a branch for admission control. */
export const LIVE_STATUSES: readonly QueueStatus[] = ["pending", "running"];

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
  /** Same defaults as every other list route (50 / max 200). The queue used to carry its own 200/500,
   *  which is exactly the drift §6's envelope convention exists to prevent. */
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

/** Queue paging on the SAME defaults as `/runs` (50, max 200). One clamp, so a `limit` the client
 *  asked for and the `limit` the response reports can never disagree. */
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

  /** Insert a pending row, minting the run id here so `POST /api/runs` can answer with it
   *  synchronously (§4). The child receives it as `CARE_RUN_ID`. */
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

  /** The shared WHERE for `list`/`count`, so a page and its `total` can never come from two different
   *  predicates — the paginated-list bug that only shows up on page two. */
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
   * How many pending rows sit ahead of this one — the answer to "why has my run not started?" in the
   * common case, which is the concurrency cap and not the branch.
   *
   * Counting *pending* rows only (not `running`) makes this a countdown to zero: as rows are claimed
   * they leave the count, so a caller polling their own row watches it fall. Position 0 means nothing
   * is queued ahead — it may still be blocked on its branch, which is a separate field.
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

  /** Is this repo+branch already spoken for? Admission control lives in the SERVICE, not the loop
   *  ([[PLAN-loop-service]] §12): the loop's per-run lockfile already guarantees one writer, and
   *  whether a second request queues or is rejected is scheduling policy, which belongs to whatever
   *  owns the queue. */
  liveOn(repo: string, branch: string): QueueRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM queue WHERE repo = ? AND branch = ? AND status IN ('pending','running')
         ORDER BY enqueued_at ASC LIMIT 1`,
      )
      .get(repo, branch) as unknown as Row | undefined;
    return r ? toRow(r) : null;
  }

  /**
   * Claim the oldest pending row the supervisor may start, or null.
   *
   * `BEGIN IMMEDIATE` takes the write lock up front, so two supervisors (or a supervisor and a
   * restart of itself) cannot both read the same pending row and both spawn it. The conditional
   * UPDATE plus a `changes() === 1` check is the belt to that braces: even if the row were read
   * twice, only one transaction can move it out of `pending`.
   *
   * **Queue-behind, not reject.** A pending row whose (repo, branch) already has a RUNNING row is
   * skipped rather than failed — it becomes claimable the moment the first finishes. Rejecting at
   * enqueue would push the retry back onto the requester for the exact situation a queue exists to
   * absorb. The reason it must be skipped at all: `derivePaths` derives the run dir AND the worktree
   * from `${repo}-${branch}`, so a second run on the same branch is not a competing run, it IS the
   * first one — same dir, same journal, same lockfile.
   *
   * **`startable` is how the filesystem gets a vote.** The queue table knows about runs the queue
   * started; it knows nothing about a run someone launched from a terminal, which holds the very same
   * lockfile. Without this the service claims the row, spawns, and the child dies in `withLock` —
   * after worktree setup, minutes in, reported as a spawn failure. The supervisor passes a predicate
   * backed by `inspectLock`, so a live CLI run defers the claim instead of poisoning it.
   *
   * The candidate query returns the oldest pending row **per (repo, branch)**, not the oldest rows
   * overall: a branch with fifty queued rows and a live lock would otherwise fill the whole scan
   * window and starve every other branch behind it.
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
                   AND r.status = 'running'
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

      // The predicate runs INSIDE the transaction. It only reads the filesystem, so it cannot
      // deadlock on the db, and holding the write lock across it is what makes "checked the lock,
      // then claimed" a single decision rather than a race with the next supervisor tick.
      const candidate = candidates.find((r) => !opts.startable || opts.startable(toRow(r)));
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      // `.run()` already reports what it changed; a follow-up `SELECT changes()` was reading a global
      // that happens to still hold this statement's count, which is one refactor away from reading
      // someone else's — on the hot claim path, for an extra round trip.
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

  /** Hand a claimed row back to `pending` — the §4 reconciliation action for a row that was claimed
   *  but never spawned (supervisor died in the gap). `attempts` is deliberately NOT decremented: it
   *  counts claims, and a row that keeps being claimed and orphaned is exactly what an operator wants
   *  to see rather than have quietly reset. */
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

  /** Cancel a row. Returns false when it is already terminal — a finished run cannot be un-run, and
   *  saying so is more useful than silently succeeding. */
  cancel(runId: string, now: Date = new Date()): boolean {
    const { changes } = this.db
      .prepare(
        `UPDATE queue SET status = 'cancelled', finished_at = ?
          WHERE run_id = ? AND status IN ('pending','running')`,
      )
      .run(now.toISOString(), runId);
    return changes === 1;
  }

  /** Rows left `running` by a supervisor that died. A `running` row is a claim on a process, and
   *  after a crash that process no longer exists — the row is a lie until something reconciles it
   *  (§4). The supervisor calls this at boot; step 4 decides between resume and fail. */
  orphaned(): QueueRow[] {
    return this.list({ status: ["running"] });
  }
}
