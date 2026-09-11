// Turns queue rows into child processes and their exits back into rows. The only part of the service
// that starts a process.
//
// The child never sees the queue — it gets a run dir, seed flags, and CARE_RUN_ID, exactly what a
// human types at a terminal. That is why a run can be debugged by re-running the command by hand,
// and why cancellation is a signal rather than a flag the child polls: loopd is crash-only with
// journal-backed resume, so a terminated child is a resumable run.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultIsAlive, inspectLock } from "../lock.js";
import { runSlug } from "../front-terminal.js";
import type { QueueRow, QueueStore } from "./queue.js";
import type { GateStore } from "./gate-store.js";

/** "Not done, nothing wrong" — the child parked at a human gate and exited so its slot could go to
 *  someone else. An exit code because it is the only channel to the supervisor that does not require
 *  the child to know a queue exists; `EX_TEMPFAIL` from sysexits. */
export const EXIT_GATE_SUSPENDED = 75;

/** The entire seam a test has to fake, which is why it is this narrow. */
export interface SupervisedChild {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface SpawnRequest {
  runId: string;
  runDir: string;
  row: QueueRow;
  argv: string[];
  env: Record<string, string>;
}

/** The process seam. Defaults to `child_process.spawn` of `bin/care-loopd.mjs`. */
export type SpawnPort = (req: SpawnRequest) => SupervisedChild;

export interface SupervisorOptions {
  queue: QueueStore;
  /** Without it, cancelling a gate-parked run falls back to SIGTERM — which works, but leaves the
   *  lockfile behind and writes no `run.end`. */
  gates?: GateStore;
  /** Must match the `--run-dir` the child is given, hence `runSlug` shared with `derivePaths`. */
  runsDir: string;
  /** Each run is a worktree plus an opencode session plus Copilot credits, so this is a real
   *  resource limit rather than a formality. */
  concurrency?: number;
  /** A safety net: the queue is also poked on enqueue and on every child exit. */
  pollMs?: number;
  killGraceMs?: number;
  /** Grace for a gate-parked child to notice a revoked ask and unwind on its own. Must comfortably
   *  exceed the child's gate poll interval. */
  gateGraceMs?: number;
  spawn?: SpawnPort;
  /** Injected for tests. */
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  log?: (msg: string) => void;
  /** Extra environment for every child — credentials, `CARE_*` config. */
  env?: Record<string, string>;
  /** Path to `bin/care-loopd.mjs`. Defaults to this package's own. */
  binPath?: string;
  /** Path to the main checkout that worktrees branch from (`--main`). */
  mainRepoPath?: string;
}

export interface SupervisedRun {
  queueId: number;
  runId: string;
  pid: number | null;
  runDir: string;
  startedAt: string;
  /** Suppresses the "child failed" reading of the non-zero exit a signal produces. */
  cancelling: boolean;
  /** Null for a run re-adopted after a restart: there is no handle for a process we did not fork. */
  child: SupervisedChild | null;
  killTimer?: NodeJS.Timeout;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BIN = resolve(HERE, "../../bin/care-loopd.mjs");

/** Pure, so the service/CLI contract is unit-testable without spawning anything. */
export function childArgv(row: QueueRow, runDir: string, opts: { mainRepoPath?: string } = {}): string[] {
  const argv = [
    "run",
    "--repo", row.repo,
    "--branch", row.branch,
    "--task", row.task,
    "--ticket", row.ticket,
    "--summary", row.summary,
    "--run-dir", runDir,
    "--requested-by", row.requestedBy,
    // Without this the child prints its approval prompt to an ignored stdin and fails.
    "--gate", "service",
  ];
  if (opts.mainRepoPath) argv.push("--main", opts.mainRepoPath);
  return argv;
}

/** `CARE_RUN_ID` is minted at enqueue and adopted here, which is what lets `POST /api/runs` answer
 *  synchronously. `CARE_DOCTOR=0` keeps the end-of-run doctor's self-improvement PRs a deliberate
 *  local action rather than a side effect of every teammate's run. */
export function childEnv(row: QueueRow, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    CARE_RUN_ID: row.runId,
    CARE_DOCTOR: "0",
    CARE_REQUESTED_BY: row.requestedBy,
  };
}

export class Supervisor {
  private readonly o: Required<
    Pick<
      SupervisorOptions,
      "queue" | "runsDir" | "concurrency" | "pollMs" | "killGraceMs" | "gateGraceMs"
    >
  > &
    SupervisorOptions;
  private readonly active = new Map<number, SupervisedRun>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(options: SupervisorOptions) {
    this.o = {
      concurrency: options.concurrency ?? 2,
      pollMs: options.pollMs ?? 2_000,
      killGraceMs: options.killGraceMs ?? 30_000,
      gateGraceMs: options.gateGraceMs ?? 10_000,
      ...options,
      queue: options.queue,
      runsDir: options.runsDir,
    };
  }

