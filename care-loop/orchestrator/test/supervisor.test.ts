// supervisor.test.ts — claim, spawn, cap, reconcile, cancel ([[PLAN-loop-service]] §5, step 4).
//
// Every test drives a FAKE spawn port. The supervisor's job is to turn rows into children and
// children's exits back into rows; whether `care-loopd run` works is the rest of the suite's problem,
// and forking real loops here would buy nothing but minutes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunStore } from "../src/run-store.ts";
import { QueueStore, type QueueRow } from "../src/service/queue.ts";
import {
  Supervisor,
  childArgv,
  childEnv,
  type SpawnRequest,
  type SupervisedChild,
} from "../src/service/supervisor.ts";

interface FakeChild extends SupervisedChild {
  req: SpawnRequest;
  signals: NodeJS.Signals[];
  exit(code: number | null, signal?: NodeJS.Signals | null): void;
}

/** A child that never exits until a test says so, and records what it was signalled with. */
function fakeSpawner(): { spawn: (r: SpawnRequest) => SupervisedChild; children: FakeChild[] } {
  const children: FakeChild[] = [];
  let nextPid = 4000;
  return {
    children,
    spawn: (req) => {
      let onExit: ((c: number | null, s: NodeJS.Signals | null) => void) | null = null;
      const child: FakeChild = {
        req,
        pid: nextPid++,
        signals: [],
        kill(sig) {
          child.signals.push(sig ?? "SIGTERM");
          return true;
        },
        once(_event, cb) {
          onExit = cb;
          return child;
        },
        exit(code, signal = null) {
          onExit?.(code, signal);
        },
      };
      children.push(child);
      return child;
    },
  };
}

function fixture(): { queue: QueueStore; runsDir: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "care-sup-"));
  const store = new SqliteRunStore(join(dir, "loops.db"));
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { queue: new QueueStore(db), runsDir: dir, db };
}

const REQ = {
  requestedBy: "octocat",
  repo: "ohcnetwork/care_fe",
  branch: "feat-a",
  task: "do the thing",
  ticket: "ENG-1",
  summary: "the thing",
};

/** Plant a lockfile the way a running orchestrator would. */
function plantLock(runsDir: string, slug: string, pid: number): void {
  const dir = join(runsDir, slug, ".orchestrator.lock");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pid"), `${pid}\n`);
}

test("the child's argv is the command a human would type — no queue, no db", () => {
  const row = { ...REQ, id: 1, runId: "01ABC", status: "running" } as QueueRow;
  const argv = childArgv(row, "/runs/care_fe-feat-a", { mainRepoPath: "/src/care_fe" });

  assert.equal(argv[0], "run");
  for (const [flag, value] of [
    ["--repo", REQ.repo],
    ["--branch", REQ.branch],
    ["--task", REQ.task],
    ["--ticket", REQ.ticket],
    ["--summary", REQ.summary],
    ["--run-dir", "/runs/care_fe-feat-a"],
    ["--requested-by", "octocat"],
    ["--main", "/src/care_fe"],
  ] as const) {
    const i = argv.indexOf(flag);
    assert.ok(i >= 0, `${flag} is missing`);
    assert.equal(argv[i + 1], value);
  }
  // All four seed fields as flags is what makes the child NON-interactive: a missing one would put it
  // in the questionnaire, which on a spawned child with no TTY is an error, not a prompt.
  assert.equal(argv.includes("--queue"), false, "the child never learns a queue exists");
});

test("the child adopts the service's run id and never opens a self-improvement PR", () => {
  const row = { ...REQ, id: 1, runId: "01ABC", status: "running" } as QueueRow;
  const env = childEnv(row, { GITHUB_TOKEN: "t" });

  // The whole reason POST /api/runs can answer synchronously (§4).
  assert.equal(env.CARE_RUN_ID, "01ABC");
  // The end-of-run doctor opens PRs against the SKILLS repo — a deliberate local action, not a side
  // effect of every teammate's run (§5).
  assert.equal(env.CARE_DOCTOR, "0");
  assert.equal(env.GITHUB_TOKEN, "t");
});

test("claims up to the concurrency cap and no further", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  for (const branch of ["a", "b", "c"]) queue.enqueue({ ...REQ, branch });

  const sup = new Supervisor({ queue, runsDir, concurrency: 2, spawn, log: () => {} });
  sup.start();

  assert.equal(children.length, 2, "the cap is a real resource limit, not a formality");
  assert.equal(sup.activeCount, 2);
  assert.equal(queue.count({ status: ["pending"] }), 1);

  // A slot frees on exit and is claimed immediately, rather than waiting out the poll interval.
  children[0].exit(0);
  assert.equal(children.length, 3);
  assert.equal(queue.count({ status: ["pending"] }), 0);
  sup.stop();
});

