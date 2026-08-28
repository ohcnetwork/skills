// The async transport, end to end against a real provider: session.create → driveToCompletion
// (promptAsync + the /event SSE stream watched for session.idle) → structured extraction → model pin.
//
// This is the check that the blocking-POST migration still holds. The old shape held one long
// request open and undici's 300s headersTimeout guillotined it; the current shape returns from the
// prompt immediately and watches a separate long-lived event stream instead. An SDK bump that
// regresses either half shows up here and nowhere in the hermetic suite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promptStructured } from "../../src/opencode-runner.ts";
import { MODEL, PROVIDER, SKIP } from "./_live.ts";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "count"],
  properties: { answer: { type: "string" }, count: { type: "integer" } },
};

test("promptStructured returns structured output through the async transport", { skip: SKIP }, async () => {
  const started = Date.now();
  const r = await promptStructured(
    {
      role: "care-planner",
      providerID: PROVIDER,
      modelID: MODEL,
      system: "You answer with structured JSON only.",
      task: "Reply: answer='wired', count=7. Do no work, just return the object.",
      round: 1,
      timeoutMs: 120_000,
    },
    SCHEMA,
  );
  const elapsedMs = Date.now() - started;

  assert.equal(r.data?.answer, "wired", "structured field did not survive the async path");
  assert.equal(r.data?.count, 7);
  assert.equal(r.modelPinSatisfied, true, `asked for ${MODEL}, got ${r.modelReported}`);
  assert.ok(r.cost, "no usage reported — cost accounting is wired through the same path");
  // Well under undici's 300s headersTimeout. A trivial prompt approaching it means the transport has
  // regressed to a blocking call, which is the exact failure this file exists to catch.
  assert.ok(elapsedMs < 120_000, `took ${elapsedMs}ms`);
});
