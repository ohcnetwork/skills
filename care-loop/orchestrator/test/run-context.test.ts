import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRun, resolveRunId, resolveRequestedBy } from "../src/run-context.ts";
import { isValidRunId } from "../src/run-id.ts";
import { projectState } from "../src/state.ts";
import { Journal, serializeEvent, GENESIS } from "../src/journal.ts";
import { useRealStore } from "./_store.ts";

function tmpRunDir(): string {
  useRealStore();
  return mkdtempSync(join(tmpdir(), "careloopd-runctx-"));
}

test("openRun mints a fresh id + reports isNew for an empty run dir", () => {
  const dir = tmpRunDir();
  const { runId, isNew } = openRun(dir);
  assert.equal(isNew, true);
  assert.equal(isValidRunId(runId), true);
});

test("resolveRunId caches to .run_id and is stable across calls", () => {
  const dir = tmpRunDir();
  const first = resolveRunId(dir);
  const second = resolveRunId(dir);
  assert.equal(first, second);
  assert.equal(existsSync(join(dir, ".run_id")), true);
  assert.equal(readFileSync(join(dir, ".run_id"), "utf8").trim(), first);
});

test("openRun on a non-empty journal reads the persisted run_id, isNew=false", () => {
  const dir = tmpRunDir();
  const seeded = openRun(dir);
  seeded.journal.append({
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
        run_id: seeded.runId,
        requested_by: null,
        ticket: null,
        summary: null,
      },
    },
  });

  const reopened = openRun(dir);
  assert.equal(reopened.isNew, false);
  assert.equal(reopened.runId, seeded.runId);
});

test("deleting the .run_id cache re-derives the SAME id from a non-empty journal (journal stays source of truth)", () => {
  const dir = tmpRunDir();
  const seeded = openRun(dir);
  seeded.journal.append({
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
        run_id: seeded.runId,
        requested_by: null,
        ticket: null,
        summary: null,
      },
    },
  });

  // simulate cache loss
  unlinkSync(join(dir, ".run_id"));
  const recovered = resolveRunId(dir);
  assert.equal(recovered, seeded.runId);
});

test("a journal predating run_id self-heals a deterministic id via projectState/validateState", () => {
  const dir = tmpRunDir();
  // A genuinely pre-feature journal was never live-appended through today's DB-backed Journal.append
  // (§10) — it just exists as a file. Write the raw jsonl line directly (bypassing the DB entirely)
  // rather than going through a live append, which would enforce a run_id/DB consistency this
  // scenario predates.
  const journalPath = join(dir, "journal.jsonl");
  const legacyEvent = {
    seq: 0,
    ts: "2026-01-01T00:00:00.000Z",
    run_id: "care_fe-eng-legacy", // the pre-ULID slug-style id
    event: "run.start" as const,
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
      },
    },
    prev: GENESIS,
  };
  writeFileSync(journalPath, serializeEvent(legacyEvent) + "\n");

  const a = resolveRunId(dir);
  const b = resolveRunId(dir);
  assert.equal(a, b);
  assert.equal(isValidRunId(a), true);
  // also matches what a direct projectState call over the raw replica would derive
  const projected = projectState(new Journal(journalPath, a).readReplica().events);
  assert.equal(projected.run_id, a);
});

// resolveRequestedBy — claimed attribution, one resolver for all four seed sites (PLAN-loop-service
// §2/§6). Env-driven because the loop-service supervisor sets it per child process; NULL for a local
// run is the documented default, not a gap.
test("resolveRequestedBy: explicit value wins, then env, then null", () => {
  const saved = process.env.CARE_REQUESTED_BY;
  try {
    delete process.env.CARE_REQUESTED_BY;
    assert.equal(resolveRequestedBy(), null, "unset env ⇒ null (local CLI run)");
    assert.equal(resolveRequestedBy("octocat"), "octocat");

    process.env.CARE_REQUESTED_BY = "jacobjeevan";
    assert.equal(resolveRequestedBy(), "jacobjeevan");
    assert.equal(resolveRequestedBy("override"), "override", "explicit beats env");

    // Whitespace-only is not attribution — it must not land in the column as "  ".
    process.env.CARE_REQUESTED_BY = "   ";
    assert.equal(resolveRequestedBy(), null);
    process.env.CARE_REQUESTED_BY = "  spaced  ";
    assert.equal(resolveRequestedBy(), "spaced", "trimmed");
  } finally {
    if (saved === undefined) delete process.env.CARE_REQUESTED_BY;
    else process.env.CARE_REQUESTED_BY = saved;
  }
});

test("a run seeded with CARE_REQUESTED_BY set lands it on the runs row", () => {
  const saved = process.env.CARE_REQUESTED_BY;
  process.env.CARE_REQUESTED_BY = "octocat";
  try {
    const store = useRealStore();
    const runDir = mkdtempSync(join(tmpdir(), "careloopd-reqby-"));
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
          requested_by: resolveRequestedBy(),
          ticket: null,
          summary: null,
        },
      },
    });
    const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
    const row = db.prepare("SELECT requested_by FROM runs WHERE run_id = ?").get(runId) as
      | { requested_by: string | null }
      | undefined;
    assert.equal(row?.requested_by, "octocat");
  } finally {
    if (saved === undefined) delete process.env.CARE_REQUESTED_BY;
    else process.env.CARE_REQUESTED_BY = saved;
  }
});
