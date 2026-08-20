// reindex.test.ts — the PLAN-sqlite-run-store.md §2/§9 guarantee: `rm loops.db && care-loopd reindex`
// is a complete, lossless recovery, and a reindexed DB is indistinguishable from one built by living
// through the run (the incremental Journal.append path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reindexRuns, ReindexUnsafeError } from "../src/reindex.ts";
import { SqliteRunStore, setActiveRunStore, NullRunStore } from "../src/run-store.ts";
import { openRun } from "../src/run-context.ts";
import { projectAndWrite } from "../src/state.ts";
import { QueueStore } from "../src/service/queue.ts";
import { useRealStore } from "./_store.ts";

function tmpRunsDir(): string {
  return mkdtempSync(join(tmpdir(), "careloopd-reindex-"));
}

function seedFixtureRun(
  runsDir: string,
  slug: string,
  opts: { ticket: string; branch: string },
): string {
  const runDir = join(runsDir, slug);
  mkdirSync(runDir, { recursive: true });
  useRealStore();
  const { journal: j, runId } = openRun(runDir);
  j.append({
    event: "run.start",
    step: "1",
    round: 1,
    data: {
      state: {
        task: `task for ${slug}`,
        repo: "ohcnetwork/care_fe",
        branch: opts.branch,
        worktree: `/tmp/${slug}`,
        tier: "standard",
        pr: null,
        round: 1,
        step: "1",
        head_sha: "abc",
        last_reviewed_sha: "",
        run_id: runId,
        requested_by: null,
        ticket: opts.ticket,
        summary: `summary ${slug}`,
      },
    },
  });
  j.append({ event: "step.enter", step: "2", round: 1 });
  j.append({ event: "skill.result", step: "2", data: { cost_usd: 0.3 } });
  j.append({
    event: "push",
    data: { state: { pr: 42, head_sha: "def456", step: "5-await" } },
  });
  return runId;
}

test("reindexRuns rebuilds runs/run_detail/run_events from journals alone, byte-identical on re-run", () => {
  const runsDir = tmpRunsDir();
  const runIdA = seedFixtureRun(runsDir, "care_fe-eng-1", { ticket: "ENG-1", branch: "eng-1" });
  const runIdB = seedFixtureRun(runsDir, "care_fe-eng-2", { ticket: "ENG-2", branch: "eng-2" });

  const dbPath = join(runsDir, "loops.db");
  const store = new SqliteRunStore(dbPath);
  const first = reindexRuns(store, runsDir);
  assert.equal(first.runsIndexed, 2);
  assert.deepEqual(first.runsSkipped, []);

  const raw = store.raw();
  const rows = raw.prepare("SELECT * FROM runs ORDER BY slug").all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].run_id, runIdA);
  assert.equal(rows[0].event_count, 4);
  assert.equal(rows[0].cost_usd, 0.3);
  assert.equal(rows[0].pr, 42);
  assert.equal(rows[0].step, "5-await");
  assert.equal(rows[1].run_id, runIdB);

  const eventsA = raw
    .prepare("SELECT event FROM run_events WHERE run_id = ? ORDER BY seq")
    .all(runIdA) as { event: string }[];
  assert.deepEqual(
    eventsA.map((e) => e.event),
    ["run.start", "step.enter", "skill.result", "push"],
  );

  // idempotence: re-running reindex on the SAME journals produces the SAME rows
  reindexRuns(store, runsDir);
  const rowsAgain = raw.prepare("SELECT * FROM runs ORDER BY slug").all() as any[];
  assert.deepEqual(rowsAgain, rows);

  store.close();
});

