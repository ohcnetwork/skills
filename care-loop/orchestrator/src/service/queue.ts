// service/queue.ts — the request queue ([[PLAN-loop-service]] §4).
//
// The service is always on. `POST /api/runs` inserts a pending row and returns; the supervisor claims
// rows, spawns a `care-loopd` child per run, and writes the terminal status when it exits. The child
// never sees this table — it gets a run dir and flags, exactly as a human would from the CLI.

import type { DatabaseSync } from "node:sqlite";
import { mintRunId } from "../run-id.js";

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

  list(filter: { status?: QueueStatus[]; requestedBy?: string; limit?: number } = {}): QueueRow[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status?.length) {
      clauses.push(`status IN (${filter.status.map(() => "?").join(", ")})`);
      params.push(...filter.status);
    }
    if (filter.requestedBy !== undefined) {
      clauses.push("requested_by = ?");
      params.push(filter.requestedBy);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM queue${where} ORDER BY enqueued_at ASC LIMIT ?`)
      .all(...params, Math.min(Math.max(filter.limit ?? 200, 1), 500)) as unknown as Row[];
    return rows.map(toRow);
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
   */
  claim(now: Date = new Date()): QueueRow | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidate = this.db
        .prepare(
          `SELECT q.* FROM queue q
            WHERE q.status = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM queue r
                 WHERE r.repo = q.repo AND r.branch = q.branch
                   AND r.status = 'running'
              )
            ORDER BY q.enqueued_at ASC, q.id ASC
            LIMIT 1`,
        )
        .get() as unknown as Row | undefined;
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
