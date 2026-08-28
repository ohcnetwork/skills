// defineSkill stamps the SkillResult envelope the eight adapters used to spell out by hand. The
// adapters themselves are untestable without a live provider, so this is where the envelope's
// invariants are actually pinned: schema, round, timing, and the tier assertion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { defineSkill, WrongTierError, type SkillOutcome } from "../src/skills-opencode.ts";

const outcome = (over: Partial<SkillOutcome> = {}): SkillOutcome => ({
  terminalState: "done",
  verdict: "pass",
  reasonCode: "reviewed",
  payload: { findings: [] },
  ...over,
});

test("stamps schema, skill id, and the round off the input", async () => {
  const skill = defineSkill("care-reviewer", async () => outcome());
  const r = await skill({ round: 3 });

  assert.equal(r.schema, "care-loop/skill-result@1");
  assert.equal(r.skill, "care-reviewer");
  assert.equal(r.round, 3);
});

test("passes the body's decisions through untouched", async () => {
  const payload = { findings: [{ class: "correctness", file: "a.ts", note: "x" }] };
  const skill = defineSkill("care-reviewer", async () =>
    outcome({ terminalState: "failed", verdict: "blocked", reasonCode: "boom", payload }),
  );
  const r = await skill({ round: 1 });

  assert.equal(r.terminalState, "failed");
  assert.equal(r.verdict, "blocked");
  assert.equal(r.reasonCode, "boom");
  assert.deepEqual(r.payload, payload);
});

test("startedAt precedes the body and endedAt follows it", async () => {
  const skill = defineSkill("slow", async () => {
    await new Promise((r) => setTimeout(r, 12));
    return outcome();
  });
  const r = await skill({ round: 1 });

  const started = Date.parse(r.startedAt!);
  const ended = Date.parse(r.endedAt!);
  assert.ok(Number.isFinite(started) && Number.isFinite(ended));
  // The window must span the body, which is the bug the hand-written envelopes could have: a
  // startedAt captured after the expensive call would report a duration of roughly zero.
  assert.ok(ended - started >= 10, `window was ${ended - started}ms`);
});

test("cost and modelUsed are carried when the body reports them, absent when it does not", async () => {
  const withCost = defineSkill("care-triager", async () =>
    outcome({ cost: { usdEst: 0.42 }, modelUsed: "claude-opus-4.8" }),
  );
  const r1 = await withCost({ round: 1 });
  assert.deepEqual(r1.cost, { usdEst: 0.42 });
  assert.equal(r1.modelUsed, "claude-opus-4.8");

  const bare = defineSkill("implementer", async () => outcome());
  const r2 = await bare({ round: 1 });
  assert.equal(r2.cost, undefined);
  assert.equal(r2.modelUsed, undefined);
  // Serialising drops the undefined keys, so the sidecar matches what the adapters wrote before.
  assert.equal("cost" in JSON.parse(JSON.stringify(r2)), false);
});

test("an explicit tier mismatch halts the run before an envelope is returned", async () => {
  const skill = defineSkill("care-reviewer", async () =>
    outcome({ pin: { model: "claude-opus-4.8", reported: "claude-sonnet-4.6", satisfied: false } }),
  );
  await assert.rejects(() => skill({ round: 1 }), WrongTierError);
});

test("the assertion uses the skill id, so the error names the role that actually ran", async () => {
  const skill = defineSkill("care-test-grader", async () =>
    outcome({ pin: { model: "opus", reported: "sonnet", satisfied: false } }),
  );
  await assert.rejects(() => skill({ round: 1 }), (e: Error) => {
    assert.match(e.message, /care-test-grader/);
    assert.match(e.message, /opus/);
    return true;
  });
});

test("an unverifiable engine is not a mismatch — local models and fakes report nothing", async () => {
  const skill = defineSkill("care-reviewer", async () =>
    outcome({ pin: { model: "claude-opus-4.8", reported: undefined, satisfied: undefined } }),
  );
  const r = await skill({ round: 1 });
  assert.equal(r.verdict, "pass");
});

test("a body with no pin is never tier-checked — maker-tier roles have no pin to satisfy", async () => {
  const skill = defineSkill("implementer", async () => outcome({ modelUsed: "whatever-model" }));
  const r = await skill({ round: 1 });
  assert.equal(r.modelUsed, "whatever-model");
});

test("a throwing body propagates rather than being wrapped in an envelope", async () => {
  const skill = defineSkill("care-reviewer", async () => {
    throw new Error("transport died");
  });
  await assert.rejects(() => skill({ round: 1 }), /transport died/);
});
