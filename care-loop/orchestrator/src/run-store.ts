// The database is the source of truth. `journal.jsonl` is written alongside it as the human- and
// doctor-readable log, and `reindex` can rebuild the run tables from it, but no live control-flow
// path depends on it. Backing up the tables no journal covers — queue, sessions, gate_asks — is
// service/backup.ts's job.
//
// The write path hooks two chokepoints through the process-wide active store below: `Journal.append`
// mirrors each event and bumps the rollups incrementally, and `state.ts#projectAndWrite` recomputes
// them in full at every step boundary, healing any drift. Both are fatal — a store failure halts the
// run, because a log with holes rebuilds nothing.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JournalEvent } from "./journal.js";
import type { CareState } from "./state.js";

export interface RunRollups {
  eventCount: number;
  costUsd: number;
  durationMs: number;
}

/** `Journal.append` already holds both figures, so nothing here re-derives them. */
export interface EventIncrement {
  /** ts - previous event ts; 0 for the first event of a run and across a run.resume boundary. */
  deltaMs: number;
  /** `data.cost_usd` on a `skill.result` event, 0 otherwise. */
  costUsd: number;
}

export interface RunStore {
  /** Must run before the `run.start` event row, so the `run_events` FK never dangles. */
  seedRun(slug: string, state: CareState): void;
  /** The reconciling write `projectAndWrite` makes at every step transition, correcting any drift
   *  `appendEvent`'s incremental path accumulated. */
  upsertRun(slug: string, state: CareState, rollups: RunRollups): void;
  /** Mirrors into `run_events` and bumps the rollups on `runs`. */
  appendEvent(runId: string, ev: JournalEvent, incr: EventIncrement): void;
  /** The authoritative read path: `Journal.read()` and everything downstream of it. */
  getEvents(runId: string): JournalEvent[];
  /** How `Journal.append` derives `seq` and `deltaMs`, instead of reading the jsonl tail. (`prev`
   *  still comes from the file — it checksums the bytes on disk, not the ordering.) */
  getLastEvent(runId: string): JournalEvent | null;
  /** Mirrors an artifact body alongside the sidecar file. Fatal on failure, like `appendEvent`: a
   *  silently-missing artifact would be repaired invisibly by the next reindex, masking a real fault.
   *  Idempotent on (run_id, path), so a replayed step overwrites rather than throwing. `content` is
   *  canonical JSON text — malformed JSON throws here, which is why `SkillLogger.artifact`
   *  serializes rather than accepting a string. */
  putArtifact(runId: string, a: ArtifactRow): void;
  close(): void;
}

export interface ArtifactRow {
  /** Run-dir-relative sidecar path, e.g. `skills/care-reviewer-r1.input.json`. Unique within a run. */
  path: string;
  name: string;
  sha256: string;
  /** Canonical JSON text — exactly what the sidecar file holds and what `sha256` was taken over. */
  content: string;
}

/** Bump with every schema change, and add the matching idempotent step to `migrate()`. */
export const SCHEMA_VERSION = 7;

/**
 * These are per-connection and are NOT persisted in the file, so EVERY connection must apply them —
 * including ones that never run the schema. A connection missing `busy_timeout` takes an immediate
 * SQLITE_BUSY the moment a child holds the write lock.
 *
 * `journal_mode = WAL` is absent because it IS persisted. It also masked the bug above: WAL lets
 * readers proceed without the write lock, so nothing contended until the service began writing.
 */
