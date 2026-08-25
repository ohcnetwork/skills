// service-gate.test.ts — the gate as rows: idempotent asks, suspension, cancel, expiry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SqliteRunStore } from "../src/run-store.ts";
import { GateStore } from "../src/service/gate-store.ts";
import {
  askIdFor,
  GateCancelledError,
  GateExpiredError,
  GateSuspendedError,
  servicePlanGate,
} from "../src/service-gate.ts";
import type { ConsolidatedAsk } from "../src/plan-gate.ts";

function fixture(): GateStore {
  const dir = mkdtempSync(join(tmpdir(), "care-gate-"));
  const store = new SqliteRunStore(join(dir, "loops.db"));
  return new GateStore((store as unknown as { db: DatabaseSync }).db);
}

const RUN = "01M0GATE0000000000000000AA";
const ASK: ConsolidatedAsk = {
  plannedBy: "Claude Opus",
  summary: "do the thing",
  classification: "trivial",
  criteria: ["it works"],
  testPlan: "skip — trivial change",
  pushAuthNote: "Approval authorizes a push.",
};

/** A gate that never sleeps, so a suspension test runs in microseconds rather than ten minutes. */
function gate(store: GateStore, o: Partial<Parameters<typeof servicePlanGate>[0]> = {}) {
  let t = Date.now();
  return servicePlanGate({
    runId: RUN,
    store,
    pollMs: 1,
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
    ...o,
  });
}

test("an ask is idempotent by id — a re-spawned child finds its own row, answer included", () => {
  const store = fixture();
  const first = store.ask({ runId: RUN, askId: "approve:x", kind: "approve", payload: ASK });
  assert.equal(first.answer, null);
  assert.equal(store.answer(RUN, "approve:x", { decision: "approve" }, "octocat"), true);

  // The crash-only case: the child died after posting, was re-spawned, and posts the SAME id. It must
  // find the row the human already answered rather than blanking it and asking a second time.
  const again = store.ask({ runId: RUN, askId: "approve:x", kind: "approve", payload: ASK });
  assert.deepEqual(again.answer, { decision: "approve" });
  assert.equal(again.answeredBy, "octocat");
  assert.equal(again.askedAt, first.askedAt, "the original ask time survives");
});

test("the ask id is content-derived, so an amended draft asks afresh", () => {
  const same = askIdFor("approve", ASK);
  assert.equal(askIdFor("approve", { ...ASK }), same, "identical content re-asks idempotently");
  assert.notEqual(
    askIdFor("approve", { ...ASK, summary: "do a DIFFERENT thing" }),
    same,
    "an amended draft must not inherit the previous draft's answer",
  );
  // A counter would live in memory and restart at 1 in a re-spawned child, colliding a different
  // second draft with the first draft's answer. The hash gets both cases right at once.
  assert.notEqual(askIdFor("interview", ASK), same, "kind participates");
});

test("amend does not loop forever against its own stale answer", async () => {
  const store = fixture();
  const g = gate(store);

  // Answer the first ask `amend`, then present a re-drafted plan. The bug this guards: with a shared
  // ask id the second call finds the first row — already answered `amend` — returns it immediately,
  // and the planner amends forever, one real planner call per lap.
  store.ask({ runId: RUN, askId: askIdFor("approve", ASK), kind: "approve", payload: ASK });
  store.answer(RUN, askIdFor("approve", ASK), { decision: "amend", amendment: "use a modal" }, "octocat");
  assert.deepEqual(await g.approve(ASK), { decision: "amend", amendment: "use a modal" });

  const redraft = { ...ASK, summary: "do the thing, with a modal" };
  store.ask({ runId: RUN, askId: askIdFor("approve", redraft), kind: "approve", payload: redraft });
  store.answer(RUN, askIdFor("approve", redraft), { decision: "approve" }, "octocat");
  assert.deepEqual(await g.approve(redraft), { decision: "approve" }, "the re-draft got its own answer");
});

test("a re-draft that comes back IDENTICAL still gets a fresh ask", async () => {
  const store = fixture();
  const g = gate(store, { waitMs: 10 });

  store.ask({ runId: RUN, askId: askIdFor("approve", ASK), kind: "approve", payload: ASK });
  store.answer(RUN, askIdFor("approve", ASK), { decision: "amend", amendment: "no-op" }, "octocat");
  assert.equal((await g.approve(ASK)).decision, "amend");

  // The one case a content hash alone cannot catch: the planner returned byte-identical text, so the
  // id would collide with the ask just answered `amend` and replay it — the unbounded loop again.
  await assert.rejects(() => g.approve(ASK), GateSuspendedError, "asks again rather than replaying");
});

