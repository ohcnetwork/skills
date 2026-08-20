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

/** Distinct values with counts, for building filter controls without loading the fleet to derive
 *  them client-side. Cheap: four grouped scans of a table with one row per run. */
export interface Facets {
  repos: { value: string; count: number }[];
  branches: { value: string; count: number }[];
  users: { value: string; count: number }[];
  steps: { value: string; count: number }[];
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

/** Artifact metadata, WITHOUT the body — what a timeline needs to offer a link. */
export interface ArtifactSummary {
  path: string;
  name: string;
  sha256: string;
  bytes: number;
}

export interface ArtifactBody extends ArtifactSummary {
  /** The artifact's JSON value, already parsed — the column holds jsonb, and re-stringifying it for
   *  the client to parse again would be two pointless round trips. */
  content: unknown;
}

export interface RunIndex {
  list(filter?: ListFilter): RunSummary[];
  count(filter?: ListFilter): number;
  /** Distinct values with counts, honouring the same filter — so narrowing to one repo shows only the
   *  branches that repo actually has, rather than every branch in the fleet. */
  facets(filter?: ListFilter): Facets;
  get(runId: string): RunRecord | null;
  events(runId: string, filter?: EventFilter): EventPage;
  /** Artifact metadata for a run, body excluded — listing a timeline must not stream 1 MB of skill
   *  envelopes nobody asked for. */
  artifacts(runId: string): ArtifactSummary[];
  /** One artifact body by content hash (hex digest, with or without the `sha256:` prefix). Addressed
   *  by hash rather than path because that is the handle the journal's artifact ref already carries,
   *  so the frontend goes from a timeline event to a body without a second lookup. */
  artifact(runId: string, sha256: string): ArtifactBody | null;
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

/** The paging actually applied to a `list` call — defaults filled in, `limit` clamped to the ceiling.
 *
 *  Exported because the HTTP layer must echo back the EFFECTIVE values, not the requested ones. A
 *  response that says `limit: 999` while serving 200 rows breaks the most natural client-side
 *  pagination there is (`offset += limit`), and does it silently: the reader skips 799 rows per page
 *  and nothing errors. One resolver, used by the query and by the envelope, makes that impossible. */
export function resolvePaging(filter: ListFilter = {}): { limit: number; offset: number } {
  return {
    limit: clamp(filter.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT),
    offset: Math.max(0, Math.trunc(filter.offset ?? 0)),
  };
}

/** The shared WHERE for `list`/`count`, so one filter cannot mean two things in a single response —
 *  a paginated list whose `total` came from a different predicate is a subtly wrong page count. */
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

/** `runs` LEFT JOIN `run_detail` — the shape both `list` and `count` query through, so a filter on a
 *  detail column (ticket, task, summary) means the same thing in the page and in its total. LEFT, not
 *  INNER: a run whose detail row is missing must still be listed, not silently dropped from the
 *  fleet. */
const FROM = "FROM runs r LEFT JOIN run_detail d ON d.run_id = r.run_id";

/** Whitelisted ORDER BY. The column name is chosen from a fixed set rather than interpolated from the
 *  query string — the one place in this file where user input would otherwise reach SQL as syntax. */
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
      // `whereFor` returns either "" or a leading " WHERE ..."; the NULL guard has to join on
      // whichever it was. Building the clause explicitly beats patching the string afterwards.
      const where = sql ? `${sql} AND ${col} IS NOT NULL` : ` WHERE ${col} IS NOT NULL`;
      return this.db
        .prepare(
          `SELECT ${col} AS value, COUNT(*) AS count ${FROM}${where}` +
            ` GROUP BY ${col} ORDER BY count DESC, value ASC`,
        )
        .all(...params) as unknown as { value: string; count: number }[];
    };
    // Column names are literals from this file, never query-string input — see `orderFor`.
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

  artifacts(runId: string): ArtifactSummary[] {
    return this.db
      .prepare(
        "SELECT path, name, sha256, bytes FROM run_artifacts WHERE run_id = ? ORDER BY path",
      )
      .all(runId) as unknown as ArtifactSummary[];
  }

  artifact(runId: string, sha256: string): ArtifactBody | null {
    // Accept both spellings: the journal ref carries `sha256:<hex>`, while a URL path segment is
    // cleaner as the bare hex. Normalizing here means neither caller has to think about it.
    const full = sha256.startsWith("sha256:") ? sha256 : `sha256:${sha256}`;
    // json(content) decodes the jsonb BLOB back to text; parsed once here so the response carries a
    // real JSON value rather than a string containing JSON.
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
