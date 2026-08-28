// The fleet read port. Reads the database and nothing else — `run_events` mirrors the journal
// completely, so the filesystem has nothing to add. That is what lets the service run anywhere the db
// is reachable with no run dirs mounted, and why `get` takes a run_id rather than a directory.

import type { DatabaseSync } from "node:sqlite";
import type { JournalEvent } from "./journal.js";
import { TERMINAL_STEPS, isTerminalStep } from "./state.js";

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
  stale: boolean;
  /** Sent rather than derived client-side: the step vocabulary is the orchestrator's, and a second
   *  copy drifts the moment a step is added. */
  terminal: boolean;
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

export type ListOrder = "started_at" | "updated_at" | "cost_usd" | "duration_ms";
export const LIST_ORDERS: readonly ListOrder[] = [
  "started_at",
  "updated_at",
  "cost_usd",
  "duration_ms",
];

export interface ListFilter {
  requestedBy?: string;
  repo?: string;
  branch?: string;
  step?: string;
  ticket?: string;
  pr?: number;
  /** Free text over task / summary / branch / ticket — the fleet view's search box. */
  q?: string;
  /** ISO bounds on `started_at`, half-open: `[since, until)`. */
  since?: string;
  until?: string;
  /** Only runs that have not reached a terminal step (`7`/`merged`/`aborted`). */
  active?: boolean;
  /** Include archived `.stale-` dirs. Defaults to false — they are noise in a fleet view. */
  includeStale?: boolean;
  order?: ListOrder;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** Filter controls without loading the fleet to derive them — four grouped scans of one row per run. */
export interface Facets {
  repos: { value: string; count: number }[];
  branches: { value: string; count: number }[];
  users: { value: string; count: number }[];
  steps: { value: string; count: number }[];
}

export interface EventFilter {
  /** `seq` is dense and monotonic per run, so it is a stabler cursor than an offset: a concurrent
   *  append cannot shift what it points at. */
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

/** Artifact metadata, WITHOUT the body — what a timeline needs to offer a link. */
export interface ArtifactSummary {
  path: string;
  name: string;
  sha256: string;
  bytes: number;
}

export interface ArtifactBody extends ArtifactSummary {
  /** Already parsed: the column holds jsonb, and re-stringifying it to be parsed again is waste. */
  content: unknown;
}

export interface RunIndex {
  list(filter?: ListFilter): RunSummary[];
  count(filter?: ListFilter): number;
  /** Honours the same filter, so narrowing to one repo offers only that repo's branches. */
  facets(filter?: ListFilter): Facets;
  get(runId: string): RunRecord | null;
  events(runId: string, filter?: EventFilter): EventPage;
  /** Body excluded: rendering a timeline must not stream 1 MB of skill envelopes. */
  artifacts(runId: string): ArtifactSummary[];
  /** Addressed by hash because that is the handle the journal's artifact ref carries, so the frontend
   *  goes from a timeline event to a body without a second lookup. */
  artifact(runId: string, sha256: string): ArtifactBody | null;
  close(): void;
}

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
    stale: row.slug.includes(".stale-"),
    terminal: isTerminalStep(row.step),
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

/** Exported so the HTTP layer echoes the EFFECTIVE paging: a response claiming `limit: 999` while
 *  serving 200 rows silently breaks `offset += limit`. One resolver serves both the query and the
 *  envelope, so they cannot disagree. */
export function resolvePaging(filter: ListFilter = {}): { limit: number; offset: number } {
  return {
    limit: clamp(filter.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    offset: Math.max(0, Math.trunc(filter.offset ?? 0)),
  };
}

/** Shared by `list` and `count`: a page whose `total` came from a different predicate is a subtly
 *  wrong page count. */
function whereFor(f: ListFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (f.requestedBy !== undefined) {
    clauses.push("r.requested_by = ?");
    params.push(f.requestedBy);
  }
  if (f.repo !== undefined) {
    clauses.push("r.repo = ?");
    params.push(f.repo);
  }
  if (f.branch !== undefined) {
    clauses.push("r.branch = ?");
    params.push(f.branch);
  }
  if (f.step !== undefined) {
    clauses.push("r.step = ?");
    params.push(f.step);
  }
  if (f.ticket !== undefined) {
    clauses.push("d.ticket = ?");
    params.push(f.ticket);
  }
  if (f.pr !== undefined) {
    clauses.push("r.pr = ?");
    params.push(f.pr);
  }
  if (f.q !== undefined) {
    // LIKE with escaped wildcards: a user typing "100%" must search for that, not for everything.
    const needle = `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(
      "(d.task LIKE ? ESCAPE '\\' OR d.summary LIKE ? ESCAPE '\\'" +
        " OR r.branch LIKE ? ESCAPE '\\' OR d.ticket LIKE ? ESCAPE '\\')",
    );
    params.push(needle, needle, needle, needle);
  }
  if (f.since !== undefined) {
    clauses.push("r.started_at >= ?");
    params.push(f.since);
  }
  if (f.until !== undefined) {
    clauses.push("r.started_at < ?");
    params.push(f.until);
  }
  if (f.active === true) {
    clauses.push(`r.step NOT IN (${TERMINAL_STEPS.map(() => "?").join(", ")})`);
    params.push(...TERMINAL_STEPS);
  } else if (f.active === false) {
    clauses.push(`r.step IN (${TERMINAL_STEPS.map(() => "?").join(", ")})`);
    params.push(...TERMINAL_STEPS);
  }
  if (!f.includeStale) clauses.push("r.slug NOT LIKE '%.stale-%'");
  return { sql: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}

/** LEFT, not INNER: a run whose detail row is missing must still be listed, not silently dropped. */
const FROM = "FROM runs r LEFT JOIN run_detail d ON d.run_id = r.run_id";

/** Chosen from a fixed set, never interpolated: the one place user input could reach SQL as syntax. */
function orderFor(f: ListFilter): string {
  const col: ListOrder = LIST_ORDERS.includes(f.order as ListOrder)
    ? (f.order as ListOrder)
    : "started_at";
  const dir = f.dir === "asc" ? "ASC" : "DESC";
  return `ORDER BY r.${col} ${dir}`;
}

export class SqliteRunIndex implements RunIndex {
  constructor(private readonly db: DatabaseSync) {}

  list(filter: ListFilter = {}): RunSummary[] {
    const { sql, params } = whereFor(filter);
    const { limit, offset } = resolvePaging(filter);
    const rows = this.db
      .prepare(`SELECT r.* ${FROM}${sql} ${orderFor(filter)} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as RunRow[];
    return rows.map(rowToSummary);
  }

  count(filter: ListFilter = {}): number {
    const { sql, params } = whereFor(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n ${FROM}${sql}`)
      .get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  facets(filter: ListFilter = {}): Facets {
    const { sql, params } = whereFor(filter);
    const group = (col: string): { value: string; count: number }[] => {
      // `whereFor` returns "" or a leading " WHERE ...", so the guard has to join on whichever.
      const where = sql ? `${sql} AND ${col} IS NOT NULL` : ` WHERE ${col} IS NOT NULL`;
      return this.db
        .prepare(
          `SELECT ${col} AS value, COUNT(*) AS count ${FROM}${where}` +
            ` GROUP BY ${col} ORDER BY count DESC, value ASC`,
        )
        .all(...params) as unknown as { value: string; count: number }[];
    };
    // Literals from this file, never query-string input — see `orderFor`.
    return {
      repos: group("r.repo"),
      branches: group("r.branch"),
      users: group("r.requested_by"),
      steps: group("r.step"),
    };
  }

  get(runId: string): RunRecord | null {
    const run = this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as unknown as RunRow | undefined;
    if (!run) return null;
    // A run whose detail row predates the table, or is partially reindexed, must still render.
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

  artifacts(runId: string): ArtifactSummary[] {
    return this.db
      .prepare(
        "SELECT path, name, sha256, bytes FROM run_artifacts WHERE run_id = ? ORDER BY path",
      )
      .all(runId) as unknown as ArtifactSummary[];
  }

  artifact(runId: string, sha256: string): ArtifactBody | null {
    // The journal ref carries `sha256:<hex>`; a URL path segment is cleaner as bare hex.
    const full = sha256.startsWith("sha256:") ? sha256 : `sha256:${sha256}`;
    // Parsed once here, so the response carries a JSON value rather than a string containing JSON.
    const row = this.db
      .prepare(
        "SELECT path, name, sha256, bytes, json(content) AS content FROM run_artifacts WHERE run_id = ? AND sha256 = ? LIMIT 1",
      )
      .get(runId, full) as unknown as (Omit<ArtifactBody, "content"> & { content: string }) | undefined;
    if (!row) return null;
    return { ...row, content: JSON.parse(row.content) as unknown };
  }

  close(): void {
    this.db.close();
  }
}
