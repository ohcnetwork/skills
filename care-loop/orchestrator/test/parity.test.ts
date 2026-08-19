// parity.test.ts — PLAN-sqlite-run-store.md §10 items 6-7. The pure diff, plus the two-phase policy
// that matters: run.resume THROWS (the DB is about to reconstruct a run, so proceeding would be
// wrong), run.end RECORDS (both writes already committed — it is a detector, not a guard), and an
// unreadable replica warns at both phases rather than failing a run over a degraded backup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openRun } from "../src/run-context.ts";
import { Journal, type JournalEvent } from "../src/journal.ts";
import { SqliteRunStore, setActiveRunStore } from "../src/run-store.ts";
import { mintRunId } from "../src/run-id.ts";
import {
  checkParity,
  assertParity,
  parityWarning,
  ParityError,
} from "../src/parity.ts";

function tmpRunDir(): string {
  return mkdtempSync(join(tmpdir(), "careloopd-parity-"));
}
function tmpDb(): string {
  return join(tmpdir(), `careloopd-parity-${Date.now()}-${Math.random()}.db`);
}
function rawDb(store: SqliteRunStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}

/** Capture console.error for the duration of `fn` — the warn paths are observable only there. */
function captureWarnings(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

function startRun(runDir: string, runId: string): Record<string, unknown> {
  return {
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
  };
}

/** A live run with a real store, seeded with run.start + two more events. */
function seededRun(): { j: Journal; runId: string; store: SqliteRunStore; runDir: string } {
  const runDir = tmpRunDir();
  const store = new SqliteRunStore(tmpDb());
  setActiveRunStore(store);
  const { journal: j, runId } = openRun(runDir);
  j.append({ event: "run.start", step: "1", round: 1, data: startRun(runDir, runId) });
  j.append({ event: "step.enter", step: "2", round: 1 });
  j.append({ event: "step.exit", step: "2", round: 1 });
  return { j, runId, store, runDir };
}

// ── the pure function ────────────────────────────────────────────────────────
// run.start must carry data.state — projectState folds from it, and a stream without one makes BOTH
// sides fail to project, which checkParity reports as a divergence rather than a match.
const ev = (seq: number, event: string, data?: Record<string, unknown>): JournalEvent =>
  ({
    seq,
    ts: `2026-08-19T00:00:0${seq}Z`,
    run_id: "r",
    event,
    prev: "x",
    ...(data ? { data } : {}),
  }) as JournalEvent;

// A real ULID: validateState rejects anything else, and a rejected state makes projectState throw —
// which checkParity reports as a divergence even when BOTH sides fail identically.
const PURE_RUN_ID = mintRunId();
const startEv = () => ev(0, "run.start", startRun("/tmp/wt", PURE_RUN_ID));

test("checkParity: identical event streams are clean", () => {
  const a = [startEv(), ev(1, "step.enter")];
  assert.equal(checkParity(a, [...a]).ok, true);
});

test("checkParity: same length, different content — caught by the fold, not the count", () => {
  const diverged = startRun("/tmp/wt", PURE_RUN_ID);
  (diverged.state as Record<string, unknown>).pr = 42; // the replica saw a PR the DB never recorded
  const a = [startEv(), ev(1, "step.enter")];
  const b = [ev(0, "run.start", diverged), ev(1, "step.enter")];
  const r = checkParity(a, b);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /projected state mismatch/);
});

test("checkParity: an empty pair is vacuously clean", () => {
  assert.equal(checkParity([], []).ok, true);
});

test("checkParity: a count mismatch is reported before any folding", () => {
  const r = checkParity([startEv(), ev(1, "step.enter")], [startEv()]);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /event count mismatch: replica=2 db=1/);
});

test("assertParity: throws ParityError naming the phase", () => {
  assert.throws(
    () => assertParity([startEv()], [], "run.resume"),
    (e: unknown) => e instanceof ParityError && /run\.resume parity check failed/.test((e as Error).message),
  );
});

test("parityWarning: both phases share one operator-facing wording", () => {
  assert.match(parityWarning("run.end", "boom"), /PARITY \(run\.end\).*boom/);
  assert.match(parityWarning("run.resume", "boom"), /PARITY \(run\.resume\).*boom/);
});

