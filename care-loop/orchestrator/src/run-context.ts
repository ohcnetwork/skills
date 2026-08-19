// run-context.ts — resolves the stable per-run-dir ULID `run_id` (PLAN-sqlite-run-store.md §5), and
// opens the run's journal bound to it. This is the ONE place that used to be duplicated as
// `${repo.replace("/", "-")}-${branch}` at ten call sites; those now call `openRun`/`resolveRunId`.
//
// Why a cache file (`.run_id`) rather than only reading it off the journal: several call sites need
// the id BEFORE the journal's first event exists (run.start itself has not been written yet), so
// there is a genuine chicken-and-egg the first time a run dir is touched. `.run_id` breaks it: the
// FIRST caller (in any process) mints or recovers the id and caches it; every later caller in this
// or another process reads the same cached value. It is a pure cache, not a second source of truth —
// deleting it is always safe: the next call re-derives from the journal (minting fresh only if the
// journal is ALSO empty), so PLAN §2's "journal is the single source of truth" still holds.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "./journal.js";
import { projectState } from "./state.js";
import { mintRunId } from "./run-id.js";

const CACHE_FILE = ".run_id";

function readCache(runDir: string): string | null {
  const p = join(runDir, CACHE_FILE);
  if (!existsSync(p)) return null;
  const v = readFileSync(p, "utf8").trim();
  return v || null;
}

function writeCache(runDir: string, runId: string): void {
  const p = join(runDir, CACHE_FILE);
  const tmp = p + ".tmp";
  writeFileSync(tmp, runId + "\n", "utf8");
  renameSync(tmp, p);
}

/** Resolve (and cache) the stable run id for a run directory: the cache file if present, else the
 *  id folded from an existing journal (self-healed by `validateState` if it predates run_id), else a
 *  freshly minted ULID for a brand-new run dir. */
export function resolveRunId(runDir: string): string {
  const cached = readCache(runDir);
  if (cached) return cached;

  const journalPath = join(runDir, "journal.jsonl");
  let runId: string;
  if (existsSync(journalPath)) {
    // readReplica() (not read()): the run_id isn't known yet — that's what this peek is FOR — and
    // read() is DB-backed (§10 item 3), so it would need the id to query by. The replica file is
    // parsed directly instead, independent of any run_id.
    const { events } = new Journal(journalPath, "unresolved").readReplica();
    runId = events.length > 0 ? projectState(events).run_id : mintRunId();
  } else {
    runId = mintRunId();
  }
  writeCache(runDir, runId);
  return runId;
}

export interface OpenRun {
  journal: Journal;
  runId: string;
  /** true iff the journal was empty at open time — replaces the `j.read().events.length === 0`
   *  check duplicated at every former derive site. */
  isNew: boolean;
}

/** Resolve the run id and open a `Journal` bound to it in one call — the `openRun(runDir, runId)`
 *  factory PLAN §4 calls for, removing the last of the ten duplicated call sites. */
export function openRun(runDir: string): OpenRun {
  const runId = resolveRunId(runDir);
  const journal = new Journal(join(runDir, "journal.jsonl"), runId);
  const isNew = journal.read().events.length === 0;
  return { journal, runId, isNew };
}

/** Who asked for this run. **Claimed attribution, not authentication** ([[PLAN-loop-service]] §2/§6):
 *  the loop-service supervisor sets `CARE_REQUESTED_BY` per child process from the caller's
 *  `X-Care-User` header, and a local CLI run leaves it unset so the column stays NULL — which is
 *  exactly what `runs.requested_by` documents.
 *
 *  ONE resolver for all four seed sites on purpose. The `run_id` sweep (PLAN-sqlite-run-store.md §5)
 *  is the cautionary tale: a value re-derived independently at each site drifted into three different
 *  formulas inside a single journal.
 *
 *  Resolved once, at seed time. `resume` re-projects it from the journal like any other CareState
 *  field, so resuming someone else's run never rewrites who asked for it. */
export function resolveRequestedBy(explicit?: string): string | null {
  const raw = (explicit ?? process.env.CARE_REQUESTED_BY)?.trim();
  return raw ? raw : null;
}
