// Snapshots of loops.db. `queue`, `sessions`, and `gate_asks` have no journal behind them, so unlike
// the run tables they cannot be rebuilt by `reindex` — backups are their only recovery path.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface BackupOptions {
  dir: string;
  keep?: number;
}

const PREFIX = "loops-";
const SUFFIX = ".db";
const DEFAULT_KEEP = 7;

const isSnapshot = (file: string): boolean =>
  file.startsWith(PREFIX) && file.endsWith(SUFFIX);

/** ISO-8601 stamps are fixed-width, so lexicographic order is chronological — no stat per file, and
 *  no dependence on mtime, which a copy or a restore would rewrite. */
function snapshotsNewestFirst(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(isSnapshot).sort().reverse();
}

/**
 * `VACUUM INTO` takes a consistent snapshot through SQLite itself, so it is safe with WAL and with
 * readers and writers connected; copying the file can capture a torn page or miss the WAL.
 *
 * `node:sqlite` is synchronous, so this blocks the event loop for the whole vacuum. Irrelevant at
 * the current ~1 MB; move it to a worker if loops.db ever reaches tens of megabytes.
 */
export function backupNow(db: DatabaseSync, o: BackupOptions, now: Date = new Date()): string {
  mkdirSync(o.dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const path = join(o.dir, `${PREFIX}${stamp}${SUFFIX}`);
  db.prepare("VACUUM INTO ?").run(path);
  prune(o.dir, o.keep ?? DEFAULT_KEEP);
  return path;
}

export function prune(dir: string, keep: number): string[] {
  const expired = snapshotsNewestFirst(dir).slice(Math.max(0, keep));
  for (const file of expired) {
    try {
      unlinkSync(join(dir, file));
    } catch {
      // A snapshot we cannot delete is a disk-space problem; it must never fail the backup cycle.
    }
  }
  return expired;
}

export function listBackups(dir: string): { path: string; bytes: number }[] {
  return snapshotsNewestFirst(dir)
    .reverse()
    .map((file) => ({ path: join(dir, file), bytes: statSync(join(dir, file)).size }));
}

/** Run at boot and reported rather than thrown: a database that still answers most queries beats a
 *  service that refuses to start, and the run tables stay rebuildable. The point is that someone
 *  learns about it before backups rotate past the last good snapshot. */
export function integrityCheck(db: DatabaseSync): { ok: boolean; problems: string[] } {
  const rows = db.prepare("PRAGMA integrity_check").all() as unknown as {
    integrity_check: string;
  }[];
  const problems = rows.map((r) => r.integrity_check).filter((v) => v !== "ok");
  return { ok: problems.length === 0, problems };
}
