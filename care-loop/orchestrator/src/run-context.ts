// Resolves a run directory's stable ULID and opens its journal bound to that id — the single place
// this is derived, replacing ten copies of `${repo}-${branch}`.
//
// The `.run_id` cache file exists because several callers need the id BEFORE the journal's first
// event is written. It is a pure cache, never a second source of truth: deleting it is always safe,
// because the next call re-derives from the journal and only mints fresh if that is empty too.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "./journal.js";
import { inspectLock } from "./lock.js";
import { projectState } from "./state.js";
import { isValidRunId, mintRunId } from "./run-id.js";

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

export class RunIdConflictError extends Error {}

/** Set by the supervisor, which mints at enqueue so `POST /api/runs` can answer synchronously — the
 *  child starts long afterwards and cannot be the one to mint. Validated here rather than at first
 *  use: a malformed id would otherwise fail only once a run was already part-written. */
function readPinnedRunId(): string | null {
  const raw = process.env.CARE_RUN_ID?.trim();
  if (!raw) return null;
  if (!isValidRunId(raw))
    throw new RunIdConflictError(
      `CARE_RUN_ID '${raw}' is not a valid run id (expected a 26-char Crockford base32 ULID)`,
    );
  return raw;
}

/**
 * Reconciles a pinned id against a run dir that already has one.
 *
 * Run dirs are keyed by `${repo}-${branch}`, so the second run of any branch lands on the first run's
 * directory — refusing outright would make every branch runnable exactly once, ever.
 *
 * What matters is whether anything is DRIVING the old run. A live lock means rebinding would hijack
 * a run in flight, and is still refused. A finished or crashed run holds no live lock and its
 * directory is merely in the way, so it is archived as `<dir>.stale-<ts>`.
 *
 * Archiving at START rather than on exit is deliberate: a crashed run never reaches an exit path, and
 * that is exactly the run whose directory would otherwise block its own retry.
 */
function reconcilePinnedId(
  established: string,
  pinned: string | null,
  runDir: string,
  source: string,
): "keep" | "archived" {
  if (!pinned || pinned === established) return "keep";

  const lock = inspectLock(runDir);
  if (lock.held && lock.alive)
    throw new RunIdConflictError(
      `CARE_RUN_ID is ${pinned} but ${runDir} is run ${established} (from its ${source}) and is ` +
        `LIVE — held by pid ${lock.pid}. Refusing to rebind a run in flight.`,
    );

  const archived = `${runDir}.stale-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(runDir, archived);
  mkdirSync(runDir, { recursive: true });
  console.error(`run dir already held ${established}; archived to ${archived}`);
  return "archived";
}

/** In precedence order: the cache file, the id folded from an existing journal, the caller's pin,
 *  then a fresh ULID. Established beats pinned — the pin only supplies an id for a run dir that does
 *  not have one yet. */
export function resolveRunId(runDir: string): string {
  const pinned = readPinnedRunId();

  const cached = readCache(runDir);
  if (cached) {
    if (reconcilePinnedId(cached, pinned, runDir, "cache") === "keep") return cached;
    // archived: the dir is empty again, so fall through and adopt the pinned id.
    writeCache(runDir, pinned!);
    return pinned!;
  }

  const journalPath = join(runDir, "journal.jsonl");
  let runId: string;
  if (existsSync(journalPath)) {
    // readReplica(), not read(): the id is not known yet — that is what this peek is for — and
    // read() would need it to query by.
    const { events } = new Journal(journalPath, "unresolved").readReplica();
    if (events.length > 0) {
      const established = projectState(events).run_id;
      runId =
        reconcilePinnedId(established, pinned, runDir, "journal") === "keep" ? established : pinned!;
    } else {
      runId = pinned ?? mintRunId();
    }
  } else {
    runId = pinned ?? mintRunId();
  }
  writeCache(runDir, runId);
  return runId;
}

export interface OpenRun {
  journal: Journal;
  runId: string;
  /** Whether the journal was empty at open time. */
  isNew: boolean;
}

/** Resolves the run id and opens a `Journal` bound to it in one call. */
export function openRun(runDir: string): OpenRun {
  const runId = resolveRunId(runDir);
  const journal = new Journal(join(runDir, "journal.jsonl"), runId);
  const isNew = journal.read().events.length === 0;
  return { journal, runId, isNew };
}

/** Claimed attribution, not authentication: the supervisor sets `CARE_REQUESTED_BY` per child, and a
 *  local CLI run leaves it unset so the column stays NULL.
 *
 *  One resolver for all four seed sites, because the `run_id` sweep is the cautionary tale — a value
 *  re-derived at each site drifted into three formulas inside a single journal. Resolved once, at
 *  seed time; `resume` re-projects it from the journal like any other field, so resuming someone
 *  else's run never rewrites who asked for it. */
export function resolveRequestedBy(explicit?: string): string | null {
  const raw = (explicit ?? process.env.CARE_REQUESTED_BY)?.trim();
  return raw ? raw : null;
}
