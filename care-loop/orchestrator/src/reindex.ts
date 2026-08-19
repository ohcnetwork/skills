// reindex.ts — `care-loopd reindex`: rebuild loops.db from the run directories
// (PLAN-sqlite-run-store.md §8). This is both the one-time migration for runs that predate the
// SQLite projection AND the standing proof of §2's invariant: `rm loops.db && care-loopd reindex`
// must be a complete, lossless recovery at any moment — exercised directly in
// test/reindex.test.ts, not merely asserted here.
//
// Per-run write order mirrors the live path exactly (seedRun → appendEvent per event, replaying the
// SAME incremental deltas `Journal.append` would have computed → upsertRun with the authoritative
// full recompute), so a reindexed DB and a lived-through DB are indistinguishable.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Journal, type JournalEvent } from "./journal.js";
import { projectState } from "./state.js";
import { rollupsFromEvents } from "./run-store.js";
import type { SqliteRunStore } from "./run-store.js";

export interface ReindexResult {
  runsIndexed: number;
  runsSkipped: { slug: string; error: string }[];
}

function discoverRunDirs(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((d) => {
      if (d.startsWith(".")) return false;
      const p = join(runsDir, d);
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Same increment rule `Journal.append` uses: 0 for the first event and across a run.resume
 *  boundary, else the gap to the previous event's ts; cost only on a skill.result event. */
function incrementOf(prevTs: string | null, ev: JournalEvent): { deltaMs: number; costUsd: number } {
  const deltaMs =
    prevTs !== null && ev.event !== "run.resume"
      ? new Date(ev.ts).getTime() - new Date(prevTs).getTime()
      : 0;
  const costUsd =
    ev.event === "skill.result" ? ((ev.data?.cost_usd as number | undefined) ?? 0) : 0;
  return { deltaMs, costUsd };
}

/** Rebuild `runs` / `run_detail` / `run_events` from every run dir's journal.jsonl under `runsDir`.
 *  Clears existing rows first, so the result reflects ONLY what the journals say. Best-effort per
 *  run: a corrupt/unreadable/empty journal is skipped and reported, never fatal to the rebuild. */
export function reindexRuns(store: SqliteRunStore, runsDir: string): ReindexResult {
  store.clearAll();

  const slugs = discoverRunDirs(runsDir);
  const skipped: { slug: string; error: string }[] = [];
  let indexed = 0;

  for (const slug of slugs) {
    const journalPath = join(runsDir, slug, "journal.jsonl");
    if (!existsSync(journalPath)) continue;
    try {
      // readReplica() (not read()): read() is DB-backed now (§10 item 3) and would query the very
      // database this loop exists to rebuild — the replica file is the only remaining source here.
      const { events } = new Journal(journalPath, slug).readReplica();
      if (events.length === 0) continue;
      const state = projectState(events);

      store.seedRun(slug, state);
      let prevTs: string | null = null;
      for (const ev of events) {
        store.appendEvent(state.run_id, ev, incrementOf(prevTs, ev));
        prevTs = ev.ts;
      }
      // Authoritative overwrite: replaces whatever the incremental walk above landed on with the
      // exact batch recompute, so float/ordering drift can never separate a reindex from a live run.
      store.upsertRun(slug, state, rollupsFromEvents(events));
      indexed++;
    } catch (err) {
      skipped.push({ slug, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { runsIndexed: indexed, runsSkipped: skipped };
}
