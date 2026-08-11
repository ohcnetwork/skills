// probe-image.ts — grounded, one-shot probe of whether an IMAGE part survives the opencode → provider
// hop and actually reaches the model. This is the feasibility gate for the Jira-attachments experiment
// (screenshots/mockups as planner input): our runner is text-only today (every prompt is
// `parts: [{ type: "text", ... }]`), and whether a `file` part is forwarded depends on the ROUTED
// provider, not the SDK. A silently-dropped image would make the whole feature inert with no signal.
//
// Method: send a fixture PNG that renders a secret code (test/fixtures/probe-image.png →
// "PROBE-7X4Q9") as a FilePartInput data URL, ask the model to transcribe the code, and check the
// reply. If the code comes back, the provider forwarded the pixels to a multimodal model. If not,
// image parts are dropped on that provider and attachments-as-context is a no-op there.
//
// Run:  npm run probe:image                 # default provider (github-copilot / claude-opus-4.8)
//       npm run probe:image -- <provider> <model>   # e.g. an Anthropic-direct provider
//
// Providers/models are positional args so you can probe the paid-credit-sparing provider you route
// big Claude runs through (models.json provider switch) BEFORE committing to the fetch/auth plumbing.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpencode } from "@opencode-ai/sdk";
import { driveToCompletion } from "./opencode-runner.js";

const SECRET = "PROBE-7X4Q9"; // must match the text rendered in test/fixtures/probe-image.png

function unwrap<T>(x: any): T {
  return (x && typeof x === "object" && "data" in x ? x.data : x) as T;
}

/** The fixture as a base64 data URL — this is exactly the `url` shape a real attachment adapter would
 *  produce after downloading a Jira attachment (mime + base64 payload). */
function fixtureDataUrl(): string {
  const png = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/probe-image.png"),
  );
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** Collapse an assistant message's text parts to plain text. `driveToCompletion` returns only the
 *  message `info` (no parts), so we re-fetch the full message by id to read its text parts. */
async function assistantText(client: any, info: any): Promise<string> {
  const sid = info?.sessionID;
  const mid = info?.id;
  if (!sid || !mid) return (info?.text ?? "").toString();
  const msg = unwrap<any>(await client.session.message({ path: { id: sid, messageID: mid } }));
  const parts = msg?.parts ?? [];
  return (Array.isArray(parts) ? parts : [])
    .filter((p: any) => p?.type === "text")
    .map((p: any) => p?.text ?? "")
    .join("");
}

async function probeOne(providerID: string, modelID: string, url: string): Promise<void> {
  const oc = await createOpencode({
    config: { permission: { external_directory: "allow", edit: "deny", bash: "deny" } } as any,
  });
  try {
    const session = unwrap<any>(await oc.client.session.create({ body: { title: `img-probe ${providerID}` } }));
    const sid = session.id ?? session.sessionID;
    const info = await driveToCompletion(
      oc.client,
      sid,
      {
        model: { providerID, modelID },
        system:
          "You can see images. Read the attached image and reply with ONLY the exact secret code " +
          "printed in it, verbatim. If you cannot see any image, reply exactly: NO_IMAGE.",
        parts: [
          { type: "text", text: "What is the secret code printed in this image?" },
          { type: "file", mime: "image/png", filename: "probe-image.png", url },
        ],
      },
      90_000,
    );
    const reply = (await assistantText(oc.client, info)).trim();
    const saw = reply.toUpperCase().includes(SECRET);
    const blind = /NO_IMAGE/i.test(reply);
    const verdict = saw
      ? "✔ IMAGE REACHED MODEL (transcribed the code)"
      : blind
        ? "✖ MODEL SAW NO IMAGE (part dropped by provider)"
        : "✖ no code + no NO_IMAGE — inconclusive (see reply)";
    console.log(`  ${providerID}/${modelID}: ${verdict}`);
    console.log(`      reply: ${reply.slice(0, 160).replace(/\n/g, " ")}`);
  } catch (e) {
    console.log(`  ${providerID}/${modelID}: ✖ threw ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await oc.server?.close?.();
  }
}

async function main() {
  const [argProvider, argModel] = process.argv.slice(2);
  const providerID = argProvider ?? "github-copilot";
  const modelID = argModel ?? "claude-opus-4.8";
  const url = fixtureDataUrl();
  console.log(`▶ probe: does a file/image part reach the model? (secret in fixture = ${SECRET})`);
  console.log(`  data URL size: ${Math.round(url.length / 1024)}KB`);
  await probeOne(providerID, modelID, url);
  console.log("done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
