// Integration test: a real Journal + SqliteRunStore wired via the active-store singleton, exactly as
// the live write path does (journal.ts#append + state.ts#projectAndWrite). Verifies PLAN-sqlite-run-
// store.md §4's ordering guarantee (seedRun before the first event row) and that run_events mirrors
// the journal event-for-event on a live run, not just after `reindex`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRun } from "../src/run-context.ts";
import { projectAndWrite } from "../src/state.ts";
import {
  SqliteRunStore,
  setActiveRunStore,
  NullRunStore,
} from "../src/run-store.ts";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "careloopd-integration-"));
}

test("a live run mirrors event-for-event into run_events, with runs/run_detail kept in sync", () => {
  const runDir = tmpRunDir();
  const dbPath = join(tmpdir(), `careloopd-integration-${Date.now()}.db`);
  const store = new SqliteRunStore(dbPath);
  setActiveRunStore(store);
  try {
    const { journal: j, runId } = openRun(runDir);
    j.append({
      event: "run.start",
      step: "1",
      round: 1,
      data: {
        state: {
          task: "t",
          repo: "ohcnetwork/care_fe",
          branch: "b",
          worktree: "/tmp/wt",
          tier: "standard",
          pr: null,
          round: 1,
          step: "1",
          head_sha: "abc",
          last_reviewed_sha: "",
          run_id: runId,
          requested_by: null,
          ticket: "ENG-1",
          summary: "s",
        },
      },
    });
    j.append({ event: "step.enter", step: "2", round: 1 });
    j.append({
      event: "skill.result",
      step: "2",
      data: { cost_usd: 0.25 },
    });

    const dbAny = store as unknown as { db: import("node:sqlite").DatabaseSync };
    const eventRows = dbAny.db
      .prepare("SELECT seq, event FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as { seq: number; event: string }[];
    assert.deepEqual(
      eventRows.map((r) => r.event),
      ["run.start", "step.enter", "skill.result"],
    );

    const runsRow = dbAny.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as any;
    assert.equal(runsRow.event_count, 3);
    assert.equal(runsRow.cost_usd, 0.25);
    assert.equal(runsRow.step, "1"); // incremental path doesn't patch step; only projectAndWrite does

    // Now the reconciling write (projectAndWrite) does the FULL recompute AND folds step correctly.
    const state = projectAndWrite(runDir, j.read().events);
    const reconciled = dbAny.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as any;
    assert.equal(reconciled.step, "2");
    assert.equal(reconciled.event_count, 3);
    assert.equal(reconciled.cost_usd, 0.25);

    const detail = dbAny.db.prepare("SELECT * FROM run_detail WHERE run_id = ?").get(runId) as any;
    assert.equal(detail.ticket, "ENG-1");
    assert.equal(detail.summary, "s");
    assert.equal(state.run_id, runId);
  } finally {
    store.close();
    setActiveRunStore(new NullRunStore());
  }
});

test("a store failure (closed db) is FATAL — DB is truth now, the run must halt rather than silently drift", () => {
  const runDir = tmpRunDir();
  const dbPath = join(tmpdir(), `careloopd-integration-closed-${Date.now()}.db`);
  const store = new SqliteRunStore(dbPath);
  store.close(); // subsequent operations on a closed DatabaseSync throw
  setActiveRunStore(store);
  try {
    // openRun itself now throws: it must query the (unreachable) DB just to determine isNew (§10 —
    // read() is DB-backed), so a run can no longer even be opened without a working store, let alone
    // resume or project state.
    assert.throws(() => openRun(runDir));
  } finally {
    setActiveRunStore(new NullRunStore());
  }
});
