// service/backup.ts — the durability the projection design deferred to this point
// ([[PLAN-loop-service]] §12, [[PLAN-sqlite-run-store]] §10).
//
// Until now, losing `loops.db` cost nothing: `care-loopd reindex` rebuilt every row from the journals
// on disk. `queue` (and later `gate_asks`) breaks that. A pending request is not a run yet, so no
// journal describes it, and no rebuild can bring it back. That is the moment backups stop being
// tidiness and start being the only recovery path for part of the database — which is why they land
// with the queue rather than earlier or later.
//
// `VACUUM INTO` rather than copying the file: it takes a consistent snapshot of a live database
// through SQLite itself, so it is safe with WAL and with readers and writers connected. Copying
// `loops.db` while the service is running can capture a torn page or miss the WAL entirely.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface BackupOptions {
  dir: string;
  /** How many snapshots to keep. Older ones are pruned oldest-first after each successful backup. */
  keep?: number;
}

const PREFIX = "loops-";
const SUFFIX = ".db";

/** Take one snapshot. Returns its path.
 *
 *  `node:sqlite` is SYNCHRONOUS, so this blocks the event loop for the duration of the vacuum — the
 *  whole service is unresponsive while it runs. At the current 1.3 MB that is single-digit
 *  milliseconds and irrelevant. Stated so it is not rediscovered as a mystery latency spike: if
 *  `loops.db` reaches the tens of megabytes, move this to a worker thread or a child process.
 *
 *  Snapshots default to `<db dir>/backups`, which sits inside the tree `reindex` scans — harmless,
 *  because `discoverRunDirs` skips non-run directories, but worth knowing before anything starts
 *  archiving the run tree wholesale. */
export function backupNow(db: DatabaseSync, o: BackupOptions, now: Date = new Date()): string {
  mkdirSync(o.dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(o.dir, `${PREFIX}${stamp}${SUFFIX}`);
  // A parameter, not interpolation: the path is derived here rather than from input, but VACUUM INTO
  // takes a bound value and there is no reason to hand SQLite a hand-built string.
  db.prepare("VACUUM INTO ?").run(path);
  prune(o.dir, o.keep ?? 7);
  return path;
}

/** Keep the newest `keep` snapshots; delete the rest. */
export function prune(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const snaps = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    // Sorting by NAME works because the stamp is ISO-8601 and fixed-width, so lexicographic order is
    // chronological order — no stat call per file, and no dependence on mtime, which a copy or a
    // restore would rewrite.
    .sort()
    .reverse();
  const doomed = snaps.slice(Math.max(0, keep));
  for (const f of doomed) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      // A snapshot we cannot delete is a disk-space problem, not a correctness one. Pruning must
      // never be the reason a backup cycle reports failure.
    }
  }
  return doomed;
}

export function listBackups(dir: string): { path: string; bytes: number }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort()
    .map((f) => ({ path: join(dir, f), bytes: statSync(join(dir, f)).size }));
}

/** `PRAGMA integrity_check` — run at boot, before serving anything.
 *
 *  Reported, not fatal. A corrupt database that still answers most queries is more useful to a team
 *  than a service that refuses to start, and the run tables remain rebuildable with `reindex`. The
 *  point is that someone LEARNS about it: silent corruption discovered weeks later, after backups
 *  have rotated past the last good snapshot, is the failure this exists to prevent. */
export function integrityCheck(db: DatabaseSync): { ok: boolean; problems: string[] } {
  const rows = db.prepare("PRAGMA integrity_check").all() as unknown as {
    integrity_check: string;
  }[];
  const problems = rows.map((r) => r.integrity_check).filter((v) => v !== "ok");
  return { ok: problems.length === 0, problems };
}
