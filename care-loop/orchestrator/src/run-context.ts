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
//
// `CARE_RUN_ID` lets a CALLER supply the id instead of having one minted here — the loop-service
// supervisor mints at enqueue so its `POST /api/runs` can answer `{ run_id }` synchronously. It only
// ever names a FRESH run dir; pointing it at an established one throws rather than rebinding.

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

/** The caller-supplied run id, if any: `CARE_RUN_ID`. Set by the loop-service supervisor, which mints
 *  the ULID at ENQUEUE time so `POST /api/runs` can return `{ run_id }` synchronously — the child
 *  process starts long afterwards, so it cannot be the one to mint it ([[PLAN-loop-service]] §5).
 *  Validated here rather than at first use: a malformed id would otherwise reach the `runs` primary
 *  key and only fail once a run was already part-written. */
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
 * Reconcile a pinned id against a run dir that already has one.
 *
 * The original rule was "established beats pinned, always throw" — which protected the case it was
 * written for (a stale `CARE_RUN_ID` aimed at a run in flight) but made the service's NORMAL case
 * impossible. Run dirs are keyed by `${repo}-${branch}` (`derivePaths`), so the second run of any
 * branch lands on the first run's directory. With ids minted at enqueue that is a guaranteed throw,
 * not a rare one: every branch was runnable exactly once, ever, and it would have surfaced as three
 * failed spawn attempts and an error about run ids to whoever asked for the run.
 *
 * The distinction that was missing is whether anything is ACTUALLY DRIVING the old run. A live lock
 * means rebinding would hijack a run in flight — still refused. A finished or crashed run holds no
 * live lock, and its directory is simply in the way: archive it as `<dir>.stale-<ts>` and let the new
 * run start clean.
 *
 * Archiving at START rather than on exit is deliberate: a crashed run never reaches an exit path, and
 * that is exactly the run whose directory would otherwise block its own retry. It also makes
 * `.stale-` a convention that code actually produces — the read-side filters in `run-index.ts` were
 * matching a naming scheme nothing wrote.
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

/** Resolve (and cache) the stable run id for a run directory: the cache file if present, else the
 *  id folded from an existing journal (self-healed by `validateState` if it predates run_id), else
 *  `CARE_RUN_ID` if the caller pinned one, else a freshly minted ULID for a brand-new run dir.
 *
 *  Precedence is deliberately "established beats pinned": the pin only supplies an id for a run dir
 *  that does not have one yet. See `assertNoConflict`. */
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
    // readReplica() (not read()): the run_id isn't known yet — that's what this peek is FOR — and
    // read() is DB-backed (§10 item 3), so it would need the id to query by. The replica file is
    // parsed directly instead, independent of any run_id.
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