test("reindexRuns matches a DB built by living through the run (incremental Journal.append path)", () => {
  const runsDir = tmpRunsDir();
  const slug = "care_fe-eng-3";
  const runDir = join(runsDir, slug);

  // Build the "live" DB by actually driving the run through the active-store hooks.
  const liveDbPath = join(runsDir, "live.db");
  mkdirSync(runDir, { recursive: true });
  const liveStore = new SqliteRunStore(liveDbPath);
  setActiveRunStore(liveStore);
  let runId: string;
  try {
    const opened = openRun(runDir);
    runId = opened.runId;
    opened.journal.append({
      event: "run.start",
      step: "1",
      round: 1,
      data: {
        state: {
          task: "live task",
          repo: "ohcnetwork/care_fe",
          branch: "eng-3",
          worktree: "/tmp/eng-3",
          tier: "standard",
          pr: null,
          round: 1,
          step: "1",
          head_sha: "abc",
          last_reviewed_sha: "",
          run_id: runId,
          requested_by: null,
          ticket: "ENG-3",
          summary: "live summary",
        },
      },
    });
    opened.journal.append({ event: "step.enter", step: "2", round: 1 });
    opened.journal.append({ event: "skill.result", step: "2", data: { cost_usd: 0.75 } });
    projectAndWrite(runDir, opened.journal.read().events);
  } finally {
    setActiveRunStore(new NullRunStore());
  }
  const liveRow = liveStore.raw().prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as any;
  liveStore.close();

  // Now reindex from a FRESH db and confirm the same run dir produces the same row.
  const reindexedDbPath = join(runsDir, "reindexed.db");
  const reindexStore = new SqliteRunStore(reindexedDbPath);
  reindexRuns(reindexStore, runsDir);
  const reindexedRow = reindexStore
    .raw()
    .prepare("SELECT * FROM runs WHERE run_id = ?")
    .get(runId) as any;
  reindexStore.close();

  assert.equal(reindexedRow.run_id, liveRow.run_id);
  assert.equal(reindexedRow.event_count, liveRow.event_count);
  assert.equal(reindexedRow.cost_usd, liveRow.cost_usd);
  assert.equal(reindexedRow.step, liveRow.step);
  assert.equal(reindexedRow.tier, liveRow.tier);
});

test("reindexRuns skips a run dir with no journal (not an error), and counts 0 for an empty one", () => {
  const runsDir = tmpRunsDir();
  mkdirSync(join(runsDir, "no-journal-here"));
  const dbPath = join(runsDir, "loops.db");
  const store = new SqliteRunStore(dbPath);
  const result = reindexRuns(store, runsDir);
  assert.equal(result.runsIndexed, 0);
  assert.equal(result.runsSkipped.length, 0); // no journal ⇒ silently skipped, not an error
  store.close();
});

// ── regression: appending to a REINDEXED LEGACY run ──────────────────────────
// Found by running the §9 evaluation against the real 6-run fleet. A legacy journal carries a
// PRE-ULID run_id (`ohcnetwork-<repo>-<branch>`, and the doctor events a differently-derived one);
// `reindex` backfills a ULID into the DB. When `prev` was taken from the DB — `sha256(serializeEvent(
// dbEvent))` — it reproduced a line the file never contained, so the FIRST append to any migrated run
// broke the replica's hash chain: readReplica() throws, reindex can no longer rebuild that run, and
// the recovery path is silently gone. `prev` belongs to the replica; `seq`/`deltaMs` to the DB.
//
// The whole suite passed both before and after that fix, so this is the only thing guarding it.
test("appending to a reindexed legacy run keeps the replica chain valid", () => {
  const runsDir = tmpRunsDir();
  const slug = "care_fe-legacy-run";
  const runDir = join(runsDir, slug);
  mkdirSync(runDir, { recursive: true });

  // Hand-write a legacy journal: derived (non-ULID) run_id, and — as the real fleet does — a SECOND
  // derived form on the trailing doctor events.
  const legacy = "ohcnetwork-care_fe-legacy-run";
  const legacyDoctor = "care_fe-legacy-run";
  const state = {
    task: "legacy task",
    repo: "ohcnetwork/care_fe",
    branch: "legacy-run",
    worktree: "/tmp/legacy",
    tier: "standard",
    pr: 42,
    round: 1,
    step: "7",
    head_sha: "abc",
    last_reviewed_sha: "",
    requested_by: null,
    ticket: null,
    summary: null,
  };
  const lines: string[] = [];
  let prev = "sha256:genesis"; // journal.ts GENESIS
  const push = (seq: number, runId: string, event: string, data?: unknown) => {
    const o: Record<string, unknown> = {
      seq,
      ts: `2026-07-17T05:5${seq}:00.000Z`,
      run_id: runId,
      event,
      step: "7",
      round: 1,
      ...(data !== undefined ? { data } : {}),
      prev,
    };
    const line = JSON.stringify(o);
    lines.push(line);
    prev = "sha256:" + createHash("sha256").update(line).digest("hex");
  };
  push(0, legacy, "run.start", { state });
  push(1, legacy, "step.enter");
  push(2, legacyDoctor, "doctor.report", { mode: "report" }); // the second derived id
  writeFileSync(join(runDir, "journal.jsonl"), lines.join("\n") + "\n");

  const store = new SqliteRunStore(":memory:");
  setActiveRunStore(store);
  const result = reindexRuns(store, runsDir);
  assert.equal(result.runsIndexed, 1, JSON.stringify(result.runsSkipped));

  // The DB now holds these events under a MINTED ULID, which is not what the file says.
  const { journal: j } = openRun(runDir);
  const dbId = j.read().events[0].run_id;
  assert.notEqual(dbId, legacy, "reindex should have backfilled a ULID");

  j.append({ event: "run.resume", step: "7", round: 1 });

  // The assertion that would have failed: readReplica verifies the chain link by link.
  const replica = j.readReplica();
  assert.equal(replica.events.length, 4);
  assert.equal(replica.truncatedTail, false);
  assert.equal(j.read().events.length, 4);
});

