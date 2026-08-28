// Rebuilds the run tables from the run directories: the migration for runs predating the SQLite
// projection, and the recovery path for a lost or corrupted db.
//
// Per-run write order mirrors the live path exactly — seedRun, then appendEvent per event replaying
// the same increments `Journal.append` would have computed, then upsertRun's full recompute — so a
// reindexed db and a lived-through one are indistinguishable.

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
 * Runs a rebuild would destroy. `clearAll()` cascades to `run_events`, so a mid-run child's next
 * append hits a dangling foreign key and the run dies hours in.
 */
function liveRuns(store: SqliteRunStore, runsDir: string): string[] {
  const live: string[] = [];

  // The service's own claim on a process.
  const claimed = store
    .raw()
    .prepare("SELECT run_id FROM queue WHERE status = 'running'")
    .all() as unknown as { run_id: string }[];
  live.push(...claimed.map((r) => r.run_id));

  // Ground truth, covering CLI runs the queue knows nothing about. Deliberately not
  // `step NOT IN (terminal)`: a run abandoned a month ago sits at a non-terminal step forever, and
  // refusing to rebuild over it would make this guard noise. Only a live lock holder is driving.
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

/** The rule `Journal.append` uses: zero for the first event and across a run.resume, else the gap
 *  to the previous ts; cost only on a skill.result. */
function incrementOf(prevTs: string | null, ev: JournalEvent): { deltaMs: number; costUsd: number } {
  const deltaMs =
    prevTs !== null && ev.event !== "run.resume"
      ? new Date(ev.ts).getTime() - new Date(prevTs).getTime()
      : 0;
  const costUsd =
    ev.event === "skill.result" ? ((ev.data?.cost_usd as number | undefined) ?? 0) : 0;
  return { deltaMs, costUsd };
}

/** Globs `skills/` rather than walking the journal's artifact refs, because the directory is the
 *  ground truth for what was written: a sidecar whose `skill.result` event never landed (a crash
 *  between the two writes) is still recovered. `name` and `sha256` are recomputed with the recipe
 *  `SkillLogger.artifact` uses, so a reindexed row matches a lived one. */
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
      // One unreadable sidecar must not cost the run its index entry — the journal it projects from
      // has already replayed by here. `putArtifact`'s jsonb() throws on malformed JSON, which files
      // written before `SkillLogger.artifact` took a value can be.
    }
  }
  return n;
}

/** Clears existing rows first, so the result reflects only what the journals say. Best-effort per
 *  run: a corrupt or empty journal is skipped and reported, never fatal to the rebuild. */
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
      // readReplica(), not read(): read() would query the very database this exists to rebuild.
      const { events } = new Journal(journalPath, slug).readReplica();
      if (events.length === 0) continue;
      const state = projectState(events);

      store.seedRun(slug, state);
      let prevTs: string | null = null;
      for (const ev of events) {
        store.appendEvent(state.run_id, ev, incrementOf(prevTs, ev));
        prevTs = ev.ts;
      }
      // Overwrites the incremental walk with the exact batch recompute, so float and ordering drift
      // cannot separate a reindex from a live run.
      store.upsertRun(slug, state, rollupsFromEvents(events));
      artifacts += reindexArtifacts(store, join(runsDir, slug), state.run_id);
      indexed++;
    } catch (err) {
      skipped.push({ slug, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { runsIndexed: indexed, runsSkipped: skipped, artifactsIndexed: artifacts };
}
