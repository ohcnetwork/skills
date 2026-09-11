import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  SqliteRunStore,
  NullRunStore,
  rollupsFromEvents,
  setActiveRunStore,
  getActiveRunStore,
  openRunStore,
} from "../src/run-store.ts";
import { validateState, type CareState } from "../src/state.ts";
import type { JournalEvent } from "../src/journal.ts";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-runstore-"));
  return join(dir, "loops.db");
}

const BASE_STATE: Partial<CareState> = {
  task: "Consolidate PrintInvoice (ENG-729)",
  repo: "ohcnetwork/care_fe",
  branch: "eng-729/consolidate",
  worktree: "/tmp/wt",
  tier: "standard",
  pr: null,
  round: 1,
  step: "1",
  head_sha: "abc123",
  last_reviewed_sha: "",
};

test("SqliteRunStore.seedRun then appendEvent: runs row exists before the event row (FK never dangles)", () => {
  const dbPath = tmpDbPath();
  const store = new SqliteRunStore(dbPath);
  const state = validateState(BASE_STATE);

  store.seedRun("care_fe-eng-729-consolidate", state);

  const ev: JournalEvent = {
    seq: 0,
    ts: state.started_at,
    run_id: state.run_id,
    event: "run.start",
    step: "1",
    round: 1,
    data: { state },
    prev: "sha256:genesis",
  };
  store.appendEvent(state.run_id, ev, { deltaMs: 0, costUsd: 0 });

  const rawDb = store.raw();
  const row = rawDb.prepare("SELECT * FROM runs WHERE run_id = ?").get(state.run_id) as any;
  assert.equal(row.slug, "care_fe-eng-729-consolidate");
  assert.equal(row.event_count, 1);
  const detail = rawDb
    .prepare("SELECT * FROM run_detail WHERE run_id = ?")
    .get(state.run_id) as any;
  assert.equal(detail.task, BASE_STATE.task);
  const eventRow = rawDb
    .prepare("SELECT * FROM run_events WHERE run_id = ? AND seq = 0")
    .get(state.run_id) as any;
  assert.equal(eventRow.event, "run.start");
  store.close();
});

test("appendEvent without a seeded parent row throws (FK enforced) — caller swallows it, best-effort", () => {
  const dbPath = tmpDbPath();
  const store = new SqliteRunStore(dbPath);
  const ev: JournalEvent = {
    seq: 0,
    ts: new Date().toISOString(),
    run_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    event: "step.enter",
    prev: "sha256:genesis",
  };
  assert.throws(() => store.appendEvent("01ARZ3NDEKTSV4RRFFQ69G5FAV", ev, { deltaMs: 0, costUsd: 0 }));
  store.close();
});

test("appendEvent increments event_count / cost_usd / duration_ms incrementally", () => {
  const dbPath = tmpDbPath();
  const store = new SqliteRunStore(dbPath);
  const state = validateState(BASE_STATE);
  store.seedRun("slug", state);

  const mk = (seq: number, ts: string, event: JournalEvent["event"], data?: Record<string, unknown>): JournalEvent => ({
    seq,
    ts,
    run_id: state.run_id,
    event,
    data,
    prev: `sha256:x${seq}`,
  });

  store.appendEvent(state.run_id, mk(0, "2026-08-19T00:00:00.000Z", "run.start"), {
    deltaMs: 0,
    costUsd: 0,
  });
  store.appendEvent(
    state.run_id,
    mk(1, "2026-08-19T00:00:05.000Z", "skill.result", { cost_usd: 0.42 }),
    { deltaMs: 5000, costUsd: 0.42 },
  );
  store.appendEvent(state.run_id, mk(2, "2026-08-19T00:00:07.000Z", "step.enter"), {
    deltaMs: 2000,
    costUsd: 0,
  });

  const rawDb = store.raw();
  const row = rawDb.prepare("SELECT * FROM runs WHERE run_id = ?").get(state.run_id) as any;
  assert.equal(row.event_count, 3);
  assert.equal(row.cost_usd, 0.42);
  assert.equal(row.duration_ms, 7000);
  assert.equal(row.updated_at, "2026-08-19T00:00:07.000Z");
  store.close();
});

test("upsertRun (full recompute) reconciles rollups regardless of what appendEvent left", () => {
  const dbPath = tmpDbPath();
  const store = new SqliteRunStore(dbPath);
  const state = validateState(BASE_STATE);
  store.seedRun("slug", state);
  // simulate drift: bump event_count without going through appendEvent
  const rawDb = store.raw();
  rawDb.prepare("UPDATE runs SET event_count = 999 WHERE run_id = ?").run(state.run_id);

  store.upsertRun("slug", state, { eventCount: 3, costUsd: 1.5, durationMs: 4000 });
  const row = rawDb.prepare("SELECT * FROM runs WHERE run_id = ?").get(state.run_id) as any;
  assert.equal(row.event_count, 3);
  assert.equal(row.cost_usd, 1.5);
  assert.equal(row.duration_ms, 4000);
  store.close();
});

