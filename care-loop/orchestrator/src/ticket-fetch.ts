// ticket-fetch.ts — the OPTIONAL pre-Step-1 enrichment (PLAN-jira-ticket-fetch.md). Two pieces:
//
//   enrichPlanInput(input, fetcher?)  — the kickoff wrapper. Calls the fetcher ONCE, caches the
//     result under runDir/ticket.json (+ images under runDir/attachments/ written by the fetcher),
//     folds the ticket text into `task` and threads `attachments`. On resume it reads the cache
//     instead of re-fetching. DEGRADES to the raw input on any fetch failure — enrichment is not a
//     dependency; a Jira outage must never block a run that could plan on the human-supplied `task`.
//
//   jiraTicketFetcher(env)  — the real adapter (Jira REST v3): fetch the issue, flatten the ADF
//     description, download image attachments into runDir/attachments/. Auth from env; the caller
//     never sees the token. v1 scope: description + summary as text, IMAGE attachments only, NO
//     comments (dropped — PLAN §3.2).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment, TicketContext, TicketFetcher } from "./ports.js";
import type { PlanInput } from "./plan-front.js";

const CACHE_FILE = "ticket.json";

/** Merge the fetched ticket text with any operator-supplied kickoff `task` (both preserved — the
 *  operator note often adds intent the ticket lacks). Ticket text leads; operator note follows. */
function mergeTask(operatorTask: string, enrichedText: string): string {
  const parts = [enrichedText.trim(), operatorTask.trim()].filter(Boolean);
  return parts.join("\n\n--- operator note ---\n\n") || operatorTask;
}

/**
 * Enrich a PlanInput with ticket context, if a fetcher is configured. Idempotent + resume-safe:
 * a cached runDir/ticket.json short-circuits the fetch. Degrades to the raw input on failure (unless
 * there is no brief at all — empty operator task AND failed fetch — which throws, since planning on
 * nothing is worse than aborting).
 */
export async function enrichPlanInput(
  input: PlanInput,
  fetcher?: TicketFetcher,
): Promise<PlanInput> {
  if (!fetcher) return input; // default deployment: no network, raw task (today's behavior)

  const cachePath = join(input.runDir, CACHE_FILE);
  let ctx: TicketContext | undefined;

  // Resume: a prior run already fetched + cached. Read it, don't re-hit Jira (external state may have
  // changed and re-downloading is wasteful — the loop plans against the ticket as first seen).
  if (existsSync(cachePath)) {
    try {
      ctx = JSON.parse(readFileSync(cachePath, "utf8")) as TicketContext;
    } catch (e) {
      console.warn(
        `[ticket-fetch] cache ${cachePath} unreadable (${(e as Error).message}) — re-fetching.`,
      );
    }
  }

  if (!ctx) {
    try {
      mkdirSync(input.runDir, { recursive: true });
      ctx = await fetcher({ ticket: input.ticket, runDir: input.runDir });
      writeFileSync(cachePath, JSON.stringify(ctx, null, 2));
    } catch (e) {
      const msg = (e as Error).message;
      // Degrade-and-flag: proceed on the raw task. Exception: no task AND no ticket text = no brief.
      if (!input.task.trim()) {
        throw new Error(
          `[ticket-fetch] ticket ${input.ticket} fetch failed (${msg}) and no kickoff task was supplied — nothing to plan against.`,
        );
      }
      console.warn(
        `[ticket-fetch] ticket ${input.ticket} fetch failed (${msg}) — proceeding on the raw kickoff task, no attachments.`,
      );
      return input;
    }
  }

  return {
    ...input,
    task: mergeTask(input.task, ctx.enrichedText),
    attachments: ctx.attachments,
  };
}

/** Config for the Jira adapter. All from env at the wiring site; never logged. */
export interface JiraConfig {
  baseUrl: string; // e.g. "https://your-org.atlassian.net"
  email: string; // Atlassian account email
  token: string; // API token
}

/** Read Jira config from the standard env vars, or return undefined if not fully configured (⇒ the
 *  caller wires NO fetcher, i.e. today's raw-task behavior). */
export function jiraConfigFromEnv(env = process.env): JiraConfig | undefined {
  const baseUrl = env.JIRA_BASE_URL?.trim();
  const email = env.JIRA_EMAIL?.trim();
  const token = env.JIRA_TOKEN?.trim();
  if (!baseUrl || !email || !token) return undefined;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), email, token };
}

// Block-level ADF nodes get a trailing newline so paragraphs/list items/images don't run together.
const ADF_BLOCKS = new Set([
  "paragraph",
  "heading",
  "listItem",
  "bulletList",
  "orderedList",
  "codeBlock",
  "blockquote",
  "mediaSingle",
  "mediaGroup",
]);

