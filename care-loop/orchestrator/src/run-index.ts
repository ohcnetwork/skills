// run-index.ts — the fleet READ port ([[PLAN-loop-service]] §6, PLAN-sqlite-run-store §7).
//
// **Reads the database and nothing else.** No method touches a run directory, a `journal.jsonl`, or a
// `state.json`: `run_events` mirrors the journal completely (same seq/ts/event/step/round/data/prev),
// so the filesystem has nothing to add. This is what lets the service run anywhere the db is
// reachable, with no run dirs mounted — and it is why `get` takes a run_id rather than a directory.
//
// An earlier `get` took the directory SLUG and read the journal file. Retired on both counts: slug has
// no unique constraint (a reused branch collides on it deterministically), and reading files put the
// filesystem back under an API with no other reason to know it exists.

import type { DatabaseSync } from "node:sqlite";
import type { JournalEvent } from "./journal.js";

/** One row of the fleet list. `runId` is the key; `slug` is a display label — never key off it. */
export interface RunSummary {
  runId: string;
  slug: string;
  requestedBy: string | null;
  repo: string;
  branch: string;
  tier: string;
  step: string;
  round: number;
  pr: number | null;
  startedAt: string;
  updatedAt: string;
  eventCount: number;
  costUsd: number | null;
  durationMs: number;
  parityError: string | null;
  stale: boolean;
}

/** A single run: the list row plus the fields only its detail page needs. */
export interface RunRecord extends RunSummary {
  task: string;
  ticket: string | null;
  summary: string | null;
  worktree: string;
  headSha: string | null;
  lastReviewedSha: string | null;
}

export interface ListFilter {
  requestedBy?: string;
  repo?: string;
  branch?: string;
  step?: string;
  /** Only runs that have not reached a terminal step (`7`/`merged`/`aborted`). */
  active?: boolean;
  /** Include archived `.stale-` dirs. Defaults to false — they are noise in a fleet view. */
  includeStale?: boolean;
  limit?: number;
  offset?: number;
}

export interface EventFilter {
  /** Cursor: events with `seq` strictly greater than this. `seq` is dense and monotonic per run, so
   *  it is a stabler cursor than an offset — a concurrent append cannot shift what it points at. */
  afterSeq?: number;
  /** Restrict to these event types. Absent/empty means all. */
  events?: string[];
  limit?: number;
}

export interface EventPage {
  items: JournalEvent[];
  /** Cursor for the next page, or null when this page is the last. */
  nextSeq: number | null;
}

export interface RunIndex {
  list(filter?: ListFilter): RunSummary[];
  count(filter?: ListFilter): number;
  get(runId: string): RunRecord | null;
  events(runId: string, filter?: EventFilter): EventPage;
  /** run_id → directory slug, or null. For tooling that still needs the on-disk location (the legacy
   *  dashboard scan, the doctor); NOT used by any service route. */
  slugOf(runId: string): string | null;
  close(): void;
}

/** Steps a run cannot advance from (state.ts STEP_VOCAB). `active` is the complement. */
const TERMINAL_STEPS = ["7", "merged", "aborted"] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_EVENT_LIMIT = 500;
export const MAX_EVENT_LIMIT = 2000;

interface RunRow {
  run_id: string;
  slug: string;
  requested_by: string | null;
  repo: string;
  branch: string;
  tier: string;
  step: string;
  round: number;
  pr: number | null;
  started_at: string;
  updated_at: string;
  event_count: number;
  cost_usd: number;
  duration_ms: number;
  parity_error: string | null;
}

interface DetailRow {
  task: string;
  ticket: string | null;
  summary: string | null;
  worktree: string;
  head_sha: string | null;
  last_reviewed_sha: string | null;
}

interface EventRow {
  run_id: string;
  seq: number;
  ts: string;
  event: string;
  step: string | null;
  round: number | null;
  data: string | null;
  cost_cum: number | null;
  prev: string;
}

function rowToSummary(row: RunRow): RunSummary {
  return {
    runId: row.run_id,
    slug: row.slug,
    requestedBy: row.requested_by,
    repo: row.repo,
    branch: row.branch,
    tier: row.tier,
    step: row.step,
    round: row.round,
    pr: row.pr,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    eventCount: row.event_count,
    costUsd: row.cost_usd > 0 ? row.cost_usd : null,
    durationMs: row.duration_ms,
    parityError: row.parity_error,
    stale: row.slug.includes(".stale-"),
  };
}

