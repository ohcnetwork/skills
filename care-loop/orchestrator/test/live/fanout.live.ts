// forkedFanOut against a real provider: base warm-up, prime, parallel forks, reduce — all through
// driveToCompletion. Tiny synthetic tasks, so this confirms plumbing and cache inheritance rather
// than triage quality.
//
// The cache assertion is the point: forks are session.fork'd off a primed base, and a fork that
// reads zero cached tokens means the inheritance broke and every fan-out is paying full freight.

import { test } from "node:test";
import assert from "node:assert/strict";
import { forkedFanOut } from "../../src/opencode-runner.ts";
import { MODEL, PROVIDER, SKIP } from "./_live.ts";

const MAP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "ok"],
  properties: { id: { type: "string" }, ok: { type: "boolean" } },
};
const REDUCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["count"],
  properties: { count: { type: "integer" } },
};

const TASK_IDS = ["t1", "t2", "t3", "t4"];

test("forkedFanOut maps in parallel, reduces, and inherits the base cache", { skip: SKIP }, async () => {
  const r = await forkedFanOut({
    provider: PROVIDER,
    base: {
      system: "You verify short claims. Answer only with the requested structured object.",
      // Long enough to be worth caching — that is what the fork is meant to inherit.
      context: "Shared reference: the sky is blue, water is wet, fire is hot. ".repeat(40),
    },
    map: {
      model: MODEL,
      schema: MAP_SCHEMA,
      tasks: TASK_IDS.map((id) => ({ id, prompt: `Set id='${id}', ok=true.` })),
    },
    reduce: {
      model: MODEL,
      schema: REDUCE_SCHEMA,
      prompt: (results) =>
        `You received ${results.length} map results. Return count=${results.length}.`,
    },
  });

  const failed = r.map.filter((m) => m.error);
  assert.equal(failed.length, 0, `forks errored: ${failed.map((m) => `${m.id}:${m.error}`).join(", ")}`);
  assert.deepEqual(r.map.map((m) => m.id).sort(), [...TASK_IDS].sort());
  for (const m of r.map) assert.equal(m.data?.ok, true, `${m.id} did not return ok`);

  assert.ok(r.reduce, "reduce degraded — the fan-in leg did not complete");
  assert.equal(r.reduce.data?.count, TASK_IDS.length);

  const cacheHits = r.map.filter((m) => (m.cache.read ?? 0) > 0).length;
  assert.ok(cacheHits > 0, "no fork read cached tokens — base cache inheritance is broken");
});