test("rollupsFromEvents sums skill.result cost_usd and active duration, dropping run.resume gaps", () => {
  const events: JournalEvent[] = [
    { seq: 0, ts: "2026-08-19T00:00:00.000Z", run_id: "r", event: "run.start", prev: "sha256:genesis" },
    { seq: 1, ts: "2026-08-19T00:00:10.000Z", run_id: "r", event: "skill.result", data: { cost_usd: 1.2 }, prev: "x" },
    // a resume boundary after a long idle gap — should NOT count toward duration
    { seq: 2, ts: "2026-08-19T05:00:00.000Z", run_id: "r", event: "run.resume", prev: "x" },
    { seq: 3, ts: "2026-08-19T05:00:03.000Z", run_id: "r", event: "skill.result", data: { cost_usd: 0.3 }, prev: "x" },
  ];
  const r = rollupsFromEvents(events);
  assert.equal(r.eventCount, 4);
  assert.equal(r.costUsd, 1.5);
  // gap 0→1 (10s) counts; gap 1→2 is dropped because event 2 IS the run.resume; gap 2→3 (3s,
  // the real work done right after resuming) counts — matching dashboard.ts's pre-existing fold.
  assert.equal(r.durationMs, 13_000);
});

test("NullRunStore is a total no-op and never throws", () => {
  const store = new NullRunStore();
  const state = validateState(BASE_STATE);
  assert.doesNotThrow(() => {
    store.seedRun("slug", state);
    store.upsertRun("slug", state, { eventCount: 0, costUsd: 0, durationMs: 0 });
    store.appendEvent("r", {
      seq: 0,
      ts: new Date().toISOString(),
      run_id: "r",
      event: "run.start",
      prev: "sha256:genesis",
    }, { deltaMs: 0, costUsd: 0 });
    store.close();
  });
});

test("openRunStore opens a real SqliteRunStore when given a writable path", () => {
  const dbPath = tmpDbPath();
  const store = openRunStore(dbPath);
  assert.ok(store instanceof SqliteRunStore);
  assert.equal(existsSync(dbPath), true);
  store.close();
});

test("openRunStore throws when a given dbPath can't be opened (fatal — DB is truth now, not a silent fallback)", () => {
  assert.throws(() => openRunStore("/nonexistent-root-dir-xyz/loops.db"));
});

test("setActiveRunStore / getActiveRunStore round-trip", () => {
  const store = new NullRunStore();
  setActiveRunStore(store);
  assert.equal(getActiveRunStore(), store);
  // reset to a fresh NullRunStore so other test files aren't affected by import order
  setActiveRunStore(new NullRunStore());
});

// ── migrate() ─────────────────────────────────────────────────────────────────────────────────────
// Relocated here when parity.test.ts was deleted: these exercise the migration hook, not the
// parity check that happened to be its first customer.

test("migrate(): a legacy database drops parity_error and reaches the current user_version", () => {
  const dbPath = tmpDbPath();
  // Build a v6-shaped DB by hand: `runs` WITH parity_error, user_version = 6. SCHEMA's
  // CREATE TABLE IF NOT EXISTS leaves it alone, so this is the real upgrade path.
  const seed = new SqliteRunStore(dbPath);
  seed.raw().exec("DROP TABLE runs");
  seed.raw().exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, slug TEXT NOT NULL, requested_by TEXT, repo TEXT NOT NULL,
      branch TEXT NOT NULL, tier TEXT NOT NULL, step TEXT NOT NULL, round INTEGER NOT NULL,
      pr INTEGER, started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0, parity_error TEXT
    );
    PRAGMA user_version = 6;`);
  seed.close();

  const upgraded = new SqliteRunStore(dbPath);
  const cols = upgraded
    .raw()
    .prepare("SELECT name FROM pragma_table_info('runs')")
    .all() as unknown as { name: string }[];
  assert.ok(
    !cols.some((c) => c.name === "parity_error"),
    "parity_error column was not dropped",
  );
  const [{ user_version: version }] = upgraded
    .raw()
    .prepare("PRAGMA user_version")
    .all() as unknown as { user_version: number }[];
  assert.equal(version, SCHEMA_VERSION);
  upgraded.close();
});

test("migrate(): is idempotent — reopening an already-migrated DB is a no-op", () => {
  const dbPath = tmpDbPath();
  new SqliteRunStore(dbPath).close();
  const reopened = new SqliteRunStore(dbPath); // must not throw
  const [{ user_version: version }] = reopened
    .raw()
    .prepare("PRAGMA user_version")
    .all() as unknown as { user_version: number }[];
  assert.equal(version, SCHEMA_VERSION);
  reopened.close();
});
