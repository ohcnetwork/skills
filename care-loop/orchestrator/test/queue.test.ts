// test/queue.test.ts — the request queue ([[PLAN-loop-service]] §4).
//
// The claim is the risky part and gets the most attention here: it is the one place two processes
// could both decide to spawn the same run, and the failure would be two orchestrators writing one
// journal — which the loop's lockfile would then refuse, hours of work in.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { QueueStore } from "../src/service/queue.ts";
import { isValidRunId } from "../src/run-id.ts";
import { useRealStore } from "./_store.ts";

function fixture(): QueueStore {
  const store = useRealStore();
  return new QueueStore((store as unknown as { db: DatabaseSync }).db);
}

const REQ = {
  requestedBy: "octocat",
  repo: "ohcnetwork/care_fe",
  branch: "feat-a",
  task: "do the thing",
  ticket: "ENG-1",
  summary: "does the thing",
};

test("enqueue mints a valid run id and lands a pending row", () => {
  const q = fixture();
  const row = q.enqueue(REQ);
  assert.equal(isValidRunId(row.runId), true, "the id must be usable as CARE_RUN_ID");
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.startedAt, null);
  assert.deepEqual(q.byRunId(row.runId), row);
});

test("claim takes the OLDEST pending row and marks it running", () => {
  const q = fixture();
  const first = q.enqueue({ ...REQ, branch: "a" }, new Date("2026-08-01T00:00:00Z"));
  const second = q.enqueue({ ...REQ, branch: "b" }, new Date("2026-08-02T00:00:00Z"));

  const claimed = q.claim();
  assert.equal(claimed?.runId, first.runId, "FIFO, not whatever the index returns first");
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.attempts, 1);
  assert.notEqual(claimed?.startedAt, null);

  assert.equal(q.claim()?.runId, second.runId);
  assert.equal(q.claim(), null, "nothing left to claim");
});

// The invariant the whole table exists to protect: one row, one spawn.
test("a row can only be claimed once", () => {
  const q = fixture();
  const row = q.enqueue(REQ);
  assert.equal(q.claim()?.runId, row.runId);
  assert.equal(q.claim(), null, "a second claim must not hand out the same row");
  assert.equal(q.byRunId(row.runId)?.attempts, 1, "attempts must not double-count");
});

// Queue-behind, not reject (§12). Two runs on one branch share a run dir, a journal, and a lockfile,
// so the second is not a competing run — it IS the first one.
test("a pending row on a branch that is already running is skipped, not failed", () => {
  const q = fixture();
  const running = q.enqueue({ ...REQ, branch: "same" }, new Date("2026-08-01T00:00:00Z"));
  const behind = q.enqueue({ ...REQ, branch: "same" }, new Date("2026-08-02T00:00:00Z"));
  const other = q.enqueue({ ...REQ, branch: "different" }, new Date("2026-08-03T00:00:00Z"));

  assert.equal(q.claim()?.runId, running.runId);

  // `behind` is older than `other`, but its branch is occupied — so the claim skips it rather than
  // blocking the queue head, and `behind` stays pending rather than failing.
  assert.equal(q.claim()?.runId, other.runId, "an occupied branch must not stall the whole queue");
  assert.equal(q.byRunId(behind.runId)?.status, "pending");

  // it becomes claimable the moment the first finishes
  q.finish(q.byRunId(running.runId)!.id, "done");
  assert.equal(q.claim()?.runId, behind.runId);
});

test("liveOn reports what holds a branch, and nothing once it is terminal", () => {
  const q = fixture();
  const row = q.enqueue({ ...REQ, branch: "held" });
  assert.equal(q.liveOn(REQ.repo, "held")?.runId, row.runId);
  assert.equal(q.liveOn(REQ.repo, "free"), null);
  assert.equal(q.liveOn("other/repo", "held"), null, "the same branch in another repo is unrelated");

  q.finish(row.id, "done");
  assert.equal(q.liveOn(REQ.repo, "held"), null);
});

test("finish and cancel move a row out of the live set; cancel refuses a terminal row", () => {
  const q = fixture();
  const a = q.enqueue({ ...REQ, branch: "a" });
  const b = q.enqueue({ ...REQ, branch: "b" });

  q.finish(a.id, "failed", "spawn failed");
  const failed = q.byRunId(a.runId)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "spawn failed");
  assert.notEqual(failed.finishedAt, null);

  assert.equal(q.cancel(b.runId), true, "a pending row can be cancelled");
  assert.equal(q.byRunId(b.runId)?.status, "cancelled");
  assert.equal(q.cancel(b.runId), false, "cancelling twice reports that nothing changed");
  assert.equal(q.cancel(a.runId), false, "a finished run cannot be un-run");
});

test("a running row can be cancelled — the request has an id before it has a process", () => {
  const q = fixture();
  const row = q.enqueue(REQ);
  q.claim();
  assert.equal(q.cancel(row.runId), true);
  assert.equal(q.byRunId(row.runId)?.status, "cancelled");
});

test("orphaned() surfaces rows a dead supervisor left claimed", () => {
  const q = fixture();
  const row = q.enqueue(REQ);
  assert.deepEqual(q.orphaned(), [], "nothing is running yet");
  q.claim();
  // A `running` row is a claim on a process; after a crash that process is gone and the row is a lie
  // until something reconciles it.
  assert.deepEqual(q.orphaned().map((r) => r.runId), [row.runId]);
});

test("list defaults to every status but filters when asked", () => {
  const q = fixture();
  const a = q.enqueue({ ...REQ, branch: "a" });
  q.enqueue({ ...REQ, branch: "b", requestedBy: "someone" });
  q.finish(a.id, "done");

  assert.equal(q.list().length, 2);
  assert.equal(q.list({ status: ["pending"] }).length, 1);
  assert.equal(q.list({ status: ["done"] })[0]?.runId, a.runId);
  assert.equal(q.list({ requestedBy: "someone" }).length, 1);
});

// reindex must not be able to reach the queue: a runs row is rebuildable, a queue row is not.
test("clearing the run tables leaves the queue untouched", () => {
  const store = useRealStore();
  const q = new QueueStore((store as unknown as { db: DatabaseSync }).db);
  const row = q.enqueue(REQ);
  store.clearAll();
  assert.equal(q.byRunId(row.runId)?.status, "pending", "reindex must never delete a queue row");
});
