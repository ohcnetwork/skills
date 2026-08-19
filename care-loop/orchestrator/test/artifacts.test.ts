// test/artifacts.test.ts — skill artifact BODIES in the db ([[PLAN-loop-service]] §6).
//
// The service reads the database and nothing else, so the content a `skill.result` event REFERS to
// has to be reachable there. Three things are load-bearing and each is asserted here: the write path
// mirrors every sidecar into `run_artifacts`, `reindex` restores them from disk (which is what keeps
// them rebuildable rather than joining `queue`/`gate_asks` as data no rebuild can recover), and the
// column really is jsonb rather than text that merely looks like it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SqliteRunStore, setActiveRunStore } from "../src/run-store.ts";
import { SqliteRunIndex } from "../src/run-index.ts";
import { makeSkillLogger } from "../src/skill-log.ts";
import { reindexRuns } from "../src/reindex.ts";
import { openRun } from "../src/run-context.ts";
import { mintRunId } from "../src/run-id.ts";
import { validateState, type CareState } from "../src/state.ts";
import { useRealStore } from "./_store.ts";

function stateFor(over: Partial<CareState> = {}): CareState {
  return validateState({
    task: "seed", repo: "ohcnetwork/care_fe", branch: "b", worktree: "/tmp/wt",
    tier: "standard", pr: null, round: 1, step: "2", head_sha: "abc", last_reviewed_sha: "",
    run_id: mintRunId(), requested_by: null, ticket: null, summary: null, ...over,
  });
}

test("artifact() writes the sidecar AND mirrors the body into run_artifacts", () => {
  const store = useRealStore();
  const runDir = mkdtempSync(join(tmpdir(), "careloopd-art-"));
  const state = stateFor();
  store.seedRun("care_fe-b", state);

  const logger = makeSkillLogger({ runDir, runId: state.run_id });
  const ref = logger.artifact("care-reviewer-r1.result.json", { verdict: "pass", findings: [1, 2] });

  // the sidecar is still written — the doctor reads these by path, and they are what `reindex`
  // rebuilds from
  const sidecar = join(runDir, "skills", "care-reviewer-r1.result.json");
  assert.equal(existsSync(sidecar), true);
  assert.equal(ref.path, "skills/care-reviewer-r1.result.json");
  assert.equal(ref.name, "care-reviewer-r1.result");

  // the hash is over the sidecar text, so the ref addresses both copies
  const text = readFileSync(sidecar, "utf8");
  assert.equal(ref.sha256, "sha256:" + createHash("sha256").update(text, "utf8").digest("hex"));

  const index = new SqliteRunIndex((store as unknown as { db: DatabaseSync }).db);
  const body = index.artifact(state.run_id, ref.sha256);
  assert.deepEqual(body?.content, { verdict: "pass", findings: [1, 2] });
  assert.equal(body?.bytes, Buffer.byteLength(text, "utf8"));
});

test("content is stored as jsonb, queryable with json_extract without a reparse", () => {
  const store = useRealStore();
  const state = stateFor();
  store.seedRun("care_fe-b", state);
  store.putArtifact(state.run_id, {
    path: "skills/x.json",
    name: "x",
    sha256: "sha256:" + "a".repeat(64),
    content: JSON.stringify({ nested: { verdict: "decline" } }),
  });
  const db = (store as unknown as { db: DatabaseSync }).db;

  // BLOB, not TEXT — a string here would mean jsonb() silently did not run
  const typed = db
    .prepare("SELECT typeof(content) AS t FROM run_artifacts WHERE run_id = ?")
    .get(state.run_id) as { t: string };
  assert.equal(typed.t, "blob");

  const x = db
    .prepare("SELECT json_extract(content, '$.nested.verdict') AS v FROM run_artifacts WHERE run_id = ?")
    .get(state.run_id) as { v: string };
  assert.equal(x.v, "decline");
});

test("putArtifact is idempotent on (run_id, path) — a replayed step overwrites, never duplicates", () => {
  const store = useRealStore();
  const state = stateFor();
  store.seedRun("care_fe-b", state);
  const row = { path: "skills/a.json", name: "a", sha256: "sha256:" + "b".repeat(64) };
  store.putArtifact(state.run_id, { ...row, content: JSON.stringify({ v: 1 }) });
  store.putArtifact(state.run_id, { ...row, content: JSON.stringify({ v: 2 }) });

  const index = new SqliteRunIndex((store as unknown as { db: DatabaseSync }).db);
  const all = index.artifacts(state.run_id);
  assert.equal(all.length, 1, "same path must not create a second row");
  assert.deepEqual(index.artifact(state.run_id, row.sha256)?.content, { v: 2 });
});