test("an unanswered gate SUSPENDS rather than blocking — the slot is what is expensive", async () => {
  const store = fixture();
  const g = gate(store, { waitMs: 60_000 });
  const err = await g.approve(ASK).then(() => null, (e: Error) => e);

  assert.ok(err instanceof GateSuspendedError);
  // The ask stays OPEN. Suspension is not abandonment: the run resumes when the answer arrives, and
  // meanwhile it holds no process, no slot, and no worktree.
  const still = store.pending(RUN);
  assert.equal(still?.askId, err.askId);
  assert.equal(still?.answer, null);
});

test("cancel travels the channel the child is already blocked on", async () => {
  const store = fixture();
  const g = gate(store, { waitMs: 60_000 });
  const askId = askIdFor("approve", ASK);
  store.ask({ runId: RUN, askId, kind: "approve", payload: ASK });
  assert.equal(store.cancel(RUN), 1);

  // A signalled child skips its `finally`: lockfile left behind, no run.end, last journal event a
  // question nobody will answer. Saying it in the row lets the child unwind through its normal path.
  await assert.rejects(() => g.approve(ASK), GateCancelledError);
  assert.equal(store.pending(RUN), null, "a cancelled ask is no longer pending");
});

test("an ask nobody answers within its TTL expires, and expiry beats suspension", async () => {
  const store = fixture();
  const t0 = new Date("2026-08-25T00:00:00.000Z");
  const askId = askIdFor("approve", ASK);
  store.ask({ runId: RUN, askId, kind: "approve", payload: ASK }, { now: t0, ttlMs: 60_000 });

  assert.equal(store.poll(RUN, askId, new Date(t0.getTime() + 30_000)).state, "pending");
  assert.equal(store.poll(RUN, askId, new Date(t0.getTime() + 61_000)).state, "expired");
  // And it stops being offered as an open question, so the FE's "needs you" list stays actionable.
  assert.equal(store.pending(RUN, new Date(t0.getTime() + 61_000)), null);

  let t = t0.getTime() + 61_000;
  const g = servicePlanGate({
    runId: RUN,
    store,
    pollMs: 1,
    waitMs: 60_000,
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
  });
  await assert.rejects(() => g.approve(ASK), GateExpiredError);
});

test("answering is a race that reports its loser", () => {
  const store = fixture();
  store.ask({ runId: RUN, askId: "approve:x", kind: "approve", payload: ASK });

  assert.equal(store.answer(RUN, "approve:x", { decision: "approve" }, "octocat"), true);
  // Two people opened the gate view; the second must learn they did not unblock the run rather than
  // believe they did.
  assert.equal(store.answer(RUN, "approve:x", { decision: "reject" }, "hubot"), false);
  assert.deepEqual(store.get(RUN, "approve:x")?.answer, { decision: "approve" });
  assert.equal(store.get(RUN, "approve:x")?.answeredBy, "octocat");
});

test("an empty interview never posts a row", async () => {
  const store = fixture();
  assert.deepEqual(await gate(store).interview([]), []);
  assert.equal(store.pending(RUN), null);
});

test("the interview is one row for the whole batch", async () => {
  const store = fixture();
  const questions = [
    { id: "q1", prompt: "which?" },
    { id: "q2", prompt: "when?" },
  ];
  const askId = askIdFor("interview", questions);
  store.ask({ runId: RUN, askId, kind: "interview", payload: questions });
  const answers = [
    { id: "q1", answer: "this" },
    { id: "q2", answer: "now" },
  ];
  store.answer(RUN, askId, answers, "octocat");

  assert.deepEqual(await gate(store).interview(questions), answers);
  assert.equal(store.pendingRuns().length, 0);
});

test("pendingRuns is the FE's needs-you list, and ignores dead asks", () => {
  const store = fixture();
  const t0 = new Date("2026-08-25T00:00:00.000Z");
  store.ask({ runId: "01AAA", askId: "approve:1", kind: "approve", payload: ASK }, { now: t0 });
  store.ask({ runId: "01BBB", askId: "approve:1", kind: "approve", payload: ASK }, { now: t0 });
  store.ask({ runId: "01CCC", askId: "approve:1", kind: "approve", payload: ASK }, { now: t0 });
  store.answer("01BBB", "approve:1", { decision: "approve" }, "octocat");
  store.cancel("01CCC");

  assert.deepEqual(
    store.pendingRuns().map((a) => a.runId),
    ["01AAA"],
    "answered and cancelled asks are not waiting on anyone",
  );
});
