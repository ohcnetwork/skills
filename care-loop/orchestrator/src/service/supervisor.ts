// service/supervisor.ts — claim, spawn, cap, reconcile, cancel ([[PLAN-loop-service]] §5, step 4).
//
// This is the only part of the service that starts a process. Everything above it (`app.ts`) writes
// rows; this turns rows into children and children's exits back into rows.
//
// **The child never sees the queue** (§4). It receives a run dir, four seed flags, and `CARE_RUN_ID`
// — exactly what a human types at a terminal — so the spawned binary is the binary you run locally,
// with no DB coupling to a service-owned table. That is a load-bearing property: it is why a run can
// be debugged by re-running the same command by hand, and why the child needs no schema knowledge.
//
// The consequence is that cancellation is a SIGNAL, not a flag the child polls. loopd is crash-only
// with journal-backed `resume`, so a terminated child is a resumable run, which is the same recovery
// path a power cut would take. One mechanism, already tested, instead of a second one.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultIsAlive, inspectLock } from "../lock.js";
import { runSlug } from "../front-terminal.js";
import type { QueueRow, QueueStore } from "./queue.js";

/** The subset of `ChildProcess` the supervisor uses. Narrow on purpose: it is the entire seam a test
 *  has to fake, and it keeps the tests free of real processes. */
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
  /** Where run directories live. Must match the `--run-dir` the child is given, and therefore the
   *  same `${repo}-${branch}` convention `derivePaths` uses — hence `runSlug`, shared with it. */
  runsDir: string;
  /** Max children at once. Each run is a worktree plus an opencode session plus Copilot credits, so
   *  this is a real resource limit rather than a formality (§5). */
  concurrency?: number;
  /** How often to look for claimable work. The queue is also poked on enqueue and on every child
   *  exit, so this is a safety net, not the primary trigger. */
  pollMs?: number;
  /** Grace between `SIGTERM` and `SIGKILL` on cancel. */
  killGraceMs?: number;
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
  /** Set once cancel has signalled; suppresses the "child failed" reading of a non-zero exit. */
  cancelling: boolean;
  child: SupervisedChild | null;
  /** Pending SIGKILL escalation, cleared when the child exits on its own. */
  killTimer?: NodeJS.Timeout;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BIN = resolve(HERE, "../../bin/care-loopd.mjs");

/**
 * The child's argv, as a pure function so the contract between service and CLI is unit-testable
 * without spawning anything. `run` (not `plan`/`start`) because the loop's own phase boundary is the
 * `plan.approved` journal event, not a CLI boundary — the service enqueues a *run*, and the human
 * gate inside it is answered over HTTP once step 5 lands the gate transport.
 */
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
  ];
  if (opts.mainRepoPath) argv.push("--main", opts.mainRepoPath);
  return argv;
}

