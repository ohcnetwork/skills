import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  openRun,
  resolveRunId,
  resolveRequestedBy,
  RunIdConflictError,
} from "../src/run-context.ts";
import { isValidRunId, mintRunId } from "../src/run-id.ts";
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

// ── CARE_RUN_ID: the caller-supplied id (loop-service supervisor mints at enqueue) ──────────────

function withPinnedRunId<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.CARE_RUN_ID;
  try {
    if (value === undefined) delete process.env.CARE_RUN_ID;
    else process.env.CARE_RUN_ID = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CARE_RUN_ID;
    else process.env.CARE_RUN_ID = saved;
  }
}

test("CARE_RUN_ID names a fresh run dir instead of minting", () => {
  const dir = tmpRunDir();
  const pinned = mintRunId();
  const got = withPinnedRunId(pinned, () => resolveRunId(dir));
  assert.equal(got, pinned);
  // and it is cached, so the child agrees with the service on every later call
  assert.equal(readFileSync(join(dir, ".run_id"), "utf8").trim(), pinned);
  assert.equal(withPinnedRunId(undefined, () => resolveRunId(dir)), pinned);
});

test("CARE_RUN_ID is rejected when malformed, before it can reach the primary key", () => {
  const dir = tmpRunDir();
  assert.throws(
    () => withPinnedRunId("not-a-ulid", () => resolveRunId(dir)),
    RunIdConflictError,
  );
  // nothing was cached — the run dir is untouched and still free to start
  assert.equal(existsSync(join(dir, ".run_id")), false);
});

test("CARE_RUN_ID matching the established id is a no-op (supervisor restart is idempotent)", () => {
  const dir = tmpRunDir();
  const established = resolveRunId(dir);
  assert.equal(withPinnedRunId(established, () => resolveRunId(dir)), established);
});

test("a conflicting pin resolves via the CACHE path: not live, so archive and adopt", () => {
  const dir = tmpRunDir();
  const established = resolveRunId(dir); // caches .run_id, no journal
  const pinned = mintRunId();
  assert.equal(withPinnedRunId(pinned, () => resolveRunId(dir)), pinned);
  // the old run is set aside, not overwritten
  const archived = readdirSync(dirname(dir)).filter(
    (d) => d.startsWith(basename(dir)) && d.includes(".stale-"),
  );
  assert.equal(archived.length, 1);
  assert.equal(
    readFileSync(join(dirname(dir), archived[0]!, ".run_id"), "utf8").trim(),
    established,
  );
});

test("a conflicting pin resolves via the JOURNAL path too, when the cache is gone", () => {
  const dir = tmpRunDir();
  const { journal, runId } = openRun(dir);
  journal.append({
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
        ticket: null,
        summary: null,
      },
    },
  });
  unlinkSync(join(dir, ".run_id")); // force the journal-fold branch, not the cache branch

  const pinned = mintRunId();
  assert.equal(withPinnedRunId(pinned, () => resolveRunId(dir)), pinned);
  // and the journal that established the old id went with the archived dir
  const archived = readdirSync(dirname(dir)).filter(
    (d) => d.startsWith(basename(dir)) && d.includes(".stale-"),
  );
  assert.equal(archived.length, 1);
  assert.equal(existsSync(join(dirname(dir), archived[0]!, "journal.jsonl")), true);
});

test("a branch can be run again once the first run is no longer live", () => {
  const dir = tmpRunDir();
  const first = withPinnedRunId(mintRunId(), () => resolveRunId(dir));

  // Second request on the same branch: the service mints a fresh id and the dir is in the way.
  const second = mintRunId();
  const got = withPinnedRunId(second, () => resolveRunId(dir));

  assert.equal(got, second, "the new run must start, not inherit the finished run's identity");
  assert.notEqual(got, first);

  // the previous run is preserved beside it rather than destroyed
  const archived = readdirSync(dirname(dir)).filter(
    (d) => d.startsWith(basename(dir)) && d.includes(".stale-"),
  );
  assert.equal(archived.length, 1, "the finished run dir is archived, not deleted");
  assert.equal(
    readFileSync(join(dirname(dir), archived[0]!, ".run_id"), "utf8").trim(),
    first,
    "and it still holds the run it belonged to",
  );
});

test("a LIVE run is still protected — archiving must not hijack a run in flight", () => {
  const dir = tmpRunDir();
  const established = withPinnedRunId(mintRunId(), () => resolveRunId(dir));

  // Something is driving it: a lock held by a process that exists.
  mkdirSync(join(dir, ".orchestrator.lock"), { recursive: true });
  writeFileSync(join(dir, ".orchestrator.lock", "pid"), `${process.pid}\n`);

  assert.throws(
    () => withPinnedRunId(mintRunId(), () => resolveRunId(dir)),
    (err: unknown) => err instanceof RunIdConflictError && /LIVE/.test((err as Error).message),
    "rebinding a run in flight is the case the original guard existed for",
  );
  // and it is untouched
  assert.equal(withPinnedRunId(undefined, () => resolveRunId(dir)), established);
});

test("a crashed run's dir does not block its own retry", () => {
  const dir = tmpRunDir();
  withPinnedRunId(mintRunId(), () => resolveRunId(dir));
  // A crash leaves the lock behind with a pid that is gone. Refusing here would mean the one run
  // that most needs retrying is the one that cannot be.
  mkdirSync(join(dir, ".orchestrator.lock"), { recursive: true });
  writeFileSync(join(dir, ".orchestrator.lock", "pid"), "999999\n");

  const retry = mintRunId();
  assert.equal(withPinnedRunId(retry, () => resolveRunId(dir)), retry);
});