test("two artifacts with identical content stay two rows (why the PK is path, not sha)", () => {
  const store = useRealStore();
  const state = stateFor();
  store.seedRun("care_fe-b", state);
  const same = JSON.stringify({ unchanged: true });
  const sha = "sha256:" + "c".repeat(64);
  store.putArtifact(state.run_id, { path: "skills/r1.input.json", name: "r1.input", sha256: sha, content: same });
  store.putArtifact(state.run_id, { path: "skills/r2.input.json", name: "r2.input", sha256: sha, content: same });

  const index = new SqliteRunIndex((store as unknown as { db: DatabaseSync }).db);
  assert.equal(index.artifacts(state.run_id).length, 2);
});

test("artifacts() lists metadata only — a timeline must not stream every body", () => {
  const store = useRealStore();
  const state = stateFor();
  store.seedRun("care_fe-b", state);
  store.putArtifact(state.run_id, {
    path: "skills/a.json", name: "a", sha256: "sha256:" + "d".repeat(64),
    content: JSON.stringify({ big: "x".repeat(1000) }),
  });
  const index = new SqliteRunIndex((store as unknown as { db: DatabaseSync }).db);
  const [only] = index.artifacts(state.run_id);
  assert.deepEqual(Object.keys(only).sort(), ["bytes", "name", "path", "sha256"]);
});

test("reindex restores artifacts from the sidecars — rm loops.db && reindex stays lossless", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "careloopd-reidx-"));
  const dbPath = join(runsDir, "loops.db");
  const slug = "care_fe-b";
  const runDir = join(runsDir, slug);
  mkdirSync(runDir, { recursive: true });

  // live a run: journal + two artifacts
  const live = new SqliteRunStore(dbPath);
  setActiveRunStore(live);
  const { journal, runId } = openRun(runDir);
  journal.append({
    event: "run.start", step: "1", round: 1,
    data: { state: stateFor({ run_id: runId }) },
  });
  const logger = makeSkillLogger({ runDir, runId });
  logger.artifact("care-reviewer-r1.input.json", { diff: "a diff" });
  logger.artifact("care-reviewer-r1.result.json", { verdict: "pass" });
  assert.equal(new SqliteRunIndex(live.raw()).artifacts(runId).length, 2);
  live.close();

  // nuke the db and rebuild from the run dir alone
  const rebuilt = new SqliteRunStore(dbPath);
  setActiveRunStore(rebuilt);
  const result = reindexRuns(rebuilt, runsDir);
  assert.equal(result.runsIndexed, 1);
  assert.equal(result.artifactsIndexed, 2);

  const index = new SqliteRunIndex(rebuilt.raw());
  const restored = index.artifacts(runId);
  assert.equal(restored.length, 2);
  // and the body survives the round trip through the file
  const input = restored.find((a) => a.path.endsWith("input.json"))!;
  assert.deepEqual(index.artifact(runId, input.sha256)?.content, { diff: "a diff" });
  rebuilt.close();
});

test("reindex skips a non-JSON sidecar without losing the run", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "careloopd-reidx2-"));
  const dbPath = join(runsDir, "loops.db");
  const runDir = join(runsDir, "care_fe-b");
  mkdirSync(join(runDir, "skills"), { recursive: true });

  const live = new SqliteRunStore(dbPath);
  setActiveRunStore(live);
  const { journal, runId } = openRun(runDir);
  journal.append({ event: "run.start", step: "1", round: 1, data: { state: stateFor({ run_id: runId }) } });
  live.close();

  // a legacy sidecar from before artifact() took a value: not JSON at all
  writeFileSync(join(runDir, "skills", "legacy.json"), "this is not json");
  writeFileSync(join(runDir, "skills", "good.json"), JSON.stringify({ ok: true }));

  const rebuilt = new SqliteRunStore(dbPath);
  setActiveRunStore(rebuilt);
  const result = reindexRuns(rebuilt, runsDir);
  assert.equal(result.runsIndexed, 1, "the run itself must still index");
  assert.equal(result.artifactsIndexed, 1, "only the parseable sidecar lands");
  assert.deepEqual(result.runsSkipped, []);
  rebuilt.close();
});
