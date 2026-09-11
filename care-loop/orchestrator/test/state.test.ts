import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "../src/journal.ts";
import { SqliteRunStore, setActiveRunStore } from "../src/run-store.ts";
import { mintRunId } from "../src/run-id.ts";
import {
  projectState,
  projectAndWrite,
  validateState,
  writeStateFile,
  StateValidationError,
  KEY_ORDER,
  type CareState,
} from "../src/state.ts";
import { renderLoopLog } from "../src/render.ts";

const RUN_ID = mintRunId();

const BASE = {
  task: "Consolidate PrintInvoice (ENG-729)",
  repo: "ohcnetwork/care_fe",
  branch: "eng-729/consolidate",
  worktree: "/tmp/wt",
  tier: "standard" as const,
  pr: null,
  round: 1,
  step: "1" as const,
  head_sha: "abc123",
  last_reviewed_sha: "",
  run_id: RUN_ID,
};

function seeded(): { j: Journal; dir: string } {
  setActiveRunStore(new SqliteRunStore(":memory:"));
  const dir = mkdtempSync(join(tmpdir(), "careloopd-state-"));
  const j = new Journal(join(dir, "journal.jsonl"), RUN_ID);
  j.append({
    event: "run.start",
    step: "1",
    round: 1,
    data: { state: BASE },
  });
  return { j, dir };
}

test("projectState folds run.start + step.enter into a valid head state", () => {
  const { j } = seeded();
  j.append({ event: "step.exit", step: "1", round: 1 });
  j.append({ event: "step.enter", step: "3", round: 1 });
  j.append({ event: "step.enter", step: "4a", round: 1 });

  const s = projectState(j.read().events);
  assert.equal(s.step, "4a");
  assert.equal(s.task, BASE.task);
  assert.equal(s.repo, "ohcnetwork/care_fe");
  assert.equal(s.pr, null);
});

test("a data.state patch updates head_sha / pr without a bespoke rule", () => {
  const { j } = seeded();
  j.append({ event: "step.enter", step: "5", round: 1 });
  j.append({
    event: "push",
    data: { state: { head_sha: "def456", pr: 16546, step: "5-await" } },
  });

  const s = projectState(j.read().events);
  assert.equal(s.head_sha, "def456");
  assert.equal(s.pr, 16546);
  assert.equal(s.step, "5-await");
});

test("updated_at tracks the last event ts", () => {
  const { j } = seeded();
  const last = j.append({
    event: "step.enter",
    step: "3",
    round: 1,
  });
  const s = projectState(j.read().events);
  assert.equal(s.updated_at, last.ts);
});

test("state.json is written in canonical key order, atomically", () => {
  const { j, dir } = seeded();
  const s = projectAndWrite(dir, j.read().events);
  const onDisk = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.deepEqual(Object.keys(onDisk), [...KEY_ORDER]);
  assert.equal(onDisk.step, s.step);
  assert.equal(onDisk.pr, null);
});

test("replay is deterministic: same journal → byte-identical state.json", () => {
  const { j, dir } = seeded();
  j.append({ event: "step.enter", step: "4a", round: 1 });
  const events = j.read().events;

  const a = projectState(events);
  const b = projectState(events);
  assert.deepEqual(a, b);

  writeStateFile(dir, a);
  const first = readFileSync(join(dir, "state.json"), "utf8");
  writeStateFile(dir, b);
  const second = readFileSync(join(dir, "state.json"), "utf8");
  assert.equal(first, second);
});

test("validateState rejects schema drift (out-of-vocab step, URL pr, ad-hoc key)", () => {
  assert.throws(
    () => validateState({ ...BASE, step: "5-waiting-ci" as any }),
    StateValidationError,
  );
  assert.throws(
    () => validateState({ ...BASE, pr: "https://gh/pr/1" as any }),
    StateValidationError,
  );
  assert.throws(
    () => validateState({ ...BASE, pr_number: 16546 } as any),
    StateValidationError,
  );
  assert.throws(
    () => validateState({ ...BASE, repo: "care_fe" }),
    StateValidationError,
  );
});

test("projectState throws on an empty journal", () => {
  assert.throws(() => projectState([]), StateValidationError);
});

test("renderLoopLog produces one line per event", () => {
  const { j } = seeded();
  j.append({ event: "step.enter", step: "3", round: 1 });
  j.append({
    event: "spawn.result",
    data: { role: "care-reviewer", verdict: "findings" },
  });
  const log = renderLoopLog(j.read().events);
  const lines = log.trimEnd().split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /→ step 3/);
  assert.match(lines[2], /care-reviewer → findings/);
});

// Regression: `started_at` must be the JOURNAL's first timestamp, not the value `run.start` happens
// to carry in its `data.state`. Those differ — the CareState is constructed a moment before append()
// stamps the event — and the fold used to let the payload win, so `runs.started_at` disagreed with
// `events[0].ts` (caught in the live salvage run of 2026-08-19: 1ms, but unbounded in principle).
test("projectState: started_at is events[0].ts, not run.start's own state payload", () => {
  const events = [
    {
      seq: 0,
      ts: "2026-08-19T19:56:03.625Z", // the journal's truth
      run_id: RUN_ID,
      event: "run.start",
      prev: "sha256:genesis",
      data: {
        state: {
          ...BASE,
          started_at: "2026-08-19T19:56:03.624Z", // built 1ms earlier — must NOT win
        },
      },
    },
    {
      seq: 1,
      ts: "2026-08-19T19:57:00.000Z",
      run_id: RUN_ID,
      event: "step.enter",
      step: "2",
      round: 1,
      prev: "sha256:x",
    },
  ] as unknown as Parameters<typeof projectState>[0];

  const st = projectState(events);
  assert.equal(st.started_at, "2026-08-19T19:56:03.625Z");
  assert.equal(st.updated_at, "2026-08-19T19:57:00.000Z");
});
