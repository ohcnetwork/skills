// run-index.ts — RunIndex: the read path over the SQLite projection (PLAN-sqlite-run-store.md §7).
// The fleet list becomes a single-table indexed scan instead of re-parsing every event of every
// journal on each dashboard poll. The detail view still reads the journal file directly — one file,
// one run, stays cheap forever (§7) — `run_detail`/`run_events` are not consulted here on purpose.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Journal, type JournalEvent } from "./journal.js";
import { projectState, type CareState } from "./state.js";
import { renderEvent } from "./render.js";

/** v2: drops `task` from the fleet-list query (the renderer never reads it —
 *  dashboard.html:655-673 — so dropping it keeps the query join-free against run_detail). Shaped to
 *  match the pre-existing dashboard.ts `RunSummary` JSON contract exactly — dashboard.html needs no
 *  change (verify with a render diff, not by assumption — PLAN §7). */
export interface RunSummary {
  runId: string; // ULID — the stable key; what `/api/runs/:run_id` and the FE link by
  name: string; // slug — the run dir's basename. A DISPLAY label: no unique constraint, and a
  //               reused branch collides on it deterministically. Never key off this.
  state: {
    step: string;
    round: number;
    pr: number | null;
    tier: string;
    repo: string;
    branch: string;
    updated_at: string;
  } | null;
  eventCount: number;
  lastCost: number | null;
  startedAt: string | null;
  durationMs: number | null;
  stale: boolean;
}

export interface RunDetail {
  name: string;
  state: CareState | null;
  events: (JournalEvent & { rendered: string })[];
  truncatedTail: boolean;
  error?: string;
}

export interface RunIndex {
  list(filter?: { requestedBy?: string }): RunSummary[];
  slugOf(runId: string): string | null;
  get(runsDir: string, name: string): RunDetail;
}

interface RunRow {
  run_id: string;
  slug: string;
  step: string;
  round: number;
  pr: number | null;
  tier: string;
  repo: string;
  branch: string;
  updated_at: string;
  started_at: string;
  event_count: number;
  cost_usd: number;
  duration_ms: number;
}

function rowToSummary(row: RunRow): RunSummary {
  return {
    runId: row.run_id,
    name: row.slug,
    state: {
      step: row.step,
      round: row.round,
      pr: row.pr,
      tier: row.tier,
      repo: row.repo,
      branch: row.branch,
      updated_at: row.updated_at,
    },
    eventCount: row.event_count,
    lastCost: row.cost_usd > 0 ? row.cost_usd : null,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    stale: row.slug.includes(".stale-"),
  };
}

export class SqliteRunIndex implements RunIndex {
  constructor(private readonly db: DatabaseSync) {}

  list(filter?: { requestedBy?: string }): RunSummary[] {
    const rows = (
      filter?.requestedBy
        ? this.db
            .prepare(
              "SELECT * FROM runs WHERE requested_by = ? ORDER BY started_at DESC",
            )
            .all(filter.requestedBy)
        : this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all()
    ) as unknown as RunRow[];
    return rows.map(rowToSummary);
  }

  /** Map a run id to its directory slug, or null if this db has no such run. The service's
   *  `/api/runs/:run_id` routes resolve the on-disk location through here — `slug` is a display
   *  label with NO unique constraint (a reused branch collides deterministically), so it is a
   *  lookup key only for the legacy no-db path. */
  slugOf(runId: string): string | null {
    const row = this.db
      .prepare("SELECT slug FROM runs WHERE run_id = ?")
      .get(runId) as { slug: string } | undefined;
    return row ? row.slug : null;
  }

  /** Detail view: reads the journal file directly (one file, one run — cheap forever, PLAN §7).
   *  `name` is the directory SLUG; `readReplica()` (not `read()`) is what can be called with it,
   *  because `read()` is DB-backed and queries BY run_id — passing a slug there matched no rows and
   *  silently returned an empty timeline. */
  get(runsDir: string, name: string): RunDetail {
    const dir = join(runsDir, name);
    const journalPath = join(dir, "journal.jsonl");
    if (!existsSync(journalPath)) {
      return { name, state: null, events: [], truncatedTail: false, error: "no journal" };
    }
    try {
      const j = new Journal(journalPath, name);
      const { events, truncatedTail } = j.readReplica();
      const state = events.length > 0 ? projectState(events) : null;
      const rendered = events.map((e) => ({ ...e, rendered: renderEvent(e) }));
      return { name, state, events: rendered, truncatedTail };
    } catch (err) {
      return {
        name,
        state: null,
        events: [],
        truncatedTail: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  close(): void {
    this.db.close();
  }
}