function rowToEvent(row: EventRow): JournalEvent {
  return {
    seq: row.seq,
    ts: row.ts,
    run_id: row.run_id,
    event: row.event as JournalEvent["event"],
    ...(row.step !== null ? { step: row.step } : {}),
    ...(row.round !== null ? { round: row.round } : {}),
    ...(row.data !== null ? { data: JSON.parse(row.data) as Record<string, unknown> } : {}),
    ...(row.cost_cum !== null ? { cost_cum: row.cost_cum } : {}),
    prev: row.prev,
  } as JournalEvent;
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/** The shared WHERE for `list`/`count`, so one filter cannot mean two things in a single response —
 *  a paginated list whose `total` came from a different predicate is a subtly wrong page count. */
function whereFor(f: ListFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
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
  if (f.step !== undefined) {
    clauses.push("step = ?");
    params.push(f.step);
  }
  if (f.active === true) {
    clauses.push(`step NOT IN (${TERMINAL_STEPS.map(() => "?").join(", ")})`);
    params.push(...TERMINAL_STEPS);
  } else if (f.active === false) {
    clauses.push(`step IN (${TERMINAL_STEPS.map(() => "?").join(", ")})`);
    params.push(...TERMINAL_STEPS);
  }
  if (!f.includeStale) clauses.push("slug NOT LIKE '%.stale-%'");
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

export class SqliteRunIndex implements RunIndex {
  constructor(private readonly db: DatabaseSync) {}

  list(filter: ListFilter = {}): RunSummary[] {
    const { sql, params } = whereFor(filter);
    const limit = clamp(filter.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = Math.max(0, Math.trunc(filter.offset ?? 0));
    const rows = this.db
      .prepare(`SELECT * FROM runs${sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as RunRow[];
    return rows.map(rowToSummary);
  }

  count(filter: ListFilter = {}): number {
    const { sql, params } = whereFor(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs${sql}`)
      .get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  get(runId: string): RunRecord | null {
    const run = this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as unknown as RunRow | undefined;
    if (!run) return null;
    // LEFT-JOIN semantics by hand: `run_detail` is seeded alongside the run, but a row that predates
    // the detail table (or a partially-reindexed one) must still render rather than 404.
    const detail = this.db
      .prepare(
        "SELECT task, ticket, summary, worktree, head_sha, last_reviewed_sha FROM run_detail WHERE run_id = ?",
      )
      .get(runId) as unknown as DetailRow | undefined;
    return {
      ...rowToSummary(run),
      task: detail?.task ?? "",
      ticket: detail?.ticket ?? null,
      summary: detail?.summary ?? null,
      worktree: detail?.worktree ?? "",
      headSha: detail?.head_sha ?? null,
      lastReviewedSha: detail?.last_reviewed_sha ?? null,
    };
  }

  events(runId: string, filter: EventFilter = {}): EventPage {
    const limit = clamp(filter.limit, DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT);
    const params: (string | number)[] = [runId];
    let sql = "SELECT * FROM run_events WHERE run_id = ?";
    if (filter.afterSeq !== undefined) {
      sql += " AND seq > ?";
      params.push(filter.afterSeq);
    }
    if (filter.events && filter.events.length > 0) {
      sql += ` AND event IN (${filter.events.map(() => "?").join(", ")})`;
      params.push(...filter.events);
    }
    // One extra row reveals whether a next page exists, without a second COUNT query.
    sql += " ORDER BY seq ASC LIMIT ?";
    const rows = this.db.prepare(sql).all(...params, limit + 1) as unknown as EventRow[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(rowToEvent),
      nextSeq: hasMore && page.length > 0 ? page[page.length - 1].seq : null,
    };
  }

  slugOf(runId: string): string | null {
    const row = this.db
      .prepare("SELECT slug FROM runs WHERE run_id = ?")
      .get(runId) as { slug: string } | undefined;
    return row ? row.slug : null;
  }

  close(): void {
    this.db.close();
  }
}
