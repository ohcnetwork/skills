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
  name: string; // slug — the run dir's basename
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
  get(runsDir: string, name: string): RunDetail;
}

interface RunRow {
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

  /** Detail view: reads the journal file directly (one file, one run — cheap forever, PLAN §7). */
  get(runsDir: string, name: string): RunDetail {
    const dir = join(runsDir, name);
    const journalPath = join(dir, "journal.jsonl");
    if (!existsSync(journalPath)) {
      return { name, state: null, events: [], truncatedTail: false, error: "no journal" };
    }
    try {
      const j = new Journal(journalPath, name);
      const { events, truncatedTail } = j.read();
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