  /** `POST /api/runs` refuses while this is false: a queue with no consumer is a black hole the
   *  caller cannot tell apart from a slow start. */
  get running(): boolean {
    return this.started;
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** In-memory only: the queue row is the durable copy, and `reconcile` rebuilds this from the rows
   *  plus the lockfiles. */
  snapshot(): SupervisedRun[] {
    return [...this.active.values()];
  }

  private log(msg: string): void {
    (this.o.log ?? ((m: string) => console.log(m)))(`[supervisor] ${msg}`);
  }

  runDirFor(row: QueueRow): string {
    return join(this.o.runsDir, runSlug(row.repo, row.branch));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.reconcile();
    this.timer = setInterval(() => this.tick(), this.o.pollMs);
    this.timer.unref();
    this.tick();
  }

  /** Stops supervising WITHOUT killing the children — a service restart must not abort every
   *  teammate's run. They hold their own locks and journals, and `reconcile` re-adopts them. */
  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A `running` row is a claim on a process that may not exist; the lockfile is the ground truth.
   * A live holder is re-adopted, anything else goes back to `pending`.
   *
   * Returning to `pending` rather than resuming in place keeps one code path: the claim/spawn cycle
   * re-runs the row with the same `CARE_RUN_ID` onto the same run dir, and `run-context` adopts that
   * id rather than rebinding it. A dedicated resume path would only ever execute after a crash,
   * which is the least-tested kind there is.
   */
  reconcile(): { adopted: number; released: number } {
    let adopted = 0;
    let released = 0;
    for (const row of this.o.queue.orphaned()) {
      if (this.active.has(row.id)) continue;
      const runDir = this.runDirFor(row);
      const lock = inspectLock(runDir, this.lockOptions);
      if (lock.held && lock.alive) {
        this.active.set(row.id, {
          queueId: row.id,
          runId: row.runId,
          pid: lock.pid,
          runDir,
          startedAt: row.startedAt ?? this.nowIso(),
          cancelling: false,
          child: null,
        });
        adopted++;
        this.log(`re-adopted ${row.runId} (pid ${lock.pid})`);
      } else if (this.o.queue.release(row.id)) {
        released++;
        this.log(`released ${row.runId} back to pending (no live child)`);
      }
    }
    if (adopted || released) this.log(`reconciled: ${adopted} adopted, ${released} released`);
    return { adopted, released };
  }

  private nowIso(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  private get lockOptions(): { isAlive?: (pid: number) => boolean } {
    return this.o.isAlive ? { isAlive: this.o.isAlive } : {};
  }

  /**
   * Consulted inside the claim transaction. The queue knows nothing about a run launched from a
   * terminal on the same branch, which holds the very same lockfile because the run dir derives from
   * `${repo}-${branch}`. Without this check, claiming that row spawns a child that dies in
   * `withLock` minutes later and is reported as a spawn failure rather than as "not yet".
   */
  private startable = (row: QueueRow): boolean => {
    const lock = inspectLock(this.runDirFor(row), this.lockOptions);
    if (lock.held && lock.alive) {
      this.log(`deferring ${row.runId}: ${row.repo}#${row.branch} is locked by pid ${lock.pid}`);
      return false;
    }
    return true;
  };

  /**
   * Closes out re-adopted runs whose process has gone. A spawned child reports its own exit; a
   * re-adopted one cannot, so without this sweep its row stays `running` and its slot stays occupied
   * against the cap forever.
   *
   * The exit code is unrecoverable but the outcome is not: the child holds its lock for the whole run
   * and releases it in `withLock`'s finally, so a lock left behind means it died where it stood.
   */
  private sweepAdopted(): void {
    for (const entry of [...this.active.values()]) {
      if (entry.child !== null) continue; // its own exit event will fire
      const isAlive = this.o.isAlive ?? defaultIsAlive;
      if (entry.pid !== null && isAlive(entry.pid)) continue;
      this.active.delete(entry.queueId);
      const current = this.o.queue.byRunId(entry.runId);
      if (entry.cancelling || current?.status === "cancelled") {
        this.log(`${entry.runId} (adopted) exited after cancel`);
        continue;
      }
      const lock = inspectLock(entry.runDir, this.lockOptions);
      if (lock.held) {
        this.o.queue.finish(entry.queueId, "failed", `adopted child (pid ${entry.pid}) died holding its lock`, this.o.now?.());
        this.log(`${entry.runId} (adopted) died mid-run`);
      } else {
        this.o.queue.finish(entry.queueId, "done", null, this.o.now?.());
        this.log(`${entry.runId} (adopted) finished`);
      }
    }
  }

  /** Claim and spawn until the cap is reached or nothing is claimable. */
  tick(): number {
    if (!this.started) return 0;
    this.sweepAdopted();
    let spawned = 0;
    while (this.active.size < this.o.concurrency) {
      let row: QueueRow | null;
      try {
        row = this.o.queue.claim({ now: this.o.now?.(), startable: this.startable });
      } catch (err) {
        // A database problem, not a run problem: nothing was claimed, so there is no row to fail.
        this.log(`claim failed: ${String(err)}`);
        return spawned;
      }
      if (!row) break;
      this.launch(row);
      spawned++;
    }
    return spawned;
  }

  private launch(row: QueueRow): void {
    const runDir = this.runDirFor(row);
    try {
      mkdirSync(runDir, { recursive: true });
      const argv = childArgv(row, runDir, { mainRepoPath: this.o.mainRepoPath });
      const child = (this.o.spawn ?? defaultSpawn(this.o.binPath ?? DEFAULT_BIN))({
        runId: row.runId,
        runDir,
        row,
        argv,
        env: childEnv(row, this.o.env ?? {}),
      });
      const entry: SupervisedRun = {
        queueId: row.id,
        runId: row.runId,
        pid: child.pid ?? null,
        runDir,
        startedAt: row.startedAt ?? this.nowIso(),
        cancelling: false,
        child,
      };
      this.active.set(row.id, entry);
      this.log(`spawned ${row.runId} (pid ${entry.pid}) for ${row.repo}#${row.branch}`);
      child.once("exit", (code, signal) => this.onExit(entry, code, signal));
    } catch (err) {
      // The claim committed before the spawn was attempted, so the row is already `running`. Write
      // the failure now, while the reason is still in hand.
      this.active.delete(row.id);
      this.o.queue.finish(row.id, "failed", `spawn failed: ${String(err)}`, this.o.now?.());
      this.log(`spawn failed for ${row.runId}: ${String(err)}`);
    }
  }

  private onExit(entry: SupervisedRun, code: number | null, signal: NodeJS.Signals | null): void {
    this.active.delete(entry.queueId);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    const current = this.o.queue.byRunId(entry.runId);
    // Cancel already wrote the terminal status; this exit is its consequence, not a second outcome.
    if (entry.cancelling || current?.status === "cancelled") {
      this.log(`${entry.runId} exited after cancel (code ${code}, signal ${signal})`);
    } else if (code === EXIT_GATE_SUSPENDED) {
      // Live but not claimable until answered — what keeps a cap of 2 from being exhausted by two
      // people who went home.
      this.o.queue.suspend(entry.queueId);
      this.log(`${entry.runId} suspended at a gate — slot released`);
    } else if (code === 0) {
      this.o.queue.finish(entry.queueId, "done", null, this.o.now?.());
      this.log(`${entry.runId} finished`);
    } else {
      // A SUPERVISION failure — the child did not exit cleanly. Whether the loop merged, aborted, or
      // stalled is `runs.step`'s answer to a different question, and stays there.
      const why = signal ? `killed by ${signal}` : `exited ${code}`;
      this.o.queue.finish(entry.queueId, "failed", why, this.o.now?.());
      this.log(`${entry.runId} ${why}`);
    }
    this.tick(); // a slot just freed — claim into it rather than waiting out the poll interval
  }

  /**
   * Handles every state a run can be caught in, because the frontend is the layer least able to
   * distinguish `pending` from `running` without racing.
   *
   * The status write comes first and is what the caller's 202 means. Killing the child is
   * best-effort: if the signal is lost the row is still correct, and `reconcile` will not resurrect
   * a row that is no longer `running`.
   */
  cancel(runId: string): { cancelled: boolean; signalled: boolean } {
    const row = this.o.queue.byRunId(runId);
    if (!row) return { cancelled: false, signalled: false };
    const cancelled = this.o.queue.cancel(runId, this.o.now?.());
    if (!cancelled) return { cancelled: false, signalled: false };

    // First, whether or not a process is alive: for a suspended run this IS the cancellation, and
    // for a live one it must precede the signal so a child that notices can unwind normally.
    const revoked = this.o.gates?.cancel(runId, this.o.now?.()) ?? 0;

    const entry = this.active.get(row.id);
    if (!entry) {
      this.log(
        `cancelled ${runId} (${row.status} — no process${revoked ? `, ${revoked} gate ask revoked` : ""})`,
      );
      return { cancelled: true, signalled: false };
    }
    entry.cancelling = true;

    // A gate-parked child is polling the row we just wrote, so give it a moment: a cooperative exit
    // releases the lock and writes `run.end`, where a signal skips the `finally` and leaves the last
    // journal event a question nobody answers. An unparked child has nothing to notice and waits not.
    if (revoked > 0) {
      this.log(`cancelled ${runId} — revoked ${revoked} gate ask, waiting ${this.o.gateGraceMs}ms`);
      entry.killTimer = setTimeout(() => {
        if (this.active.has(entry.queueId)) {
          this.log(`${runId} did not unwind cooperatively — SIGTERM`);
          this.escalate(entry);
        }
      }, this.o.gateGraceMs);
      entry.killTimer.unref?.();
      return { cancelled: true, signalled: false };
    }

    const signalled = this.escalate(entry);
    this.log(`cancelled ${runId} (running — SIGTERM sent to pid ${entry.pid})`);
    return { cancelled: true, signalled };
  }

  /** SIGTERM lets the child finish its journal write and release its lock; the SIGKILL after the
   *  grace period is for one wedged inside a model call. A killed run stays resumable. */
  private escalate(entry: SupervisedRun): boolean {
    const signalled = this.signal(entry, "SIGTERM");
    entry.killTimer = setTimeout(() => {
      if (this.active.has(entry.queueId)) {
        this.log(`${entry.runId} did not exit in ${this.o.killGraceMs}ms — SIGKILL`);
        this.signal(entry, "SIGKILL");
      }
    }, this.o.killGraceMs);
    entry.killTimer.unref?.();
    return signalled;
  }

  /** Handles both a child we spawned and one we re-adopted (pid only). */
  private signal(entry: SupervisedRun, sig: NodeJS.Signals): boolean {
    try {
      if (entry.child) return entry.child.kill(sig);
      if (entry.pid !== null) {
        process.kill(entry.pid, sig);
        return true;
      }
    } catch (err) {
      this.log(`signal ${sig} to ${entry.runId} failed: ${String(err)}`);
    }
    return false;
  }
}

/** This package's own `bin/care-loopd.mjs`, under the current node. */
function defaultSpawn(binPath: string): SpawnPort {
  return (req) => {
    if (!existsSync(binPath)) throw new Error(`care-loopd binary not found at ${binPath}`);
    const child: ChildProcess = nodeSpawn(process.execPath, [binPath, ...req.argv], {
      cwd: req.runDir,
      env: { ...process.env, ...req.env },
      // Every seed field arrives as a flag and the gate is answered over HTTP, so there is nothing
      // to read. Inheriting a non-TTY pipe instead would hang any prompt forever.
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
    });
    return child;
  };
}
