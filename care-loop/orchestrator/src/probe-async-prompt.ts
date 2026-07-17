// probe-async-prompt.ts — verify the promptAsync + /event(SSE) + session.message pattern as a
// replacement for the blocking session.prompt (which undici's 300s headersTimeout guillotines).
// Goal: (1) promptAsync returns immediately, (2) session.idle signals completion, (3) the finished
// assistant message carries structured output. Prints every event type so we learn the real signals.
//
// Run: npx tsx src/probe-async-prompt.ts
import { createOpencode } from "@opencode-ai/sdk";

const PROVIDER = process.env.PROBE_PROVIDER ?? "github-copilot";
const MODEL = process.env.PROBE_MODEL ?? "claude-sonnet-4.6";
const OVERALL_DEADLINE_MS = Number(process.env.PROBE_DEADLINE_MS) || 480_000;

const JUDGMENT_PERMISSION = {
  edit: "deny",
  bash: "deny",
  webfetch: "deny",
  external_directory: "allow",
} as const;

// A trivial schema so we can prove structured output survives the async path.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "count"],
  properties: {
    answer: { type: "string" },
    count: { type: "integer" },
  },
};

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a: unknown[]) => console.log(`[${el()}]`, ...a);

async function main() {
  log(`starting embedded opencode server (provider=${PROVIDER} model=${MODEL})`);
  const oc = await createOpencode({
    config: { permission: JUDGMENT_PERMISSION, tools: { task: false } } as any,
  });
  log("server up:", (oc as any).server?.url ?? "(url n/a)");

  const client: any = oc.client;
  let idle = false;
  let assistantMsgId: string | undefined;
  const seenEventTypes = new Map<string, number>();

  // Overall abort so a hang can't wedge the probe.
  const ac = new AbortController();
  const killer = setTimeout(() => {
    log(`!! overall deadline ${OVERALL_DEADLINE_MS}ms hit — aborting`);
    ac.abort();
  }, OVERALL_DEADLINE_MS);

  try {
    const session = unwrap(
      await client.session.create({ body: { title: "probe-async" } }),
    );
    const sessionId = session.id ?? session.sessionID;
    log("session created:", sessionId);

    // 1) Subscribe to the event bus BEFORE prompting so we can't miss session.idle.
    const sub = await client.event.subscribe({ signal: ac.signal });
    const pump = (async () => {
      for await (const ev of sub.stream as AsyncIterable<any>) {
        const type = ev?.type ?? "(no-type)";
        seenEventTypes.set(type, (seenEventTypes.get(type) ?? 0) + 1);
        const sid = ev?.properties?.sessionID ?? ev?.properties?.info?.sessionID;
        if (sid && sid !== sessionId) continue; // only our session
        // Capture the assistant message id as it streams.
        const info = ev?.properties?.info;
        if (info?.role === "assistant" && info?.id) assistantMsgId = info.id;
        if (type === "message.updated" || type === "session.idle" || type === "session.error") {
          log(`event ${type}`, sid ? `sid=${sid.slice(-6)}` : "", info?.role ? `role=${info.role}` : "");
        }
        if (type === "session.error") log("  SESSION ERROR:", JSON.stringify(ev.properties).slice(0, 300));
        if (type === "session.idle") { idle = true; break; }
        if (ac.signal.aborted) break;
      }
    })();

    // 2) Fire promptAsync — should return ~instantly (204).
    const pStart = Date.now();
    const res = await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        model: { providerID: PROVIDER, modelID: MODEL },
        system: "You answer with structured JSON only.",
        parts: [{ type: "text", text: "Reply: answer='ok', count=42. Do no work, just return the structured object." }],
        format: { type: "json_schema", schema: SCHEMA },
      } as any,
    });
    const promptReturnedMs = Date.now() - pStart;
    log(`promptAsync returned in ${promptReturnedMs}ms (status/void ok=${res != null || res === undefined})  <-- should be well under the 300s undici cap`);

    // 3) Wait for the pump to hit session.idle (or deadline).
    await pump;
    clearTimeout(killer);

    if (!idle) {
      log("!! never saw session.idle (aborted or errored)");
    } else {
      log("session.idle received — run complete");
    }

    // 4) Fetch the finished assistant message and inspect for structured output.
    log("assistant messageID from events:", assistantMsgId ?? "(none captured)");
    if (assistantMsgId) {
      const msg = unwrap(
        await client.session.message({ path: { id: sessionId, messageID: assistantMsgId } }),
      );
      const info = msg?.info ?? msg;
      const structured = info?.structured ?? info?.structured_output;
      log("message.error:", info?.error?.name ?? "(none)");
      log("message.structured:", structured ? JSON.stringify(structured) : "(MISSING)");
      log("message tokens/cost:", JSON.stringify(info?.tokens ?? {}), "cost=", info?.cost);
    }

    log("--- all event types seen ---");
    for (const [k, v] of [...seenEventTypes.entries()].sort()) log(`  ${k}: ${v}`);
  } finally {
    clearTimeout(killer);
    ac.abort();
    try { await (oc as any).server?.close?.(); } catch { /* best-effort */ }
    log("server closed");
  }
}

function unwrap<T = any>(r: any): T {
  // hey-api returns { data, error, response } unless responseStyle:'data'
  if (r && typeof r === "object" && ("data" in r || "error" in r)) {
    if (r.error) throw new Error(`opencode error: ${JSON.stringify(r.error).slice(0, 300)}`);
    return r.data as T;
  }
  return r as T;
}

main().catch((e) => {
  console.error(`[${el()}] PROBE FAILED:`, e?.message ?? e);
  process.exit(1);
});