/** Flatten an Atlassian Document Format (ADF) node to plain text, PRESERVING inline image position.
 *  A `media` node becomes an inline `[image: <filename>]` marker at the exact spot it sits in the
 *  document, so the planner keeps each image welded to the paragraph it illustrates instead of getting
 *  a flat, unordered attachment dump (the CARE-298 "one desc ↔ one image" case). The marker filename
 *  is `media.attrs.alt`, which equals `attachment[].filename` — the join the fetcher uses to order the
 *  downloaded images to match. `inlineCard`/`blockCard` (e.g. a Figma design link) surface as a
 *  `[link: <url>]` marker since "from the design" points at them. Accepts a plain string too. */
export function flattenAdf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenAdf).join("");
  const n = node as {
    type?: string;
    text?: string;
    content?: unknown;
    attrs?: { alt?: string; id?: string; url?: string };
  };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (n.type === "hardBreak") return "\n";
  if (n.type === "media") {
    const name = n.attrs?.alt ?? n.attrs?.id ?? "attachment";
    return `[image: ${name}]`;
  }
  if (n.type === "inlineCard" || n.type === "blockCard") {
    return n.attrs?.url ? `[link: ${n.attrs.url}]` : "";
  }
  const inner = flattenAdf(n.content);
  return n.type && ADF_BLOCKS.has(n.type) ? `${inner}\n` : inner;
}

/** Walk an ADF tree and collect media `alt` names (= filenames) in DOCUMENT order — used to order the
 *  downloaded attachments so they arrive in the same sequence as the `[image: …]` markers in the text. */
export function collectMediaAlts(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) collectMediaAlts(c, out);
    return out;
  }
  const n = node as { type?: string; attrs?: { alt?: string }; content?: unknown };
  if (n.type === "media" && typeof n.attrs?.alt === "string")
    out.push(n.attrs.alt);
  if (n.content) collectMediaAlts(n.content, out);
  return out;
}

interface JiraAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  content: string; // authenticated download URL
}

/** The real Jira fetcher. Returns a TicketFetcher closure so the config is captured once at wiring. */
export function jiraTicketFetcher(cfg: JiraConfig): TicketFetcher {
  const auth =
    "Basic " + Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");
  const headers = { Authorization: auth, Accept: "application/json" };

  return async ({ ticket, runDir }): Promise<TicketContext> => {
    // v1: description + summary as the brief; image attachments; NO comments (PLAN §3.2).
    const url = `${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(ticket)}?fields=summary,description,attachment`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Jira GET ${ticket} → ${res.status} ${res.statusText}`);
    }
    const issue = (await res.json()) as {
      fields?: {
        summary?: string;
        description?: unknown;
        attachment?: JiraAttachmentMeta[];
      };
    };
    const f = issue.fields ?? {};
    const summary = f.summary ? `# ${ticket}: ${f.summary}\n\n` : "";
    // NOTE (PLAN §5): acceptance criteria may live in a custom field on the real CARE Jira project —
    // resolve that empirically against a real ticket's raw `fields` payload before adding a
    // dedicated extractor. v1 uses the description body, which is where AC most often lives.
    const description = flattenAdf(f.description).trim();
    const enrichedText = `${summary}${description}`.trim();

    // Download IMAGE attachments into runDir/attachments/, ORDERED to match the inline [image: …]
    // markers in the flattened text (document order), so marker N lines up with image N. Images not
    // embedded inline (attached but unreferenced) sort last.
    const attDir = join(runDir, "attachments");
    const order = collectMediaAlts(f.description);
    const rank = (name: string) => {
      const i = order.indexOf(name);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    const images = (f.attachment ?? [])
      .filter((a) => a.mimeType?.startsWith("image/"))
      .sort((a, b) => rank(a.filename) - rank(b.filename));
    const attachments: Attachment[] = [];
    if (images.length) mkdirSync(attDir, { recursive: true });
    for (const a of images) {
      try {
        const dl = await fetch(a.content, { headers });
        if (!dl.ok) {
          console.warn(
            `[jira] attachment ${a.filename} → ${dl.status}; skipping.`,
          );
          continue;
        }
        const bytes = Buffer.from(await dl.arrayBuffer());
        const path = join(attDir, `${a.id}-${a.filename}`);
        writeFileSync(path, bytes);
        attachments.push({ path, mime: a.mimeType, filename: a.filename });
      } catch (e) {
        console.warn(
          `[jira] attachment ${a.filename} download failed (${(e as Error).message}); skipping.`,
        );
      }
    }

    return { enrichedText, attachments };
  };
}