export function applyConnectionPragmas(db: DatabaseSync): void {
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = FULL;  -- the only source Journal.read() and resume trust
  `);
}

const SCHEMA = `
PRAGMA journal_mode = WAL;      -- persisted in the file, unlike applyConnectionPragmas' set

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,
  requested_by TEXT,
  repo         TEXT NOT NULL,
  branch       TEXT NOT NULL,
  tier         TEXT NOT NULL,
  step         TEXT NOT NULL,
  round        INTEGER NOT NULL,
  pr           INTEGER,
  started_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  event_count  INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL    NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_detail (
  run_id            TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  task              TEXT NOT NULL,
  ticket            TEXT,
  summary           TEXT,
  worktree          TEXT NOT NULL,
  head_sha          TEXT,
  last_reviewed_sha TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  run_id   TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  ts       TEXT NOT NULL,
  event    TEXT NOT NULL,
  step     TEXT,
  round    INTEGER,
  data     TEXT,
  cost_cum REAL,
  prev     TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Artifact bodies. The journal event carries only a {path,sha256} ref, but the service reads the
-- database and nothing else, so the content has to be reachable here too. Stored inline because the
-- whole historical fleet is 200 artifacts / 1.1 MB (measured 2026-08-20).
--
-- BLOB, not "JSONB": jsonb is a function and an encoding, not a column type, and declaring it would
-- land on NUMERIC affinity and silently coerce numeric-looking strings.
--
-- Keyed by path, not sha256: two artifacts can share content (an unchanged input across two rounds),
-- and keying by hash would silently collapse them into one row.
CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  path    TEXT NOT NULL,      -- run-dir-relative, e.g. skills/care-reviewer-r1.input.json
  name    TEXT NOT NULL,      -- logical name, as recorded on the journal's artifact ref
  sha256  TEXT NOT NULL,      -- "sha256:<hex>" of the sidecar TEXT; a handle, not a verified digest
  bytes   INTEGER NOT NULL,
  content BLOB NOT NULL,      -- jsonb(); read with json(content)
  PRIMARY KEY (run_id, path)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_sha ON run_artifacts(run_id, sha256);

-- SERVICE-OWNED tables, written by the service where the run tables are written by the child. They
-- have no journal behind them, so reindex must never touch them: a deleted queue row is
-- unrecoverable where a deleted runs row is not.
--
-- login is mutable — a GitHub rename orphans history — which is why the numeric github_id column
-- exists unpopulated. Real auth supplies it, and points runs.requested_by at users.id.
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  login        TEXT NOT NULL UNIQUE,
  github_id    INTEGER,           -- NULL until real auth supplies it
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- A hash of each token, never the token: the cookie is the only copy, so a leaked database cannot
-- be replayed as a live login. revoked_at rather than DELETE keeps "who was signed in when".
CREATE TABLE IF NOT EXISTS sessions (
  token_sha256 TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- The request queue. The service inserts; the supervisor claims, spawns, and writes the terminal
-- status. The child never sees this table.
--
-- run_id is minted at enqueue, because POST /api/runs answers synchronously while the child starts
-- long afterwards — possibly never, if the row is cancelled or the spawn fails. It is NOT a foreign
-- key to runs(run_id): the queue row exists before any run row does, so a FK would reject every
-- insert, and reindex's DELETE FROM runs would cascade away rows nothing can rebuild.
CREATE TABLE IF NOT EXISTS queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  repo         TEXT NOT NULL,
  branch       TEXT NOT NULL,
  task         TEXT NOT NULL,
  ticket       TEXT NOT NULL,
  summary      TEXT NOT NULL,
  enqueued_at  TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

-- The plan gate. Ask and answer are both rows, so a gate survives the service restarting AND the
-- child exiting: the two sides never talk to each other, only to this table.
CREATE TABLE IF NOT EXISTS gate_asks (
  run_id       TEXT NOT NULL,
  ask_id       TEXT NOT NULL,   -- 'interview:<n>' | 'approve:<n>' — per attempt, never a bare kind
  kind         TEXT NOT NULL,   -- interview | approve
  payload      BLOB NOT NULL,   -- jsonb: PlanQuestion[] or ConsolidatedAsk
  answer       BLOB,            -- jsonb: PlanAnswer[] or ApprovalDecision; NULL while pending
  answered_by  TEXT,
  asked_at     TEXT NOT NULL,
  answered_at  TEXT,
  cancelled_at TEXT,            -- the service revoking the ask; the child's poll raises on it
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (run_id, ask_id)
);

-- "Does this run have an open question?" — the claim path, the cancel path, and the needs-you list.
-- Partial, because a pending ask is a tiny minority of rows once the fleet has any history.
CREATE INDEX IF NOT EXISTS idx_gate_pending ON gate_asks(run_id)
  WHERE answer IS NULL AND cancelled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_queue_target ON queue(repo, branch, status);
CREATE INDEX IF NOT EXISTS idx_runs_mine   ON runs(requested_by, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_recent ON runs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON run_events(event, ts DESC);
`;

/** The inverse of what `appendEvent` stores. */
function rowToEvent(row: {
  run_id: string;
  seq: number;
  ts: string;
  event: string;
  step: string | null;
  round: number | null;
  data: string | null;
  cost_cum: number | null;
  prev: string;
}): JournalEvent {
  const ev: JournalEvent = {
    seq: row.seq,
    ts: row.ts,
    run_id: row.run_id,
    event: row.event as JournalEvent["event"],
    prev: row.prev,
  };
  if (row.step !== null) ev.step = row.step;
  if (row.round !== null) ev.round = row.round;
  if (row.data !== null)
    ev.data = JSON.parse(row.data) as Record<string, unknown>;
  if (row.cost_cum !== null) ev.cost_cum = { usd_est: row.cost_cum };
  return ev;
}

/** Sums `data.cost_usd` off `skill.result` events — not `cost_cum`, which does not accumulate
 *  correctly on older journals — and the active duration, ignoring the gap a `run.resume` spans. */
export function rollupsFromEvents(events: JournalEvent[]): RunRollups {
  let costUsd = 0;
  for (const e of events) {
    if (e.event === "skill.result") {
      const c = e.data?.cost_usd as number | undefined;
      if (typeof c === "number") costUsd += c;
    }
  }
  let durationMs = 0;
  for (let i = 1; i < events.length; i++) {
    if (events[i].event === "run.resume") continue;
    durationMs +=
      new Date(events[i].ts).getTime() - new Date(events[i - 1].ts).getTime();
  }
  return { eventCount: events.length, costUsd, durationMs };
}

export class SqliteRunStore implements RunStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    applyConnectionPragmas(this.db);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** `CREATE TABLE IF NOT EXISTS` leaves an existing `runs` untouched, so an older database arrives
   *  here with the wrong columns. Presence is checked directly rather than inferred from
   *  `user_version`, so a half-applied migration self-heals instead of throwing. */
  private migrate(): void {
    const cols = this.db
      .prepare("SELECT name FROM pragma_table_info('runs')")
      .all() as unknown as { name: string }[];
    // v7 — drop `parity_error`. The jsonl log is no longer diffed against the db on every
    // run.end/run.resume (see journal.ts's header), so nothing writes this and nothing reads it.
    // Dropped rather than left in place so a fresh db and an upgraded one have the same shape.
    if (cols.some((c) => c.name === "parity_error")) {
      this.db.exec("ALTER TABLE runs DROP COLUMN parity_error");
    }
    // v7 — drop `run_rounds`. Declared schema-complete for per-round analytics that was never built:
    // no INSERT, no SELECT, and zero rows in every db it ever shipped to. Re-add it with the feature
    // that needs it, when its columns can be chosen against a real query rather than guessed.
    this.db.exec("DROP TABLE IF EXISTS run_rounds");
    // v3 (`run_artifacts`), v4 (`users`/`sessions`), v5 (`queue`) and v6 (`gate_asks`) need no step
    // here: they are NEW tables, so the `CREATE TABLE IF NOT EXISTS` in SCHEMA already created them on
    // this connection.
    // Only altering an EXISTING table needs code.
    // An upgraded db has the table but no rows until the next `reindex` backfills them from the
    // sidecars on disk — which is why artifacts stay rebuildable rather than joining `queue` and
    // `gate_asks` as data a reindex cannot restore.
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private writeRunRow(
    slug: string,
    state: CareState,
    rollups: RunRollups,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO runs (run_id, slug, requested_by, repo, branch, tier, step, round, pr,
                              started_at, updated_at, event_count, cost_usd, duration_ms)
           VALUES (:run_id, :slug, :requested_by, :repo, :branch, :tier, :step, :round, :pr,
                   :started_at, :updated_at, :event_count, :cost_usd, :duration_ms)
           ON CONFLICT(run_id) DO UPDATE SET
             slug=excluded.slug, requested_by=excluded.requested_by, repo=excluded.repo,
             branch=excluded.branch, tier=excluded.tier, step=excluded.step, round=excluded.round,
             pr=excluded.pr, started_at=excluded.started_at, updated_at=excluded.updated_at,
             event_count=excluded.event_count, cost_usd=excluded.cost_usd,
             duration_ms=excluded.duration_ms`,
        )
        .run({
          run_id: state.run_id,
          slug,
          requested_by: state.requested_by,
          repo: state.repo,
          branch: state.branch,
          tier: state.tier,
          step: state.step,
          round: state.round,
          pr: state.pr,
          started_at: state.started_at,
          updated_at: state.updated_at,
          event_count: rollups.eventCount,
          cost_usd: rollups.costUsd,
          duration_ms: rollups.durationMs,
        });
      this.db
        .prepare(
          `INSERT INTO run_detail (run_id, task, ticket, summary, worktree, head_sha, last_reviewed_sha)
           VALUES (:run_id, :task, :ticket, :summary, :worktree, :head_sha, :last_reviewed_sha)
           ON CONFLICT(run_id) DO UPDATE SET
             task=excluded.task, ticket=excluded.ticket, summary=excluded.summary,
             worktree=excluded.worktree, head_sha=excluded.head_sha,
             last_reviewed_sha=excluded.last_reviewed_sha`,
        )
        .run({
          run_id: state.run_id,
          task: state.task,
          ticket: state.ticket,
          summary: state.summary,
          worktree: state.worktree,
          head_sha: state.head_sha,
          last_reviewed_sha: state.last_reviewed_sha,
        });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  seedRun(slug: string, state: CareState): void {
    this.writeRunRow(slug, state, { eventCount: 0, costUsd: 0, durationMs: 0 });
  }

  upsertRun(slug: string, state: CareState, rollups: RunRollups): void {
    this.writeRunRow(slug, state, rollups);
  }

  appendEvent(runId: string, ev: JournalEvent, incr: EventIncrement): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO run_events (run_id, seq, ts, event, step, round, data, cost_cum, prev)
           VALUES (:run_id, :seq, :ts, :event, :step, :round, :data, :cost_cum, :prev)`,
        )
        .run({
          run_id: runId,
          seq: ev.seq,
          ts: ev.ts,
          event: ev.event,
          step: ev.step ?? null,
          round: ev.round ?? null,
          data: ev.data !== undefined ? JSON.stringify(ev.data) : null,
          cost_cum: ev.cost_cum?.usd_est ?? null,
          prev: ev.prev,
        });
      this.db
        .prepare(
          `UPDATE runs SET event_count = event_count + 1,
                          updated_at  = :ts,
                          cost_usd    = cost_usd + :cost_usd,
                          duration_ms = duration_ms + :delta_ms
           WHERE run_id = :run_id`,
        )
        .run({
          run_id: runId,
          ts: ev.ts,
          cost_usd: incr.costUsd,
          delta_ms: incr.deltaMs,
        });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  getEvents(runId: string): JournalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as unknown as Parameters<typeof rowToEvent>[0][];
    return rows.map(rowToEvent);
  }

  putArtifact(runId: string, a: ArtifactRow): void {
    this.db
      .prepare(
        `INSERT INTO run_artifacts (run_id, path, name, sha256, bytes, content)
         VALUES (:run_id, :path, :name, :sha256, :bytes, jsonb(:content))
         ON CONFLICT(run_id, path) DO UPDATE SET
           name = excluded.name, sha256 = excluded.sha256,
           bytes = excluded.bytes, content = excluded.content`,
      )
      .run({
        run_id: runId,
        path: a.path,
        name: a.name,
        sha256: a.sha256,
        bytes: Buffer.byteLength(a.content, "utf8"),
        content: a.content,
      });
  }

  getLastEvent(runId: string): JournalEvent | null {
    const row = this.db
      .prepare(
        "SELECT * FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(runId) as unknown as Parameters<typeof rowToEvent>[0] | undefined;
    return row ? rowToEvent(row) : null;
  }

  /** The first step of `reindex`'s rebuild. Deliberately scoped to the run tables: `queue`,
   *  `gate_asks`, `users`, and `sessions` have no journal behind them, so their rows are
   *  unrecoverable. They survive by not being named here, and their `run_id` columns are not foreign
   *  keys, so the cascade cannot reach them either. */
  clearAll(): void {
    this.db.exec("DELETE FROM runs");
  }

  /** Escape hatch for tooling that needs direct SQL (RunIndex, tests). */
  raw(): DatabaseSync {
    return this.db;
  }
}

/** Test double for tests that deliberately set up no store. There is no production `--no-db` path:
 *  a run that cannot reach the DB can no longer resume or project state. */
export class NullRunStore implements RunStore {
  seedRun(_slug: string, _state: CareState): void {}
  upsertRun(_slug: string, _state: CareState, _rollups: RunRollups): void {}
  appendEvent(_runId: string, _ev: JournalEvent, _incr: EventIncrement): void {}
  getEvents(_runId: string): JournalEvent[] {
    return [];
  }
  getLastEvent(_runId: string): JournalEvent | null {
    return null;
  }
  putArtifact(_runId: string, _a: ArtifactRow): void {}
  close(): void {}
}

let activeStore: RunStore = new NullRunStore();

/** The store `Journal.append` and `projectAndWrite` mirror into. */
export function setActiveRunStore(store: RunStore): void {
  activeStore = store;
}

export function getActiveRunStore(): RunStore {
  return activeStore;
}

/** Throws if the database cannot be opened: it is the source of truth, so this is fatal rather than
 *  a silent fallback. */
export function openRunStore(dbPath: string): RunStore {
  return new SqliteRunStore(dbPath);
}
