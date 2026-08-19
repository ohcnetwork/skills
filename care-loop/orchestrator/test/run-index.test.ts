// test/run-index.test.ts — the fleet read port. Two things are load-bearing here and neither is
// obvious from the types: `RunIndex.get` takes a SLUG (so it must read the replica, not the DB-backed
// `read()`, which queries by run_id), and `slugOf` is the run_id → directory mapping the
// `/api/runs/:run_id` route resolves through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SqliteRunIndex } from "../src/run-index.ts";
import { openRun } from "../src/run-context.ts";
import { projectAndWrite } from "../src/state.ts";
import { useRealStore } from "./_store.ts";

/** Seed one real run (journal + DB rows) under `runsDir/slug`, returning its run id. */
function seedRun(runsDir: string, slug: string): string {
  const dir = join(runsDir, slug);
  mkdirSync(dir, { recursive: true });
  const { journal, runId } = openRun(dir);
  journal.append({
    event: "run.start",
    step: "1",
    round: 1,
    data: {
      state: {
        task: "seed a run",
        repo: "ohcnetwork/care_fe",
        branch: slug.replace(/^care_fe-/, ""),
        worktree: "/tmp/wt",
        tier: "standard",
        pr: null,
        round: 1,
        step: "1",
        head_sha: "abc",
        last_reviewed_sha: "",
        run_id: runId,
        requested_by: null,
        ticket: null,
        summary: null,
      },
    },
  });
  journal.append({ event: "step.enter", step: "2", round: 1 });
  projectAndWrite(dir, journal.read().events);
  return runId;
}

function fixture(): { runsDir: string; index: SqliteRunIndex; runId: string; slug: string } {
  const store = useRealStore();
  const runsDir = mkdtempSync(join(tmpdir(), "careloopd-index-"));
  const slug = "care_fe-my-branch";
  const runId = seedRun(runsDir, slug);
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { runsDir, index: new SqliteRunIndex(db), runId, slug };
}

test("list() carries run_id — the FE cannot build a /api/runs/:run_id link without it", () => {
  const { index, runId, slug } = fixture();
  const rows = index.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].runId, runId);
  assert.equal(rows[0].name, slug);
});

test("slugOf maps a run id to its directory, and null for an unknown id", () => {
  const { index, runId, slug } = fixture();
  assert.equal(index.slugOf(runId), slug);
  assert.equal(index.slugOf("01ARZ3NDEKTSV4RRFFQ69G5FAV"), null);
});

// REGRESSION: `get` builds `new Journal(path, name)` where `name` is the SLUG, then reads it. When
// that read went through the DB-backed `read()`, it queried `run_id = <slug>`, matched no rows, and
// returned an EMPTY timeline with no error — a run detail page that silently rendered nothing.
test("get() returns the real timeline for a slug (not an empty one via a slug/run_id mismatch)", () => {
  const { runsDir, index, slug } = fixture();
  const detail = index.get(runsDir, slug);
  assert.equal(detail.error, undefined);
  assert.ok(detail.events.length >= 2, `expected a populated timeline, got ${detail.events.length}`);
  assert.equal(detail.events[0].event, "run.start");
  assert.ok(detail.state, "expected a projected state");
  assert.equal(detail.state?.branch, "my-branch");
});

test("get() reports a missing journal rather than throwing", () => {
  const { runsDir, index } = fixture();
  const detail = index.get(runsDir, "care_fe-does-not-exist");
  assert.equal(detail.error, "no journal");
  assert.deepEqual(detail.events, []);
});