// ── the live-run guard ───────────────────────────────────────────────────────────────────────────

test("reindex refuses while a run is actually being driven, and --force overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-guard-"));
  const store = new SqliteRunStore(join(dir, "loops.db"));
  setActiveRunStore(store);

  const runDir = join(dir, "care_fe-live");
  mkdirSync(join(runDir, ".orchestrator.lock"), { recursive: true });
  // OUR pid: a lock held by a live process is the only thing that means "something is driving this
  // right now". `runs.step NOT IN (terminal)` was tried and is wrong — a run abandoned a month ago
  // sits non-terminal forever and would block every rebuild.
  writeFileSync(join(runDir, ".orchestrator.lock", "pid"), `${process.pid}\n`);

  assert.throws(
    () => reindexRuns(store, dir),
    ReindexUnsafeError,
    "a rebuild deletes run_events out from under a live child and kills it with an FK error",
  );
  // the escape hatch still works
  assert.equal(reindexRuns(store, dir, { force: true }).runsIndexed, 0);
  store.close();
});

test("a stale lock from a dead process does not block a rebuild", () => {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-stale-"));
  const store = new SqliteRunStore(join(dir, "loops.db"));
  setActiveRunStore(store);

  const runDir = join(dir, "care_fe-crashed");
  mkdirSync(join(runDir, ".orchestrator.lock"), { recursive: true });
  // pid 1 is init and will never be a care-loopd; a plausible dead pid without racing a real one.
  writeFileSync(join(runDir, ".orchestrator.lock", "pid"), "999999\n");

  // A crashed run left its lock behind. Refusing forever because of it would make the guard noise,
  // and `reindex` is exactly what you reach for after a crash.
  assert.equal(reindexRuns(store, dir).runsIndexed, 0);
  store.close();
});

test("a running queue row blocks a rebuild even with no lock on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-qguard-"));
  const store = new SqliteRunStore(join(dir, "loops.db"));
  setActiveRunStore(store);
  const q = new QueueStore(store.raw());
  q.enqueue({
    requestedBy: "svc",
    repo: "ohcnetwork/care_fe",
    branch: "b",
    task: "t",
    ticket: "ENG-1",
    summary: "s",
  });
  q.claim(); // → running: the supervisor has spawned, the lock may not exist yet
  assert.throws(() => reindexRuns(store, dir), ReindexUnsafeError);
  store.close();
});
