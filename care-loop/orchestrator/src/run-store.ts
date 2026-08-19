// run-store.ts — SqliteRunStore: the database IS the source of truth (PLAN-sqlite-run-store.md §2,
// §10 cutover). `journal.jsonl` is written as a continuously-verified replica (see journal.ts's
// `readReplica()` + the run.end parity check in parity.ts) — diffed against the DB, and able to
// rebuild it via `reindex`, but nothing on the live control-flow path (`Journal.read()`, `resume`,
// `projectState`) depends on it anymore.
//
// The write path hooks at exactly two chokepoints — `Journal.append` (per-event mirror + incremental
// rollup bump) and `state.ts#projectAndWrite` (full rollup recompute, self-healing any incremental
// drift at the next step boundary) — through the process-wide active store below, so none of the
// ~120 journal-append call sites or the ~10 `Journal` constructors needed to change.
//
// Both writes are now FATAL (§2): a store failure propagates out of `Journal.append` /
// `projectAndWrite` and halts the run — a replica with holes, or a DB that silently drifted from what
// actually happened, can verify or rebuild nothing. `NullRunStore` survives only as a test double
// (§10 item 5); there is no production `--no-db` path any more.

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

/** Incremental per-event contribution. The caller (`Journal.append`) already has both figures in
 *  hand — `deltaMs` from the DB's last event for this run (§10 item 2: ordering is DB-owned now,
 *  not derived from the jsonl tail), `costUsd` from the event's own data — so nothing here needs to
 *  re-derive them. */
export interface EventIncrement {
  /** ts - previous event ts; 0 for the first event of a run and across a run.resume boundary. */
  deltaMs: number;
  /** `data.cost_usd` on a `skill.result` event, 0 otherwise. */
  costUsd: number;
}

export interface RunStore {
  /** Seed the `runs` + `run_detail` row from a freshly-validated CareState, BEFORE the run.start
   *  event row is inserted — so the `run_events` FK never dangles on the very first event (§4). */
  seedRun(slug: string, state: CareState): void;
  /** Full recompute from the whole event array — the reconciling write `projectAndWrite` makes at
   *  every step transition; corrects any drift the incremental path in `appendEvent` accumulated. */
  upsertRun(slug: string, state: CareState, rollups: RunRollups): void;
  /** Per-event mirror into `run_events` + the incremental rollup bump on `runs`. */
  appendEvent(runId: string, ev: JournalEvent, incr: EventIncrement): void;
  /** All events for a run, ordered by seq — the authoritative read path (§10 item 3): `Journal.read()`
   *  and everything downstream of it (`resume`, `projectState`, the drivers) goes through this. */
  getEvents(runId: string): JournalEvent[];
  /** The last event for a run, or null if none — how `Journal.append` derives `seq`/`prev`/`deltaMs`
   *  now (§10 item 2), instead of reading the jsonl tail. */
  getLastEvent(runId: string): JournalEvent | null;
  /** Record (or clear, with null) a run.end parity divergence on the run's row — §10 item 7. The
   *  run.end check is a DETECTOR, not a guard: by the time it fires both writes have committed, so
   *  it cannot prevent what it finds. It records instead of throwing, and the fleet surfaces it. */
  recordParityError(runId: string, reason: string | null): void;
  close(): void;
}

/** Bump with every schema change, and add the matching idempotent step to `migrate()`. */
const SCHEMA_VERSION = 2;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;      -- §10 item 4: the DB is the only source Journal.read()/resume trust
PRAGMA foreign_keys = ON;

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
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  parity_error TEXT      -- §10 item 7: last run.end parity divergence; NULL = clean
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