/**
 * The child's environment.
 *
 * `CARE_RUN_ID` is the whole reason `POST /api/runs` can answer synchronously: the id is minted at
 * enqueue and the child adopts it instead of minting its own (§4).
 *
 * `CARE_DOCTOR=0` because the end-of-run doctor opens self-improvement PRs against the skills repo.
 * That should stay a deliberate local action, not a side effect of every teammate's run (§5).
 */
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
    Pick<SupervisorOptions, "queue" | "runsDir" | "concurrency" | "pollMs" | "killGraceMs">
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
      ...options,
      queue: options.queue,
      runsDir: options.runsDir,
    };
  }

  /** `app.ts` gates `POST /api/runs` on this: a queue with no consumer is a black hole the caller
   *  cannot tell apart from a slow start. */
  get running(): boolean {
    return this.started;
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** In-memory only, by design (§5): the queue row is the durable copy, so a restart loses the map
   *  and nothing else — `reconcile` rebuilds what matters from the rows plus the lockfiles. */
  snapshot(): SupervisedRun[] {
    return [...this.active.values()];
  }

  private log(msg: string): void {
    (this.o.log ?? ((m: string) => console.log(m)))(`[supervisor] ${msg}`);
  }

  runDirFor(row: QueueRow): string {
    return join(this.o.runsDir, runSlug(row.repo, row.branch));
  }

  /** Boot: reconcile the rows a dead supervisor left behind, then start claiming. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.reconcile();
    this.timer = setInterval(() => this.tick(), this.o.pollMs);
    this.timer.unref();
    this.tick();
  }

  /**
   * Stop supervising WITHOUT killing the children.
   *
   * Deliberate: a service restart should not abort every teammate's run. The children are independent
   * processes holding their own locks and journals, and `reconcile` re-adopts them on the way back up
   * — which is the §4 table's "child is alive → re-adopt the PID" row, and the reason it exists.
   */
  stop(): void {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * `running` rows are lies after a crash (§4). Each one is a claim on a process that may or may not
   * exist; the lockfile is the ground truth, not the row.
   *
   * | run_id | lock            | meaning                        | action           |
   * |--------|-----------------|--------------------------------|------------------|
   * | set    | held + alive    | child survived us              | re-adopt the pid |
   * | set    | held, dead pid  | child died mid-run             | back to pending  |
   * | set    | absent          | never spawned, or exited clean | back to pending  |
   *
   * The plan's third row said "resume it, stay running". Returning it to `pending` reaches the same
   * place through one path instead of two: the claim/spawn cycle re-runs it with the SAME
   * `CARE_RUN_ID` onto the same run dir, and `run-context` adopts rather than rebinds that id. What
   * the plan called resume is what a re-spawn already does, without a second code path that only ever
   * executes after a crash — the least-tested kind there is.
   */
  reconcile(): { adopted: number; released: number } {
    let adopted = 0;
    let released = 0;
    for (const row of this.o.queue.orphaned()) {
      if (this.active.has(row.id)) continue;
      const runDir = this.runDirFor(row);
      const lock = inspectLock(runDir, this.o.isAlive ? { isAlive: this.o.isAlive } : {});
      if (lock.held && lock.alive) {
        // Re-adopt: we cannot get a ChildProcess handle for a process we did not spawn, so the map
        // entry carries the pid and a null child. Cancel falls back to `process.kill(pid)`.
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

  /**
   * Can this row start right now? Consulted inside the claim transaction.
   *
   * The queue knows about runs the queue started. It knows nothing about a run someone launched from
   * a terminal on the same branch — which holds the very same lockfile, because the run dir is
   * derived from `${repo}-${branch}` and is therefore the same directory. Claiming such a row spawns
   * a child that dies in `withLock` minutes later, reported as a spawn failure. Checking the lock
   * turns that into "not yet", which is what it actually is.
   */
  private startable = (row: QueueRow): boolean => {
    const lock = inspectLock(this.runDirFor(row), this.o.isAlive ? { isAlive: this.o.isAlive } : {});
    if (lock.held && lock.alive) {
      this.log(`deferring ${row.runId}: ${row.repo}#${row.branch} is locked by pid ${lock.pid}`);
      return false;
    }
    return true;
  };

  /**
   * Close out re-adopted runs whose process has gone.
   *
   * A child we spawned reports its own exit. A child we merely re-adopted after a restart cannot —
   * there is no `ChildProcess` handle for a process you did not fork — so without this sweep its row
   * stays `running` until the next restart, and its slot stays occupied against the cap forever.
   *
   * The exit STATUS is recoverable even though the exit code is not: the child holds its lock for the
   * whole run and releases it in `withLock`'s finally. So a gone process that left no lock behind
   * unwound cleanly, and one whose lock is still sitting there died where it stood. That is exactly
   * the distinction `done` and `failed` are for.
   */
  private sweepAdopted(): void {
    for (const entry of [...this.active.values()]) {
      if (entry.child !== null) continue; // spawned here — its own exit event will fire
      const isAlive = this.o.isAlive ?? defaultIsAlive;
      if (entry.pid !== null && isAlive(entry.pid)) continue;
      this.active.delete(entry.queueId);
      const current = this.o.queue.byRunId(entry.runId);
      if (entry.cancelling || current?.status === "cancelled") {
        this.log(`${entry.runId} (adopted) exited after cancel`);
        continue;
      }
      const lock = inspectLock(entry.runDir, this.o.isAlive ? { isAlive: this.o.isAlive } : {});
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
        // A claim that throws is a database problem, not a run problem — nothing has been claimed, so
        // there is no row to mark failed. Log and let the next tick retry.
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
      // The row is already `running` — the claim committed before the spawn was attempted. Leaving it
      // there would be exactly the lie `reconcile` exists to clean up, so write the failure now, while
      // the reason is still in hand.
      this.active.delete(row.id);
      this.o.queue.finish(row.id, "failed", `spawn failed: ${String(err)}`, this.o.now?.());
      this.log(`spawn failed for ${row.runId}: ${String(err)}`);
    }
  }

  private onExit(entry: SupervisedRun, code: number | null, signal: NodeJS.Signals | null): void {
    this.active.delete(entry.queueId);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    const current = this.o.queue.byRunId(entry.runId);
    // Cancel already wrote the terminal status; a `SIGTERM`-shaped exit is the expected consequence
    // of it, not a second outcome to record.
    if (entry.cancelling || current?.status === "cancelled") {
      this.log(`${entry.runId} exited after cancel (code ${code}, signal ${signal})`);
    } else if (code === 0) {
      this.o.queue.finish(entry.queueId, "done", null, this.o.now?.());
      this.log(`${entry.runId} finished`);
    } else {
      // `failed` is a SUPERVISION failure — the child did not exit cleanly. Whether the loop merged,
      // aborted, or stalled lives in `runs.step` and stays there (§4): duplicating the loop's outcome
      // into the queue is the wide-table mistake, and the two answer different questions.
      const why = signal ? `killed by ${signal}` : `exited ${code}`;
      this.o.queue.finish(entry.queueId, "failed", why, this.o.now?.());
      this.log(`${entry.runId} ${why}`);
    }
    // A slot just freed. Claim into it now rather than waiting out the poll interval.
    this.tick();
  }

  /**
   * Cancel a run, whatever state it was caught in — one route, per §6, because the frontend is the
   * layer least able to distinguish `pending` from `running` without racing.
   *
   * The status write comes FIRST and is what the caller's 202 means. Killing the child is the
   * best-effort half: if the signal is lost or the process is already gone, the row is still correct,
   * and `reconcile` will not resurrect a row that is no longer `running`.
   */
  cancel(runId: string): { cancelled: boolean; signalled: boolean } {
    const row = this.o.queue.byRunId(runId);
    if (!row) return { cancelled: false, signalled: false };
    const cancelled = this.o.queue.cancel(runId, this.o.now?.());
    if (!cancelled) return { cancelled: false, signalled: false };

    const entry = this.active.get(row.id);
    if (!entry) {
      this.log(`cancelled ${runId} (pending — nothing to kill)`);
      return { cancelled: true, signalled: false };
    }
    entry.cancelling = true;
    const signalled = this.signal(entry, "SIGTERM");
    // SIGTERM lets the child finish its journal write and release its lock; SIGKILL after the grace
    // period is for a child wedged inside a model call, which is the realistic hang. A killed run is
    // a resumable one — that is what crash-only buys.
    entry.killTimer = setTimeout(() => {
      if (this.active.has(entry.queueId)) {
        this.log(`${runId} did not exit in ${this.o.killGraceMs}ms — SIGKILL`);
        this.signal(entry, "SIGKILL");
      }
    }, this.o.killGraceMs);
    entry.killTimer.unref?.();
    this.log(`cancelled ${runId} (running — SIGTERM sent to pid ${entry.pid})`);
    return { cancelled: true, signalled };
  }

  /** Signal a child we spawned (handle) or one we re-adopted after a restart (pid only). */
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

/** The real spawn: this package's own `bin/care-loopd.mjs`, under the current node. */
function defaultSpawn(binPath: string): SpawnPort {
  return (req) => {
    if (!existsSync(binPath)) throw new Error(`care-loopd binary not found at ${binPath}`);
    const child: ChildProcess = nodeSpawn(process.execPath, [binPath, ...req.argv], {
      cwd: req.runDir,
      env: { ...process.env, ...req.env },
      // The child is not interactive here — every seed field arrives as a flag, and the one human
      // gate is answered over HTTP (step 5). `ignore` on stdin is what makes that explicit: a
      // questionnaire prompt would otherwise hang forever on an inherited, non-TTY pipe.
      stdio: ["ignore", "inherit", "inherit"],
      detached: false,
    });
    return child;
  };
}
