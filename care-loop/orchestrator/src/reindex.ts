// reindex.ts — `care-loopd reindex`: rebuild loops.db from the run directories
// (PLAN-sqlite-run-store.md §8). This is both the one-time migration for runs that predate the
// SQLite projection AND the standing proof of §2's invariant: `rm loops.db && care-loopd reindex`
// must be a complete, lossless recovery at any moment — exercised directly in
// test/reindex.test.ts, not merely asserted here.
//
// Per-run write order mirrors the live path exactly (seedRun → appendEvent per event, replaying the
// SAME incremental deltas `Journal.append` would have computed → upsertRun with the authoritative
// full recompute), so a reindexed DB and a lived-through DB are indistinguishable.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Journal, type JournalEvent } from "./journal.js";
import { projectState } from "./state.js";
import { rollupsFromEvents } from "./run-store.js";
import { inspectLock } from "./lock.js";
import type { SqliteRunStore } from "./run-store.js";

export interface ReindexResult {
  runsIndexed: number;
  runsSkipped: { slug: string; error: string }[];
  artifactsIndexed: number;
}

export class ReindexUnsafeError extends Error {}

/**
 * Runs that would be destroyed by a rebuild.
 *
 * `clearAll()` is `DELETE FROM runs`, cascading to `run_events`. A child that is mid-run then appends
 * an event whose FK parent no longer exists — a violation, and fatal by design (§2's "both writes are
 * fatal"), so the run dies hours in with an error about foreign keys.
 *
 * This was harmless when runs were driven one at a time by the person typing the command. With an
 * always-on service and N children it is a foot-gun, and `usage()` described reindex as "safe at any
 * time" — which was true of the design it was written for and stopped being true at the cutover.
 */
function liveRuns(store: SqliteRunStore, runsDir: string): string[] {
  const live: string[] = [];

  // The service's own claim on a process.
  const claimed = store
    .raw()
    .prepare("SELECT run_id FROM queue WHERE status = 'running'")
    .all() as unknown as { run_id: string }[];
  live.push(...claimed.map((r) => r.run_id));

  // And the ground truth, which covers CLI-started runs the queue knows nothing about. Deliberately
  // NOT `runs.step NOT IN (terminal)`: a run abandoned a month ago sits at a non-terminal step
  // forever, and refusing to rebuild because of it would make the guard useless noise. A held lock
  // with a LIVE holder is the only thing that means "something is driving this right now".
  for (const slug of discoverRunDirs(runsDir)) {
    const status = inspectLock(join(runsDir, slug));
    if (status.held && status.alive) live.push(slug);
  }
  return [...new Set(live)];
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

/** Restore a run's skill artifact BODIES from the sidecars on disk ([[PLAN-loop-service]] §6).
 *
 *  Globbing `skills/` rather than walking the journal's artifact refs is deliberate: the directory is
 *  the ground truth for what was actually written, so a sidecar whose `skill.result` event never made
 *  it to disk (a crash between the two writes) is still recovered. `name`/`sha256` are recomputed with
 *  the same recipe `SkillLogger.artifact` uses, so a reindexed row is byte-identical to a lived one.
 *
 *  This is what keeps artifacts REBUILDABLE — the property that separates them from `queue` and
 *  `gate_asks`, which no reindex can restore. `rm loops.db && care-loopd reindex` stays lossless. */
function reindexArtifacts(store: SqliteRunStore, runDir: string, runId: string): number {
  const skillsDir = join(runDir, "skills");
  if (!existsSync(skillsDir)) return 0;
  let n = 0;
  for (const file of readdirSync(skillsDir).sort()) {
    const full = join(skillsDir, file);
    try {
      if (!statSync(full).isFile()) continue;
      const content = readFileSync(full, "utf8");
      store.putArtifact(runId, {
        path: `skills/${file}`,
        name: file.replace(/\.[^.]+$/, ""),
        sha256: "sha256:" + createHash("sha256").update(content, "utf8").digest("hex"),
        content,
      });
      n++;
    } catch {
      // One unreadable or non-JSON sidecar must not cost the whole run its index entry — the journal,
      // which the run's state is projected from, has already been replayed successfully by here.
      // `putArtifact` encodes with jsonb(), which throws on malformed JSON: files written before
      // `SkillLogger.artifact` took a value (and so could hold anything) land here rather than
      // aborting the rebuild.
    }
  }
  return n;
}

/** Rebuild `runs` / `run_detail` / `run_events` / `run_artifacts` from every run dir under `runsDir`.
 *  Clears existing rows first, so the result reflects ONLY what the journals say. Best-effort per
 *  run: a corrupt/unreadable/empty journal is skipped and reported, never fatal to the rebuild. */
export function reindexRuns(
  store: SqliteRunStore,
  runsDir: string,
  opts: { force?: boolean } = {},
): ReindexResult {
  if (!opts.force) {
    const live = liveRuns(store, runsDir);
    if (live.length > 0)
      throw new ReindexUnsafeError(
        `refusing to rebuild: ${live.length} run(s) may be live (${live.slice(0, 3).join(", ")}` +
          `${live.length > 3 ? ", …" : ""}). A rebuild deletes run_events out from under a running ` +
          `child and kills it with a foreign-key error. Wait, or pass --force if you are sure.`,
      );
  }
  store.clearAll();

  const slugs = discoverRunDirs(runsDir);
  const skipped: { slug: string; error: string }[] = [];
  let indexed = 0;
  let artifacts = 0;

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
      artifacts += reindexArtifacts(store, join(runsDir, slug), state.run_id);
      indexed++;
    } catch (err) {
      skipped.push({ slug, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { runsIndexed: indexed, runsSkipped: skipped, artifactsIndexed: artifacts };
}
