// One live spawn through the rewritten promptStructured (async transport). Confirms the real wiring:
// session.create → driveToCompletion (promptAsync + /event) → structured extraction → model pin.
// Run: npx tsx src/probe-structured-live.ts
import { promptStructured } from "./opencode-runner.js";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "count"],
  properties: { answer: { type: "string" }, count: { type: "integer" } },
};

const t0 = Date.now();
const r = await promptStructured(
  {
    role: "care-planner",
    providerID: process.env.PROBE_PROVIDER ?? "github-copilot",
    modelID: process.env.PROBE_MODEL ?? "claude-sonnet-4.6",
    system: "You answer with structured JSON only.",
    task: "Reply: answer='wired', count=7. Do no work, just return the object.",
    round: 1,
    timeoutMs: 120_000,
  },
  SCHEMA,
);
console.log(`took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("data:", JSON.stringify(r.data));
console.log("modelReported:", r.modelReported, "pinSatisfied:", r.modelPinSatisfied);
console.log("cost:", JSON.stringify(r.cost));
process.exit(0);
