// probe-format.ts — grounded, one-shot probe of what the CURRENT opencode server accepts as a
// structured-output `format.schema`. The live run rejected our JobResult schema with a server-side
// "schema rejection" (kind=Body). This tests graded schemas back-to-back so we know EXACTLY which
// JSON-Schema keyword the server/provider rejects, instead of guessing.
//
// Run:  npm run probe:format

import { createOpencode } from "@opencode-ai/sdk";
import { JOBRESULT_SCHEMA } from "./jobresult.js";

function unwrap<T>(x: any): T {
  return (x && typeof x === "object" && "data" in x ? x.data : x) as T;
}

async function tryOne(label: string, schema: Record<string, unknown>, opts?: { system?: string; task?: string; tools?: Record<string, boolean> }): Promise<void> {
  const oc = await createOpencode({ config: { permission: { external_directory: "allow", edit: "deny", bash: "deny" } } as any });
  try {
    const session = unwrap<any>(await oc.client.session.create({ body: { title: label } }));
    const sid = session.id ?? session.sessionID;
    const promptP = oc.client.session.prompt({
      path: { id: sid },
      body: {
        model: { providerID: "github-copilot", modelID: "claude-opus-4.8" },
        system: opts?.system,
        tools: opts?.tools,
        parts: [{ type: "text", text: opts?.task ?? "Return the object: company is Anthropic, founded is 2021, verdict is pass." }],
        format: { type: "json_schema", schema },
      } as any,
    });
    const res = unwrap<any>(
      await Promise.race([promptP, new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout 90s")), 90_000))]),
    );
    const info = res?.info ?? res;
    const structured = info?.structured ?? info?.structured_output;
    const err = info?.error?.name;
    console.log(`  ${label}: ${structured ? "✔ STRUCTURED " + JSON.stringify(structured).slice(0, 80) : err ? "✖ error=" + err : "✖ no structured output (agentic fallback)"}`);
  } catch (e) {
    console.log(`  ${label}: ✖ threw ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await oc.server?.close?.();
  }
}

async function main() {
  console.log("▶ probe: which format.schema does the current opencode server accept?");
  // 1) docs-style minimal
  await tryOne("minimal(type/props/required)", {
    type: "object",
    properties: { company: { type: "string" }, founded: { type: "number" } },
    required: ["company", "founded"],
  });
  // 2) + enum + description (common, provider-supported)
  await tryOne("+enum+description", {
    type: "object",
    properties: { company: { type: "string", description: "name" }, verdict: { type: "string", enum: ["pass", "findings"] } },
    required: ["company", "verdict"],
  });
  // 3) + additionalProperties:false (OpenAI strict mode wants this)
  await tryOne("+additionalProperties:false", {
    type: "object",
    additionalProperties: false,
    properties: { company: { type: "string" } },
    required: ["company"],
  });
  // 4) + const
  await tryOne("+const", {
    type: "object",
    properties: { schema: { type: "string", const: "care-loop/jobresult@1" }, company: { type: "string" } },
    required: ["schema", "company"],
  });
  // 5) + $schema + minLength + minimum (draft-07 meta keywords)
  await tryOne("+$schema+minLength+minimum", {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { company: { type: "string", minLength: 1 }, round: { type: "integer", minimum: 1 } },
    required: ["company"],
  });
  // 6) the REAL JobResult schema (reproduces the live rejection?)
  await tryOne("REAL JOBRESULT_SCHEMA", JOBRESULT_SCHEMA as any);
  // 7) the LIVE condition: reviewer system + a task that INVITES reading a real file, tools ON
  //    (default). Expect the agentic loop / no single-shot structured output (the live failure).
  const reviewerSystem =
    "You are the care-loop reviewer. Review the supplied diff. You may read files for context. " +
    "Respond ONLY as the required JobResult.";
  const readTask = "Read /Users/jacob/Desktop/care_fe/package.json for context, then review this trivial diff:\n+// TODO\nSet verdict=pass.";
  await tryOne("live-cond: tools ON (read-inviting)", JOBRESULT_SCHEMA as any, { system: reviewerSystem, task: readTask });
  // 8) SAME, but exploration tools DISABLED → expect fast single-shot structured output (the FIX).
  const noTools = { write: false, edit: false, bash: false, read: false, glob: false, grep: false, webfetch: false, list: false, patch: false, task: false, todowrite: false, todoread: false };
  await tryOne("FIX: tools OFF (read-inviting)", JOBRESULT_SCHEMA as any, { system: reviewerSystem, task: readTask, tools: noTools });
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
