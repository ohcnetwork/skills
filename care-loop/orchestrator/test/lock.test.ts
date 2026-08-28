import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, withLock, LockError } from "../src/lock.ts";

const rd = () => mkdtempSync(join(tmpdir(), "careloopd-lock-"));

test("acquire creates the lock dir with our pid", () => {
  const dir = rd();
  const lock = acquireLock(dir, { pid: 4242 });
  assert.ok(existsSync(join(dir, ".orchestrator.lock")));
  assert.equal(
    readFileSync(join(dir, ".orchestrator.lock", "pid"), "utf8").trim(),
    "4242",
  );
  lock.release();
  assert.equal(existsSync(join(dir, ".orchestrator.lock")), false);
});

test("a second acquire is REFUSED while the holder is alive", () => {
  const dir = rd();
  acquireLock(dir, { pid: 1001, isAlive: () => true });
  assert.throws(
    () => acquireLock(dir, { pid: 2002, isAlive: () => true }),
    LockError,
  );
});

test("a STALE lock (dead holder) is stolen", () => {
  const dir = rd();
  acquireLock(dir, { pid: 1001, isAlive: () => true }); // holder 1001
  // holder now "dead" → a new pid steals it
  const lock = acquireLock(dir, { pid: 3003, isAlive: () => false });
  assert.equal(
    readFileSync(join(dir, ".orchestrator.lock", "pid"), "utf8").trim(),
    "3003",
  );
  lock.release();
});

test("re-acquiring our own leftover lock succeeds (idempotent restart)", () => {
  const dir = rd();
  acquireLock(dir, { pid: 5005, isAlive: () => true });
  const again = acquireLock(dir, { pid: 5005, isAlive: () => true }); // same pid → steal our own
  assert.equal(again.pid, 5005);
  again.release();
});

test("withLock releases even when the body throws", async () => {
  const dir = rd();
  await assert.rejects(
    withLock(
      dir,
      async () => {
        throw new Error("boom");
      },
      { pid: 7007 },
    ),
    /boom/,
  );
  assert.equal(existsSync(join(dir, ".orchestrator.lock")), false); // released
  // and the run is lockable again afterwards
  acquireLock(dir, { pid: 8008, isAlive: () => true }).release();
});
