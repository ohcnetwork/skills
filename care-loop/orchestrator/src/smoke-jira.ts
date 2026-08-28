// smoke-jira.ts — a LIVE, read-only smoke check for the Jira adapter (PLAN-jira-ticket-fetch.md §6.5).
// The unit tests use fake fetchers + synthetic ADF; this is the first thing that hits a REAL Jira with
// a REAL token, so we can (a) confirm classic Basic auth works end-to-end and (b) SEE where acceptance
// criteria actually live before trusting the description-only extraction (the open §5 question).
//
// Setup: put JIRA_BASE_URL / JIRA_EMAIL / JIRA_TOKEN in care-loop/orchestrator/.env (gitignored, same
// place as the GitHub token). Create a CLASSIC (unscoped) token with an expiry at
// id.atlassian.com/manage/api-tokens.
//
// Run:  npm run smoke:jira -- ENG-648
//
// Writes nothing except the downloaded attachments into a temp run dir (printed). Never mutates Jira.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "./github.js"; // side-effect: loads .env via dotenv (github.ts owns the loadDotenv calls)
import {
  jiraConfigFromEnv,
  jiraTicketFetcher,
  flattenAdf,
} from "./ticket-fetch.js";

async function main() {
  const ticket = process.argv[2];
  if (!ticket) {
    console.error("usage: npm run smoke:jira -- <TICKET-KEY>   (e.g. ENG-648)");
    process.exit(2);
  }
  const cfg = jiraConfigFromEnv();
  if (!cfg) {
    console.error(
      "✖ JIRA_BASE_URL / JIRA_EMAIL / JIRA_TOKEN not all set in .env — nothing to test.",
    );
    process.exit(2);
  }
  console.log(`▶ smoke: GET ${cfg.baseUrl} issue ${ticket} as ${cfg.email}\n`);

  // 1) RAW fetch with ALL fields — so we can eyeball where AC lives (description body vs a customfield).
  const auth =
    "Basic " + Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");
  const headers = { Authorization: auth, Accept: "application/json" };
  const rawRes = await fetch(
    `${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(ticket)}?fields=*all`,
    { headers },
  );
  if (!rawRes.ok) {
    console.error(
      `✖ auth/fetch FAILED: ${rawRes.status} ${rawRes.statusText} — check the token/email/baseUrl.`,
    );
    process.exit(1);
  }
  const raw = (await rawRes.json()) as { fields?: Record<string, unknown> };
  const fields = raw.fields ?? {};
  console.log("✔ auth OK. Top-level field keys present:");
  console.log(
    "  " +
      Object.keys(fields)
        .filter((k) => fields[k] != null)
        .join(", "),
  );
  // Surface any field whose key OR value smells like acceptance criteria — this answers §5.
  const acHits = Object.entries(fields).filter(([k, v]) => {
    const hay = `${k} ${typeof v === "string" ? v : flattenAdf(v)}`.toLowerCase();
    return /accept|criteria|\bAC\b/i.test(hay);
  });
  console.log(
    acHits.length
      ? `\n★ possible acceptance-criteria fields: ${acHits.map(([k]) => k).join(", ")}`
      : "\n(no field obviously named/containing 'acceptance criteria' — likely lives in the description body)",
  );
  console.log(
    `\n— description (flattened) —\n${flattenAdf(fields.description).slice(0, 800)}\n`,
  );

  // RAW description ADF — so we can see how inline images (media nodes) are represented and whether
  // they map to the attachment list (by alt/filename/id). Needed to build inline [image: name] markers
  // that keep each image associated with the paragraph it sits under (PLAN §3.2 image↔text linkage).
  console.log("— raw description ADF (media nodes reveal inline image order) —");
  console.log(JSON.stringify(fields.description, null, 2).slice(0, 2500));
  console.log("\n— attachment[] correlation keys (id / filename / mimeType) —");
  for (const a of (fields.attachment as any[]) ?? [])
    console.log(`  id=${a.id}  filename=${a.filename}  mime=${a.mimeType}`);
  console.log("");

  // 2) Run the ACTUAL adapter — exactly what a run would get.
  const runDir = mkdtempSync(join(tmpdir(), "smoke-jira-"));
  const ctx = await jiraTicketFetcher(cfg)({ ticket, runDir });
  console.log("— assembled TicketContext (what the planner receives) —");
  console.log(`enrichedText (${ctx.enrichedText.length} chars):`);
  console.log(ctx.enrichedText.slice(0, 600));
  console.log(`\nattachments (${ctx.attachments.length}):`);
  for (const a of ctx.attachments)
    console.log(`  ${a.mime}  ${a.filename}  → ${a.path}`);
  console.log(`\n(downloads under ${runDir})`);
  console.log("\ndone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
