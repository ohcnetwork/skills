// test/backup.test.ts — snapshots and the boot integrity check ([[PLAN-loop-service]] §12).
//
// These land with the queue for a reason: until `queue` existed, losing loops.db cost nothing —
// `reindex` rebuilt every row from the journals. A pending request has no journal behind it, so this
// is the first data a rebuild cannot recover, and backups stop being tidiness.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunStore } from "../src/run-store.ts";
import { QueueStore } from "../src/service/queue.ts";
import { backupNow, integrityCheck, listBackups, prune } from "../src/service/backup.ts";

function liveDb(): { store: SqliteRunStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-backup-"));
  return { store: new SqliteRunStore(join(dir, "loops.db")), dir };
}

test("a snapshot restores the data a reindex could NOT rebuild", () => {
  const { store, dir } = liveDb();
  const q = new QueueStore(store.raw());
  const row = q.enqueue({
    requestedBy: "octocat",
    repo: "ohcnetwork/care_fe",
    branch: "feat-a",
    task: "t",
    ticket: "ENG-1",
    summary: "s",
  });

  const path = backupNow(store.raw(), { dir: join(dir, "backups") });
  store.close();

  // Open the snapshot as its own database: the queue row is there, which is the whole point.
  const restored = new QueueStore(new DatabaseSync(path, { readOnly: true }));
  assert.equal(restored.byRunId(row.runId)?.status, "pending");
});

test("VACUUM INTO snapshots a database that is being written to", () => {
  const { store, dir } = liveDb();
  const q = new QueueStore(store.raw());
  q.enqueue({ requestedBy: "a", repo: "r", branch: "b1", task: "t", ticket: "ENG-1", summary: "s" });
  // Snapshot with the connection open and more writes following — copying the file here could catch
  // a torn page or miss the WAL entirely.
  const path = backupNow(store.raw(), { dir: join(dir, "backups") });
  q.enqueue({ requestedBy: "a", repo: "r", branch: "b2", task: "t", ticket: "ENG-2", summary: "s" });

  const snap = new QueueStore(new DatabaseSync(path, { readOnly: true }));
  assert.equal(snap.list().length, 1, "the snapshot is consistent as of when it was taken");
  assert.equal(q.list().length, 2, "and the live db carried on");
});

test("pruning keeps the newest N by their timestamped names", () => {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-prune-"));
  // Written out of order on purpose: ordering must come from the ISO stamp in the name, not mtime,
  // which a copy or a restore would rewrite.
  for (const stamp of ["2026-08-03", "2026-08-01", "2026-08-05", "2026-08-02", "2026-08-04"])
    writeFileSync(join(dir, `loops-${stamp}.db`), "x");
  writeFileSync(join(dir, "unrelated.txt"), "x");

  prune(dir, 2);
  const left = readdirSync(dir).sort();
  assert.deepEqual(left, ["loops-2026-08-04.db", "loops-2026-08-05.db", "unrelated.txt"]);
});

test("backupNow prunes as it goes, so snapshots cannot grow without bound", () => {
  const { store, dir } = liveDb();
  const backups = join(dir, "backups");
  for (let i = 1; i <= 4; i++)
    backupNow(store.raw(), { dir: backups, keep: 2 }, new Date(`2026-08-0${i}T00:00:00Z`));
  assert.equal(listBackups(backups).length, 2);
});

test("integrityCheck passes on a healthy db and reports problems without throwing", () => {
  const { store } = liveDb();
  assert.deepEqual(integrityCheck(store.raw()), { ok: true, problems: [] });
});

test("listBackups ignores files that are not snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-list-"));
  writeFileSync(join(dir, "loops-2026-08-01.db"), "x");
  writeFileSync(join(dir, "notes.md"), "x");
  writeFileSync(join(dir, "loops.db"), "x");
  assert.deepEqual(
    listBackups(dir).map((b) => b.path.split("/").pop()),
    ["loops-2026-08-01.db"],
  );
});
