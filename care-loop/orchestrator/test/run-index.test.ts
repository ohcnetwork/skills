// test/run-index.test.ts — the fleet read port, which is DB-ONLY ([[PLAN-loop-service]] §6). Every
// assertion here runs against an in-memory database with no run directory on disk at all: if any
// method ever reaches for the filesystem again, these tests are what fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { SqliteRunIndex } from "../src/run-index.ts";
import { mintRunId } from "../src/run-id.ts";
import type { CareState } from "../src/state.ts";
import { validateState } from "../src/state.ts";
import type { SqliteRunStore } from "../src/run-store.ts";
import { useRealStore } from "./_store.ts";

function stateFor(over: Partial<CareState>): CareState {
  return validateState({
    task: "seed a run",
    repo: "ohcnetwork/care_fe",
    branch: "my-branch",
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
    ...over,
  });
}

/** Seed a run straight into the store — no journal file, no run dir. */
function seed(store: SqliteRunStore, slug: string, over: Partial<CareState> = {}): string {
  const state = stateFor(over);
  store.seedRun(slug, state);
  return state.run_id;
}

function fixture(): { store: SqliteRunStore; index: SqliteRunIndex } {
  const store = useRealStore();
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, index: new SqliteRunIndex(db) };
}

test("list returns flat summaries keyed by runId, newest first", () => {
  const { store, index } = fixture();
  const older = seed(store, "care_fe-a", { started_at: "2026-08-01T00:00:00.000Z" });
  const newer = seed(store, "care_fe-b", { started_at: "2026-08-02T00:00:00.000Z" });
  const rows = index.list();
  assert.deepEqual(
    rows.map((r) => r.runId),
    [newer, older],
  );
  assert.equal(rows[0].slug, "care_fe-b");
});

test("list/count agree, and pagination does not change the total", () => {
  const { store, index } = fixture();
  for (let i = 0; i < 5; i++) seed(store, `care_fe-${i}`);
  assert.equal(index.count(), 5);
  const page = index.list({ limit: 2, offset: 2 });
  assert.equal(page.length, 2);
  // The total must reflect the FILTER, never the page — a page count computed from a different
  // predicate is the classic silently-wrong paginator.
  assert.equal(index.count({ limit: 2, offset: 2 }), 5);
});

test("filters compose, and requested_by isolates one user's fleet", () => {
  const { store, index } = fixture();
  seed(store, "care_fe-x", { requested_by: "octocat", branch: "x" });
  seed(store, "care_fe-y", { requested_by: "octocat", branch: "y" });
  seed(store, "care_fe-z", { requested_by: "someone", branch: "y" });
  assert.equal(index.count({ requestedBy: "octocat" }), 2);
  assert.equal(index.count({ requestedBy: "octocat", branch: "y" }), 1);
  assert.equal(index.count({ branch: "y" }), 2);
});

test("active filters on terminal steps in both directions", () => {
  const { store, index } = fixture();
  seed(store, "care_fe-live", { step: "6a" });
  seed(store, "care_fe-done", { step: "7" });
  seed(store, "care_fe-merged", { step: "merged" });
  assert.deepEqual(index.list({ active: true }).map((r) => r.slug), ["care_fe-live"]);
  assert.equal(index.count({ active: false }), 2);
});

test("stale runs are excluded by default and included on request", () => {
  const { store, index } = fixture();
  seed(store, "care_fe-live");
  seed(store, "care_fe-old.stale-2026-08-01");
  assert.equal(index.count(), 1);
  assert.equal(index.count({ includeStale: true }), 2);
  assert.equal(index.list({ includeStale: true }).find((r) => r.stale)?.slug.includes(".stale-"), true);
});

test("get returns the run joined with its detail fields, null for an unknown id", () => {
  const { store, index } = fixture();
  const runId = seed(store, "care_fe-a", { ticket: "ENG-747", summary: "do the thing" });
  const rec = index.get(runId);
  assert.equal(rec?.runId, runId);
  assert.equal(rec?.ticket, "ENG-747");
  assert.equal(rec?.summary, "do the thing");
  assert.equal(rec?.task, "seed a run");
  assert.equal(index.get(mintRunId()), null);
});

test("events paginate by seq with a cursor, and the last page reports nextSeq null", () => {
  const { store, index } = fixture();
  const runId = seed(store, "care_fe-a");
  for (let seq = 0; seq < 5; seq++)
    store.appendEvent(
      runId,
      { seq, ts: `2026-08-01T00:00:0${seq}.000Z`, run_id: runId, event: "step.enter", step: "2", prev: "sha256:x" },
      { deltaMs: 0, costUsd: 0 },
    );

  const first = index.events(runId, { limit: 2 });
  assert.deepEqual(first.items.map((e) => e.seq), [0, 1]);
  assert.equal(first.nextSeq, 1);

  const second = index.events(runId, { limit: 2, afterSeq: first.nextSeq! });
  assert.deepEqual(second.items.map((e) => e.seq), [2, 3]);

  const last = index.events(runId, { limit: 2, afterSeq: second.nextSeq! });
  assert.deepEqual(last.items.map((e) => e.seq), [4]);
  assert.equal(last.nextSeq, null, "a partial page is the last page");
});

test("events filter by type, and round-trip the data payload", () => {
  const { store, index } = fixture();
  const runId = seed(store, "care_fe-a");
  store.appendEvent(
    runId,
    { seq: 0, ts: "2026-08-01T00:00:00.000Z", run_id: runId, event: "step.enter", step: "2", prev: "sha256:x" },
    { deltaMs: 0, costUsd: 0 },
  );
  store.appendEvent(
    runId,
    {
      seq: 1,
      ts: "2026-08-01T00:00:01.000Z",
      run_id: runId,
      event: "skill.result",
      data: { verdict: "pass", findings: 3 },
      prev: "sha256:y",
    },
    { deltaMs: 1000, costUsd: 0.5 },
  );
  const only = index.events(runId, { events: ["skill.result"] });
  assert.equal(only.items.length, 1);
  assert.deepEqual(only.items[0].data, { verdict: "pass", findings: 3 });
});

test("slugOf maps a run id to its directory, and null for an unknown id", () => {
  const { store, index } = fixture();
  const runId = seed(store, "care_fe-a");
  assert.equal(index.slugOf(runId), "care_fe-a");
  assert.equal(index.slugOf(mintRunId()), null);
});
