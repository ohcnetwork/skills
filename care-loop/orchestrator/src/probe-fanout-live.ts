// Minimal live forkedFanOut through the async transport: base warm-up + prime + parallel forks +
// reduce, all via driveToCompletion. Tiny synthetic tasks (cheap) — confirms plumbing + cache, not
// triage quality. Run: npx tsx src/probe-fanout-live.ts
import { forkedFanOut } from "./opencode-runner.js";

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

const t0 = Date.now();
const r = await forkedFanOut({
  provider: process.env.PROBE_PROVIDER ?? "github-copilot",
  base: {
    system: "You verify short claims. Answer only with the requested structured object.",
    context: "Shared reference: the sky is blue, water is wet, fire is hot. ".repeat(40),
  },
  map: {
    model: process.env.PROBE_MODEL ?? "claude-sonnet-4.6",
    schema: MAP_SCHEMA,
    tasks: [
      { id: "t1", prompt: "Set id='t1', ok=true." },
      { id: "t2", prompt: "Set id='t2', ok=true." },
      { id: "t3", prompt: "Set id='t3', ok=true." },
      { id: "t4", prompt: "Set id='t4', ok=true." },
    ],
  },
  reduce: {
    model: process.env.PROBE_MODEL ?? "claude-sonnet-4.6",
    schema: REDUCE_SCHEMA,
    prompt: (results) => `You received ${results.length} map results. Return count=${results.length}.`,
  },
});
console.log(`\ntotal ${(( Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("baseCache:", JSON.stringify(r.baseCache), `baseMs=${r.baseMs}`);
console.log(
  "map:",
  r.map.map((m) => `${m.id}=${m.error ? `ERR(${m.error})` : JSON.stringify(m.data)} cacheRead=${m.cache.read ?? 0}`).join("  "),
);
console.log("reduce:", r.reduce ? JSON.stringify(r.reduce.data) : "DEGRADED");
const misses = r.map.filter((m) => !m.error && !(m.cache.read! > 0)).length;
console.log(`cache misses among successful forks: ${misses}/${r.map.filter((m) => !m.error).length}`);
process.exit(0);