test("a clean exit is done; a crash is failed — and neither is the loop's outcome", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  const ok = queue.enqueue({ ...REQ, branch: "a" });
  const bad = queue.enqueue({ ...REQ, branch: "b" });

  const sup = new Supervisor({ queue, runsDir, concurrency: 2, spawn, log: () => {} });
  sup.start();
  children[0].exit(0);
  children[1].exit(1);

  assert.equal(queue.byRunId(ok.runId)?.status, "done");
  const failed = queue.byRunId(bad.runId)!;
  assert.equal(failed.status, "failed");
  // `failed` is a SUPERVISION failure. Whether the loop merged or aborted lives in runs.step (§4).
  assert.match(failed.error!, /exited 1/);
  assert.equal(sup.activeCount, 0);
  sup.stop();
});

test("a spawn that throws marks the row failed instead of leaving a claim nobody holds", () => {
  const { queue, runsDir } = fixture();
  const row = queue.enqueue(REQ);
  const sup = new Supervisor({
    queue,
    runsDir,
    spawn: () => {
      throw new Error("ENOENT: no care-loopd");
    },
    log: () => {},
  });
  sup.start();

  // The claim commits BEFORE the spawn is attempted, so a throw here would otherwise leave exactly
  // the `running` lie reconcile exists to clean up — hours later, instead of now.
  const after = queue.byRunId(row.runId)!;
  assert.equal(after.status, "failed");
  assert.match(after.error!, /spawn failed/);
  assert.equal(sup.activeCount, 0);
  sup.stop();
});

test("a branch locked by a CLI run defers the claim instead of poisoning it", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  const blocked = queue.enqueue({ ...REQ, branch: "feat-a" });
  const free = queue.enqueue({ ...REQ, branch: "feat-b" });
  // Someone ran `care-loopd run --branch feat-a` from a terminal. It has NO queue row, so the queue
  // table alone cannot see it — but it holds the very same lockfile, because the run dir is derived
  // from ${repo}-${branch} and is therefore the same directory.
  plantLock(runsDir, "care_fe-feat-a", 9931);

  const sup = new Supervisor({
    queue,
    runsDir,
    concurrency: 2,
    spawn,
    isAlive: (pid) => pid === 9931,
    log: () => {},
  });
  sup.start();

  assert.equal(children.length, 1, "only the unlocked branch was claimed");
  assert.equal(children[0].req.row.branch, "feat-b");
  // Deferred, NOT failed: it becomes claimable the moment the terminal run finishes. Without this the
  // child spawns, sets up a worktree, and dies in withLock minutes later as a "spawn failure".
  assert.equal(queue.byRunId(blocked.runId)?.status, "pending");
  assert.equal(queue.byRunId(free.runId)?.status, "running");
  sup.stop();
});

test("a locked branch with a DEAD holder is claimable — a stale lock is not a live run", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  queue.enqueue(REQ);
  plantLock(runsDir, "care_fe-feat-a", 9931);

  const sup = new Supervisor({ queue, runsDir, spawn, isAlive: () => false, log: () => {} });
  sup.start();
  assert.equal(children.length, 1, "the holder is gone; the lock is debris");
  sup.stop();
});

test("a branch with fifty queued rows cannot starve every branch behind it", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  for (let i = 0; i < 50; i++) queue.enqueue({ ...REQ, branch: "feat-a", ticket: `ENG-${i}` });
  queue.enqueue({ ...REQ, branch: "feat-z" });
  plantLock(runsDir, "care_fe-feat-a", 9931);

  const sup = new Supervisor({
    queue,
    runsDir,
    concurrency: 1,
    spawn,
    isAlive: (pid) => pid === 9931,
    log: () => {},
  });
  sup.start();

  // The candidate query returns the oldest pending row PER BRANCH, so fifty blocked rows occupy one
  // slot in the scan window rather than all of it.
  assert.equal(children.length, 1);
  assert.equal(children[0].req.row.branch, "feat-z");
  sup.stop();
});

test("boot reconciles the running rows a dead supervisor left behind", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  const survived = queue.enqueue({ ...REQ, branch: "alive" });
  const crashed = queue.enqueue({ ...REQ, branch: "dead" });
  queue.claim();
  queue.claim();
  assert.equal(queue.count({ status: ["running"] }), 2, "two claims nobody holds");

  // Ground truth is the lockfile, not the row: the child on `alive` outlived the service.
  plantLock(runsDir, "care_fe-alive", 7001);

  const sup = new Supervisor({
    queue,
    runsDir,
    concurrency: 2,
    spawn,
    isAlive: (pid) => pid === 7001,
    log: () => {},
  });
  sup.start();

  // Re-adopted, NOT restarted — killing a teammate's surviving run on every service restart would be
  // a far worse failure than a few unsupervised minutes.
  assert.equal(queue.byRunId(survived.runId)?.status, "running");
  assert.equal(sup.snapshot().find((r) => r.runId === survived.runId)?.pid, 7001);

  // The crashed one went back to pending and was re-claimed by the same boot — with the SAME run id
  // onto the SAME run dir, which run-context adopts rather than rebinds.
  const respawned = children.find((c) => c.req.row.runId === crashed.runId);
  assert.ok(respawned, "the orphan was re-spawned");
  assert.equal(respawned!.req.env.CARE_RUN_ID, crashed.runId);
  assert.equal(queue.byRunId(crashed.runId)?.attempts, 2, "attempts counts claims, and is not reset");
  sup.stop();
});

