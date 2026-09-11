// test/concurrency.test.ts — two writers, one database ([[PLAN-loop-service]] §10 "Concurrent
// writers": service and child writing under WAL with no SQLITE_BUSY escaping to either side).
//
// This exists because the property is NOT free. `busy_timeout` is a per-connection pragma that is not
// stored in the file, so a connection that skips it takes an immediate SQLITE_BUSY where a configured
// one would wait — and `journal_mode = WAL` IS stored, which is exactly what masked the bug: readers
// never contend, so a read-only service looked fine right up until it started writing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteRunStore, applyConnectionPragmas } from "../src/run-store.ts";
import { QueueStore } from "../src/service/queue.ts";
import { SessionStore } from "../src/service/auth.ts";
import { mintRunId } from "../src/run-id.ts";
import { validateState } from "../src/state.ts";

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "careloopd-concur-")), "loops.db");
}

test("every connection gets the per-connection pragmas, not just the one that ran the schema", () => {
  const p = dbPath();
  const child = new SqliteRunStore(p); // runs SCHEMA
  const service = new DatabaseSync(p); // does NOT — this is how serve.ts opens it
  applyConnectionPragmas(service);

  const busy = (db: DatabaseSync): number =>
    (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout;

  // The asymmetry this guards: without applyConnectionPragmas the service sits at 0 and fails
  // instantly on any contention, while the child waits 5s and appears healthy.
  assert.equal(busy(child.raw()), 5000);
  assert.equal(busy(service), 5000);
  child.close();
  service.close();
});

test("a bare connection really is unconfigured — the guard above is not vacuous", () => {
  const p = dbPath();
  new SqliteRunStore(p).close();
  const bare = new DatabaseSync(p);
  assert.equal(
    (bare.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
    0,
    "if this ever defaults to non-zero, the pragma helper is no longer load-bearing",
  );
  // WAL, by contrast, IS persisted — which is why it carried over and hid the problem.
  assert.equal(
    (bare.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
    "wal",
  );
  bare.close();
});

test("service and child interleave writes to one db without SQLITE_BUSY", () => {
  const p = dbPath();
  const child = new SqliteRunStore(p);
  const serviceDb = new DatabaseSync(p);
  applyConnectionPragmas(serviceDb);
  const queue = new QueueStore(serviceDb);
  const sessions = new SessionStore(serviceDb);

  // Interleaved on purpose: alternating writers through two connections is what actually exercises
  // the lock, where two sequential batches would not.
  for (let i = 0; i < 60; i++) {
    queue.enqueue({
      requestedBy: "svc",
      repo: "ohcnetwork/care_fe",
      branch: `b${i}`,
      task: "t",
      ticket: `ENG-${i}`,
      summary: "s",
    });
    sessions.login(`user${i % 5}`);

    const st = validateState({
      task: "t",
      repo: "ohcnetwork/care_fe",
      branch: `child-${i}`,
      worktree: "/tmp/wt",
      tier: "standard",
      pr: null,
      round: 1,
      step: "2",
      head_sha: "abc",
      last_reviewed_sha: "",
      run_id: mintRunId(),
      requested_by: null,
      ticket: null,
      summary: null,
    });
    child.seedRun(`slug-${i}`, st);
    child.appendEvent(
      st.run_id,
      { seq: 0, ts: new Date().toISOString(), run_id: st.run_id, event: "step.enter", step: "2", prev: "sha256:x" },
      { deltaMs: 0, costUsd: 0 },
    );
  }

  // Both sides' work is intact — no write was silently lost to a swallowed lock error.
  assert.equal(queue.list({ limit: 500 }).length, 60);
  assert.equal(
    (serviceDb.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
    60,
    "the service's connection sees the child's committed rows",
  );
  child.close();
  serviceDb.close();
});

// §10 "Claim is atomic: two claim loops against one pending row ⇒ exactly one changes() == 1".
// The existing queue.test.ts case claims twice SEQUENTIALLY, which proves the status guard but not
// the locking. This drives two independent CONNECTIONS, which is what actually exercises
// BEGIN IMMEDIATE — the failure it prevents is two supervisors spawning one run, and that failure
// surfaces hours later as the loop's own lockfile refusing the second orchestrator.
test("two connections racing the same pending row: exactly one wins", () => {
  const p = dbPath();
  const owner = new SqliteRunStore(p);

  const connect = (): QueueStore => {
    const db = new DatabaseSync(p);
    applyConnectionPragmas(db);
    return new QueueStore(db);
  };
  const a = connect();
  const b = connect();

  const enqueued = a.enqueue({
    requestedBy: "svc",
    repo: "ohcnetwork/care_fe",
    branch: "contested",
    task: "t",
    ticket: "ENG-1",
    summary: "s",
  });

  const winners = [a.claim(), b.claim()].filter((r) => r !== null);
  assert.equal(winners.length, 1, "exactly one connection may claim a given row");
  assert.equal(winners[0]!.runId, enqueued.runId);
  assert.equal(a.byRunId(enqueued.runId)?.attempts, 1, "attempts must not double-count");
  owner.close();
});

test("racing connections drain a queue without double-claiming any row", () => {
  const p = dbPath();
  const owner = new SqliteRunStore(p);
  const connect = (): QueueStore => {
    const db = new DatabaseSync(p);
    applyConnectionPragmas(db);
    return new QueueStore(db);
  };
  const a = connect();
  const b = connect();

  // Distinct branches, so admission control never skips one — every row is claimable and the only
  // thing deciding who gets it is the lock.
  for (let i = 0; i < 20; i++)
    a.enqueue({
      requestedBy: "svc",
      repo: "ohcnetwork/care_fe",
      branch: `b${i}`,
      task: "t",
      ticket: `ENG-${i}`,
      summary: "s",
    });

  const claimed: string[] = [];
  for (let i = 0; i < 20; i++) {
    // Alternate so neither connection can simply run ahead of the other.
    const got = (i % 2 === 0 ? a : b).claim();
    if (got) claimed.push(got.runId);
  }

  assert.equal(claimed.length, 20, "every row claimed");
  assert.equal(new Set(claimed).size, 20, "and none of them twice");
  assert.equal(a.list({ status: ["pending"] }).length, 0);
  owner.close();
});

// §10 "Concurrent writers", the case the interleaved test does NOT cover: a transaction held OPEN
// across the other connection's requests. This is what a running child looks like from the service's
// side, and it is the scenario that turned every signed-in request into a 5-second stall and an
// HTTP 500 — because identity resolution wrote to `sessions` on every single request.
test("a held write lock does not stall identity resolution", () => {
  const p = dbPath();
  const child = new SqliteRunStore(p);
  const serviceDb = new DatabaseSync(p);
  applyConnectionPragmas(serviceDb);
  const sessions = new SessionStore(serviceDb);
  const { token } = sessions.login("octocat");

  // The child takes the write lock and keeps it, as it would mid-step.
  child.raw().exec("BEGIN IMMEDIATE");
  child
    .raw()
    .prepare("INSERT INTO users (login, created_at, last_seen_at) VALUES (?,?,?)")
    .run("holder", new Date().toISOString(), new Date().toISOString());

  const t0 = Date.now();
  const who = sessions.resolve(token);
  const elapsed = Date.now() - t0;

  child.raw().exec("ROLLBACK");

  assert.equal(who?.login, "octocat", "identity must survive a contended bookkeeping write");
  // Before the throttle this burned the full 5s busy_timeout and then threw `database is locked`,
  // which reached the error handler as an unmodelled error and 500'd the request.
  assert.ok(elapsed < 1000, `identity resolution took ${elapsed}ms — it must not wait on the lock`);

  child.close();
  serviceDb.close();
});

test("reads are unaffected by a held write lock — WAL doing its job", () => {
  const p = dbPath();
  const child = new SqliteRunStore(p);
  const serviceDb = new DatabaseSync(p);
  applyConnectionPragmas(serviceDb);

  child.raw().exec("BEGIN IMMEDIATE");
  child
    .raw()
    .prepare("INSERT INTO users (login, created_at, last_seen_at) VALUES (?,?,?)")
    .run("holder", new Date().toISOString(), new Date().toISOString());

  const t0 = Date.now();
  const n = (serviceDb.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  const elapsed = Date.now() - t0;

  child.raw().exec("ROLLBACK");
  assert.equal(n, 0);
  assert.ok(elapsed < 500, "a pure read must never contend");
  child.close();
  serviceDb.close();
});