// ── the two-phase policy, end to end ─────────────────────────────────────────
test("run.resume THROWS when the replica and the DB disagree", () => {
  const { j, runId, store } = seededRun();
  // Diverge by deleting a MIDDLE event from the DB: the replica keeps all three, and getLastEvent
  // still returns the true tail, so seq/prev stay consistent and only the counts differ.
  rawDb(store).exec(`DELETE FROM run_events WHERE run_id = '${runId}' AND seq = 1`);

  assert.throws(
    () => j.append({ event: "run.resume", step: "2", round: 1 }),
    (e: unknown) => e instanceof ParityError && /run\.resume parity check failed/.test((e as Error).message),
  );
});

test("run.end RECORDS the divergence on runs.parity_error and does NOT throw", () => {
  const { j, runId, store } = seededRun();
  rawDb(store).exec(`DELETE FROM run_events WHERE run_id = '${runId}' AND seq = 1`);

  const warnings = captureWarnings(() => {
    j.append({ event: "run.end", step: "merged", round: 1, data: { outcome: "merged" } });
  });

  assert.ok(
    warnings.some((w) => /PARITY \(run\.end\)/.test(w)),
    "expected a loud warning on the run.end divergence",
  );
  const row = rawDb(store)
    .prepare("SELECT parity_error FROM runs WHERE run_id = ?")
    .get(runId) as unknown as { parity_error: string | null };
  assert.match(row.parity_error ?? "", /event count mismatch/);
});

test("run.end leaves parity_error NULL when the run is clean", () => {
  const { j, runId, store } = seededRun();
  j.append({ event: "run.end", step: "merged", round: 1, data: { outcome: "merged" } });
  const row = rawDb(store)
    .prepare("SELECT parity_error FROM runs WHERE run_id = ?")
    .get(runId) as unknown as { parity_error: string | null };
  assert.equal(row.parity_error, null);
});

test("an UNREADABLE replica warns and never throws — a degraded backup is not a corrupt truth", () => {
  for (const phase of ["run.end", "run.resume"] as const) {
    const { j, runDir } = seededRun();
    // Corrupt a MID-CHAIN line (not the tail, which append() repairs): readReplica throws
    // JournalCorruptionError, which must NOT propagate out of append.
    const path = join(runDir, "journal.jsonl");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    lines[0] = "{not json";
    writeFileSync(path, lines.join("\n") + "\n");

    const warnings = captureWarnings(() => {
      j.append({ event: phase, step: "2", round: 1 });
    });
    assert.ok(
      warnings.some((w) => new RegExp(`PARITY \\(${phase.replace(".", "\\.")}\\).*replica unreadable`).test(w)),
      `expected an unreadable-replica warning at ${phase}, got: ${JSON.stringify(warnings)}`,
    );
  }
});

// ── the migration ────────────────────────────────────────────────────────────
test("migrate(): a v1 database gains parity_error and reaches user_version 2", () => {
  const dbPath = tmpDb();
  // Build a v1-shaped DB by hand: `runs` WITHOUT parity_error, user_version = 1. SCHEMA's
  // CREATE TABLE IF NOT EXISTS leaves it alone, so this is the real upgrade path.
  const seed = new SqliteRunStore(dbPath);
  rawDb(seed).exec("DROP TABLE runs");
  rawDb(seed).exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, slug TEXT NOT NULL, requested_by TEXT, repo TEXT NOT NULL,
      branch TEXT NOT NULL, tier TEXT NOT NULL, step TEXT NOT NULL, round INTEGER NOT NULL,
      pr INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version = 1;`);
  seed.close();

  const upgraded = new SqliteRunStore(dbPath);
  const cols = rawDb(upgraded)
    .prepare("SELECT name FROM pragma_table_info('runs')")
    .all() as unknown as { name: string }[];
  assert.ok(cols.some((c) => c.name === "parity_error"), "parity_error column was not added");
  const [{ user_version: version }] = rawDb(upgraded)
    .prepare("PRAGMA user_version")
    .all() as unknown as { user_version: number }[];
  assert.equal(version, 2);
  upgraded.close();
});

test("migrate(): is idempotent — reopening an already-migrated DB is a no-op", () => {
  const dbPath = tmpDb();
  new SqliteRunStore(dbPath).close();
  const reopened = new SqliteRunStore(dbPath); // must not throw "duplicate column name"
  const [{ user_version: version }] = rawDb(reopened)
    .prepare("PRAGMA user_version")
    .all() as unknown as { user_version: number }[];
  assert.equal(version, 2);
  reopened.close();
});