-- Real 1:N (schema-complete per PLAN §3); NOT populated yet — per-round analytics is future work.
-- The read path (run-index.ts) never queries it; the journal file stays the per-round detail source.
CREATE TABLE IF NOT EXISTS run_rounds (
  run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  round         INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  triage_total  INTEGER,
  addressed     INTEGER,
  declined      INTEGER,
  apply_outcome TEXT,
  ci_outcome    TEXT,
  pushed_sha    TEXT,
  cost_usd      REAL,
  PRIMARY KEY (run_id, round)
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

CREATE INDEX IF NOT EXISTS idx_runs_mine   ON runs(requested_by, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_recent ON runs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_kind ON run_events(event, ts DESC);
`;

/** Reconstruct a `JournalEvent` from a `run_events` row — the inverse of what `appendEvent` stores. */
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
  if (row.data !== null) ev.data = JSON.parse(row.data) as Record<string, unknown>;
  if (row.cost_cum !== null) ev.cost_cum = { usd_est: row.cost_cum };
  return ev;
}

/** Lift of the fold `dashboard.ts#summarizeRun` used to do at read-time-per-poll — now computed once
 *  at write-time (`projectAndWrite`) and by `reindex`. Sums `data.cost_usd` off `skill.result` events
 *  (NOT `cost_cum`, which does not accumulate correctly on older journals) and the active duration
 *  (gaps between consecutive events, dropping the gap that lands on a `run.resume`). */
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
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Schema migrations, keyed off `PRAGMA user_version` (PLAN §3: the migration hook, no
   *  schema_version table). Written to be idempotent and safe to run against a fresh DB as well as
   *  an existing one: `CREATE TABLE IF NOT EXISTS` in SCHEMA leaves an older `runs` table untouched,
   *  so a v1 database reaches here WITHOUT the columns a v2 SCHEMA declares. Column presence is
   *  checked directly rather than inferred from the version, so a half-applied migration (ALTER ran,
   *  version bump did not) self-heals instead of throwing "duplicate column name". */
  private migrate(): void {
    const cols = this.db
      .prepare("SELECT name FROM pragma_table_info('runs')")
      .all() as unknown as { name: string }[];
    if (!cols.some((c) => c.name === "parity_error")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN parity_error TEXT");
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private writeRunRow(slug: string, state: CareState, rollups: RunRollups): void {
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

  recordParityError(runId: string, reason: string | null): void {
    this.db
      .prepare("UPDATE runs SET parity_error = :reason WHERE run_id = :run_id")
      .run({ reason, run_id: runId });
  }

  getLastEvent(runId: string): JournalEvent | null {
    const row = this.db
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
      .get(runId) as unknown as Parameters<typeof rowToEvent>[0] | undefined;
    return row ? rowToEvent(row) : null;
  }

  /** Wipe every projected row (cascades to run_detail/run_events/run_rounds) — the first step of
   *  `care-loopd reindex`'s rebuild-from-journals guarantee (PLAN-sqlite-run-store.md §8). Not part
   *  of the `RunStore` write-path interface: only reindex tooling needs a full clear. */
  clearAll(): void {
    this.db.exec("DELETE FROM runs");
  }

  /** Read-only escape hatch for tooling that needs direct SQL (RunIndex, tests). Not part of the
   *  `RunStore` write-path interface. */
  raw(): DatabaseSync {
    return this.db;
  }
}

/** The no-db test double: every method is a no-op / returns empty. `--no-db` no longer exists in
 *  production (§10 item 5) — a run that can't reach the DB can no longer resume or project state, so
 *  it would be a broken mode rather than an opt-out. Kept for tests that don't care about DB
 *  persistence and deliberately don't set up a real store. */
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
  recordParityError(_runId: string, _reason: string | null): void {}
  close(): void {}
}

let activeStore: RunStore = new NullRunStore();

/** Set the process-wide store `Journal.append` / `projectAndWrite` mirror into. */
export function setActiveRunStore(store: RunStore): void {
  activeStore = store;
}

export function getActiveRunStore(): RunStore {
  return activeStore;
}

/** Open a `SqliteRunStore` at `dbPath`. Throws if it can't be opened — PLAN §2/§10: the DB is the
 *  source of truth, so an unreachable DB is fatal, not a silent fallback. There is no `--no-db`
 *  production path any more (§10 item 5); tests that want a no-op store construct `NullRunStore`
 *  directly. */
export function openRunStore(dbPath: string): RunStore {
  return new SqliteRunStore(dbPath);
}
