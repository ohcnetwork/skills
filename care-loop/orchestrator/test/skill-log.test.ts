import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeSkillLogger, withSkillLog } from "../src/skill-log.ts";
import { Journal } from "../src/journal.ts";
import type { SkillResult, ReviewPayload } from "../src/skill-result.ts";

const rd = () => mkdtempSync(join(tmpdir(), "careloopd-log-"));
const sha256 = (s: string) =>
  "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

const reviewOk = (round: number): SkillResult<ReviewPayload> => ({
  schema: "care-loop/skill-result@1",
  skill: "care-reviewer",
  round,
  terminalState: "done",
  verdict: "findings",
  reasonCode: "reviewed",
  payload: {
    findings: [
      { class: "correctness", file: "a.ts", note: "x" },
      { class: "legibility", file: "b.ts", note: "y" },
    ],
  },
  modelUsed: "opus",
});

test("skill.result event's artifact sha256 matches the sidecar bytes", async () => {
  const runDir = rd();
  const logger = makeSkillLogger({ runDir, runId: "r" });
  const reviewer = withSkillLog(
    "care-reviewer",
    async (i: { runDir: string; round: number }) => reviewOk(i.round),
    logger,
  );

  await reviewer({ runDir, round: 1 });

  const { events } = new Journal(join(runDir, "journal.jsonl"), "r").read();
  const result = events.find((e) => e.event === "skill.result")!;
  assert.ok(result, "skill.result was appended");
  const arts = result.data!.artifacts as Array<{
    name: string;
    path: string;
    sha256: string;
  }>;
  // every referenced sidecar exists and its bytes hash to the recorded sha256
  for (const a of arts) {
    const bytes = readFileSync(join(runDir, a.path), "utf8");
    assert.equal(sha256(bytes), a.sha256, `${a.name} sidecar matches its hash`);
  }
  // counts derived from payload
  assert.deepEqual(result.data!.counts, { findings: 2 });
});

test("journal hash-chain stays intact with skill.* interleaved between driver appends", async () => {
  const runDir = rd();
  const runId = "ohcnetwork-care_fe-x";
  const driver = new Journal(join(runDir, "journal.jsonl"), runId);
  const logger = makeSkillLogger({ runDir, runId });
  const reviewer = withSkillLog(
    "care-reviewer",
    async (i: { runDir: string; round: number }) => reviewOk(i.round),
    logger,
  );

  // driver → step.enter, then the (decorated) skill appends skill.invoke/result, then driver → spawn.result
  driver.append({ event: "step.enter", step: "4a", round: 1 });
  await reviewer({ runDir, round: 1 });
  driver.append({
    event: "spawn.result",
    step: "4a",
    data: { verdict: "findings" },
  });

  const { events, truncatedTail } = new Journal(
    join(runDir, "journal.jsonl"),
    runId,
  ).read(); // read() throws on any chain break
  assert.equal(truncatedTail, false);
  assert.deepEqual(
    events.map((e) => e.event),
    ["step.enter", "skill.invoke", "skill.result", "spawn.result"],
  );
});

test("a throwing skill still records skill.result{failed} then rethrows", async () => {
  const runDir = rd();
  const logger = makeSkillLogger({ runDir, runId: "r" });
  const boom = withSkillLog(
    "care-reviewer",
    async (_i: { runDir: string; round: number }) => {
      throw new Error("fetch failed");
    },
    logger,
  );

  await assert.rejects(boom({ runDir, round: 1 }), /fetch failed/);

  const { events } = new Journal(join(runDir, "journal.jsonl"), "r").read();
  const result = events.find((e) => e.event === "skill.result")!;
  assert.equal(result.data!.terminal_state, "failed");
  assert.equal(result.data!.reason_code, "threw");
  assert.match(String(result.data!.error), /fetch failed/);
  assert.ok(
    existsSync(join(runDir, "skills", "care-reviewer-r1.input.json")),
    "input sidecar written before the call",
  );
});
