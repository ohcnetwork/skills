import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Journal,
  JournalCorruptionError,
  serializeEvent,
  GENESIS,
} from "../src/journal.ts";
import { SqliteRunStore, setActiveRunStore } from "../src/run-store.ts";
import { mintRunId } from "../src/run-id.ts";

// journal.test.ts exercises the REPLICA's own crash-recovery/hash-chain properties (§10 cutover:
// `read()` is DB-backed now, so these assertions go through `readReplica()`, the file-parsing path
// that still has the torn-tail/corruption semantics). `append()` still needs a REAL store, though —
// `seq`/`prev`/`deltaMs` are sourced from the store's last event for the run (§10 item 2), so a
// fresh `:memory:` store per test is what makes sequential appends actually sequence. The Journal's
// run_id must be a real ULID now (not the old free-text "run-test") so a run.start's `data.state`
// seed doesn't get backfilled to a DIFFERENT id than what `run_events` inserts reference (§4's FK).
function freshJournal(): { j: Journal; dir: string; runId: string } {
  setActiveRunStore(new SqliteRunStore(":memory:"));
  const dir = mkdtempSync(join(tmpdir(), "careloopd-jrnl-"));
  const runId = mintRunId();
  return { j: new Journal(join(dir, "journal.jsonl"), runId), dir, runId };
}

/** Minimal valid seed for a run.start's data.state — just enough for validateState to accept it (and
 *  to match the Journal's OWN run_id, so seedRun's parent row and appendEvent's FK reference agree). */
const minSeed = (runId: string) => ({ task: "t", repo: "a/b", step: "1" as const, run_id: runId });

test("append fills seq/prev/ts and chains from GENESIS", () => {
  const { j, runId } = freshJournal();
  const a = j.append({
    event: "run.start",
    data: { state: minSeed(runId) },
  });
  const b = j.append({
    event: "step.enter",
    step: "1",
    round: 1,
  });

  assert.equal(a.seq, 0);
  assert.equal(a.prev, GENESIS);
  assert.equal(b.seq, 1);
  assert.notEqual(b.prev, GENESIS);
  assert.match(b.prev, /^sha256:[0-9a-f]{64}$/);
  assert.ok(a.ts && b.ts);
});

test("read() returns the full intact chain", () => {
  const { j, runId } = freshJournal();
  j.append({ event: "run.start", data: { state: minSeed(runId) } });
  j.append({ event: "step.enter", step: "1", round: 1 });
  j.append({ event: "step.exit", step: "1", round: 1 });

  const { events, truncatedTail } = j.readReplica();
  assert.equal(events.length, 3);
  assert.equal(truncatedTail, false);
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1, 2],
  );
});

test("crash-mid-append: a torn FINAL line is dropped, head degrades to the previous entry", () => {
  const { j, runId } = freshJournal();
  j.append({ event: "run.start", data: { state: minSeed(runId) } });
  const good = j.append({
    event: "step.enter",
    step: "1",
    round: 1,
  });
  // simulate a half-written final line (power loss mid-fsync): append a partial JSON fragment
  appendFileSync(
    j.path,
    `{"seq":2,"ts":"2026-07-13T00:00:00.000Z","run_id":"${runId}","eve`,
  );

  const { events, truncatedTail } = j.readReplica();
  assert.equal(truncatedTail, true);
  assert.equal(events.length, 2);
  // the DB never saw the raw-file-injected torn line (it bypassed Journal.append entirely), so the
  // DB-backed head() still correctly reports the last REAL append.
  assert.equal(j.head()!.seq, good.seq);

  // and we can append again cleanly after recovery
  const next = j.append({
    event: "step.exit",
    step: "1",
    round: 1,
  });
  // seq continues from the DB's last real event — the torn fragment was never in the DB, so there's
  // no "slot" it could have claimed.
  assert.equal(next.seq, 2);
});

test("mid-chain corruption (tampered line) throws, not silently recovered", () => {
  const { j, runId } = freshJournal();
  j.append({ event: "run.start", data: { state: minSeed(runId) } });
  j.append({ event: "step.enter", step: "1", round: 1 });
  j.append({ event: "step.exit", step: "1", round: 1 });

  // tamper with the MIDDLE line: rewrite its data so its bytes no longer match line-2's prev hash
  const lines = readFileSync(j.path, "utf8").split("\n").filter(Boolean);
  const mid = JSON.parse(lines[1]);
  mid.data = { tampered: true };
  lines[1] = serializeEvent(mid);
  writeFileSync(j.path, lines.join("\n") + "\n");

  assert.throws(() => j.readReplica(), JournalCorruptionError);
});

test("property: N appends verify, and truncating the last line recovers to N-1", () => {
  for (const N of [1, 2, 5, 13, 40]) {
    const { j, runId } = freshJournal();
    j.append({ event: "run.start", data: { state: minSeed(runId) } });
    for (let i = 1; i < N; i++) {
      j.append({
        event: "budget.tick",
        cost_cum: { usd_est: i * 0.01 },
      });
    }
    const before = j.readReplica();
    assert.equal(before.events.length, N);
    assert.equal(before.truncatedTail, false);

    if (N >= 2) {
      // lop the trailing newline + half of the last line
      const raw = readFileSync(j.path, "utf8").replace(/\n$/, "");
      const cut = raw.slice(
        0,
        raw.length - Math.ceil((raw.length - raw.lastIndexOf("\n")) / 2),
      );
      writeFileSync(j.path, cut + "\n");
      const after = j.readReplica();
      assert.equal(after.truncatedTail, true);
      assert.equal(after.events.length, N - 1);
    }
  }
});
