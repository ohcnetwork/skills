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

function freshJournal(): { j: Journal; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-jrnl-"));
  return { j: new Journal(join(dir, "journal.jsonl"), "run-test"), dir };
}

test("append fills seq/prev/ts and chains from GENESIS", () => {
  const { j } = freshJournal();
  const a = j.append({
    event: "run.start",
    run_id: "run-test",
    data: { state: {} },
  });
  const b = j.append({
    event: "step.enter",
    run_id: "run-test",
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
  const { j } = freshJournal();
  j.append({ event: "run.start", run_id: "run-test" });
  j.append({ event: "step.enter", run_id: "run-test", step: "1", round: 1 });
  j.append({ event: "step.exit", run_id: "run-test", step: "1", round: 1 });

  const { events, truncatedTail } = j.read();
  assert.equal(events.length, 3);
  assert.equal(truncatedTail, false);
  assert.deepEqual(
    events.map((e) => e.seq),
    [0, 1, 2],
  );
});

test("crash-mid-append: a torn FINAL line is dropped, head degrades to the previous entry", () => {
  const { j } = freshJournal();
  j.append({ event: "run.start", run_id: "run-test" });
  const good = j.append({
    event: "step.enter",
    run_id: "run-test",
    step: "1",
    round: 1,
  });
  // simulate a half-written final line (power loss mid-fsync): append a partial JSON fragment
  appendFileSync(
    j.path,
    '{"seq":2,"ts":"2026-07-13T00:00:00.000Z","run_id":"run-test","eve',
  );

  const { events, truncatedTail } = j.read();
  assert.equal(truncatedTail, true);
  assert.equal(events.length, 2);
  assert.equal(j.head()!.seq, good.seq);

  // and we can append again cleanly after recovery
  const next = j.append({
    event: "step.exit",
    run_id: "run-test",
    step: "1",
    round: 1,
  });
  // NB: seq continues from the intact head (2), overwriting the torn fragment's intended slot
  assert.equal(next.seq, 2);
});

test("mid-chain corruption (tampered line) throws, not silently recovered", () => {
  const { j } = freshJournal();
  j.append({ event: "run.start", run_id: "run-test" });
  j.append({ event: "step.enter", run_id: "run-test", step: "1", round: 1 });
  j.append({ event: "step.exit", run_id: "run-test", step: "1", round: 1 });

  // tamper with the MIDDLE line: rewrite its data so its bytes no longer match line-2's prev hash
  const lines = readFileSync(j.path, "utf8").split("\n").filter(Boolean);
  const mid = JSON.parse(lines[1]);
  mid.data = { tampered: true };
  lines[1] = serializeEvent(mid);
  writeFileSync(j.path, lines.join("\n") + "\n");

  assert.throws(() => j.read(), JournalCorruptionError);
});

test("property: N appends verify, and truncating the last line recovers to N-1", () => {
  for (const N of [1, 2, 5, 13, 40]) {
    const { j } = freshJournal();
    j.append({ event: "run.start", run_id: "run-test", data: { state: {} } });
    for (let i = 1; i < N; i++) {
      j.append({
        event: "budget.tick",
        run_id: "run-test",
        cost_cum: { usd_est: i * 0.01 },
      });
    }
    const before = j.read();
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
      const after = j.read();
      assert.equal(after.truncatedTail, true);
      assert.equal(after.events.length, N - 1);
    }
  }
});
