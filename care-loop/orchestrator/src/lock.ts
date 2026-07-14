// lock.ts — the per-run orchestrator lock (PLAN-orchestrator-architecture §1). Guarantees exactly
// ONE writer of a run's journal: a double `start`/`resume` on the same run dir can't corrupt it.
// Atomic `mkdir` is the mutex (same technique as pw-lock.sh); the holder's pid is recorded so a
// STALE lock (holder process dead) is safely stolen, while a live holder is refused.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class LockError extends Error {}

export interface Lock {
  dir: string;
  pid: number;
  release: () => void;
}

/** True if a process with this pid exists (signal 0 probes without killing). */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process (dead); EPERM = exists but not ours (alive).
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(pidFile: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the run lock. Throws LockError if held by a LIVE process; steals a stale lock (dead pid,
 * or our own leftover). `isAlive`/`pid` are injectable for tests.
 */
export function acquireLock(runDir: string, opts: { pid?: number; isAlive?: (pid: number) => boolean } = {}): Lock {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const dir = join(runDir, ".orchestrator.lock");
  const pidFile = join(dir, "pid");

  try {
    mkdirSync(dir); // atomic — fails with EEXIST if the lock is already held
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const holder = readPid(pidFile);
    if (holder !== null && holder !== pid && isAlive(holder)) {
      throw new LockError(`run is locked by live pid ${holder} (${dir}) — another orchestrator owns this run`);
    }
    // stale (dead holder, unreadable pid, or our own) → steal
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  }

  writeFileSync(pidFile, `${pid}\n`);
  return {
    dir,
    pid,
    release: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Run `fn` while holding the lock; always releases (even on throw). */
export async function withLock<T>(runDir: string, fn: (lock: Lock) => Promise<T>, opts?: { pid?: number; isAlive?: (pid: number) => boolean }): Promise<T> {
  const lock = acquireLock(runDir, opts);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