test("a re-adopted child that exits is closed out — the lock says whether it was clean", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  const clean = queue.enqueue({ ...REQ, branch: "clean" });
  const died = queue.enqueue({ ...REQ, branch: "died" });
  queue.claim();
  queue.claim();
  plantLock(runsDir, "care_fe-clean", 7001);
  plantLock(runsDir, "care_fe-died", 7002);

  const alive = new Set([7001, 7002]);
  const sup = new Supervisor({
    queue,
    runsDir,
    concurrency: 2,
    spawn,
    isAlive: (pid) => alive.has(pid),
    log: () => {},
  });
  sup.start();
  assert.equal(sup.activeCount, 2, "both re-adopted");
  assert.equal(children.length, 0);

  // `clean` unwinds: withLock's finally removes the lock dir, then the process goes.
  rmSync(join(runsDir, "care_fe-clean", ".orchestrator.lock"), { recursive: true });
  alive.delete(7001);
  // `died` is killed where it stands, leaving its lock behind with a dead pid inside.
  alive.delete(7002);

  // There is no exit EVENT for a process we did not fork, so without the sweep both rows stay
  // `running` until the next restart — and both slots stay spent against the cap forever.
  sup.tick();
  assert.equal(queue.byRunId(clean.runId)?.status, "done");
  const failed = queue.byRunId(died.runId)!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /died holding its lock/);
  assert.equal(sup.activeCount, 0, "the slots came back");
  sup.stop();
});

test("stop() leaves the children running — a service restart is not a fleet-wide abort", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  queue.enqueue(REQ);
  const sup = new Supervisor({ queue, runsDir, spawn, log: () => {} });
  sup.start();
  sup.stop();

  assert.equal(sup.running, false);
  assert.deepEqual(children[0].signals, [], "no signal was sent");
  // And enqueue is gated on `running`, so the API reports the real reason rather than banking rows.
  assert.equal(sup.tick(), 0, "a stopped supervisor claims nothing");
});

test("cancel writes the row first and signals second", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  const row = queue.enqueue(REQ);
  const sup = new Supervisor({ queue, runsDir, spawn, killGraceMs: 50, log: () => {} });
  sup.start();

  const result = sup.cancel(row.runId);
  assert.deepEqual(result, { cancelled: true, signalled: true });
  // The status write is what the caller's 202 means. Killing is best-effort: a lost signal or an
  // already-dead process still leaves the row correct.
  assert.equal(queue.byRunId(row.runId)?.status, "cancelled");
  assert.deepEqual(children[0].signals, ["SIGTERM"]);

  // The child exits because it was cancelled — that is not a second outcome to record.
  children[0].exit(143, "SIGTERM");
  assert.equal(queue.byRunId(row.runId)?.status, "cancelled", "not overwritten with failed");
  assert.equal(sup.activeCount, 0);
  sup.stop();
});

test("cancelling a pending row needs no process, and a finished row cannot be un-run", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  const pending = queue.enqueue(REQ);
  // Never started: no supervisor is claiming.
  const sup = new Supervisor({ queue, runsDir, spawn, log: () => {} });

  assert.deepEqual(sup.cancel(pending.runId), { cancelled: true, signalled: false });
  assert.equal(queue.byRunId(pending.runId)?.status, "cancelled");
  assert.equal(children.length, 0);

  assert.deepEqual(sup.cancel(pending.runId), { cancelled: false, signalled: false });
  assert.deepEqual(sup.cancel("01NOSUCHRUN"), { cancelled: false, signalled: false });
});

test("a child that ignores SIGTERM is escalated to SIGKILL after the grace period", async () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  const row = queue.enqueue(REQ);
  const sup = new Supervisor({ queue, runsDir, spawn, killGraceMs: 10, log: () => {} });
  sup.start();
  sup.cancel(row.runId);

  // SIGTERM lets the child finish its journal write and release its lock; the realistic hang is a
  // child wedged inside a model call, which will not notice.
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  sup.stop();
});

test("a cancelled run is a resumable one — the same run id, the same dir, on the next claim", () => {
  const { queue, runsDir } = fixture();
  const { spawn, children } = fakeSpawner();
  const row = queue.enqueue(REQ);
  const sup = new Supervisor({ queue, runsDir, spawn, log: () => {} });
  sup.start();

  const runDir = sup.runDirFor(queue.byRunId(row.runId)!);
  assert.equal(children[0].req.runDir, runDir);
  // The run dir is derived from ${repo}-${branch} by the SAME rule the CLI uses (runSlug), which is
  // what makes the lock the service inspects the lock the child will take.
  assert.match(runDir, /care_fe-feat-a$/);
  sup.stop();
});
