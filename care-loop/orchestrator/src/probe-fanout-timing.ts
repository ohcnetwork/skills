// probe-fanout-timing.ts — instrument each step of the REAL forkedFanOut to find the bottleneck.
// Uses the actual production forkedFanOut but wraps it with console.time markers.
//
// Run:  npx tsx src/probe-fanout-timing.ts

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { forkedFanOut } from "./opencode-runner.js";
import { parseFeedbackClusters } from "./feedback.js";
import { triagerMethodology } from "./skill-source.js";

const WORKTREE = "/Users/jacob/Desktop/care_fe-eng-642-questionnaire-value-cleanup";
const BASE = "develop";
const PROVIDER = "github-copilot";
const MAP_MODEL = "claude-sonnet-4.6";
const REDUCE_MODEL = "claude-opus-4.8";

let t0 = Date.now();
function log(msg: string) { console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`); }

function computeDiff(): string {
  try {
    const c = execSync(`git diff ${BASE}...HEAD`, { cwd: WORKTREE, maxBuffer: 10_000_000 }).toString();
    const u = execSync(`git diff HEAD`, { cwd: WORKTREE, maxBuffer: 10_000_000 }).toString();
    return c + u;
  } catch { return ""; }
}

const CLUSTER_VERIFY_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["class", "verdict", "missed_by", "reason", "needs_cross_file"],
        properties: {
          source: { type: "string" },
          class: { type: "string" },
          verdict: { enum: ["address", "decline"] },
          missed_by: { type: "string" },
          reason: { type: "string" },
          needs_cross_file: { type: "boolean" },
        },
      },
    },
  },
} as const;

const TRIAGE_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["class", "verdict", "missed_by", "reason"],
        properties: {
          source: { type: "string" },
          class: { type: "string" },
          verdict: { enum: ["address", "decline"] },
          missed_by: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

async function main() {
  t0 = Date.now();

  const feedback = readFileSync(
    "/Users/jacob/Desktop/skills/care-loop/runs/care_fe-eng-642-questionnaire-value-cleanup/feedback.md",
    "utf8",
  );
  const { clusters, summary } = parseFeedbackClusters(feedback);
  log(`${clusters.length} clusters: ${clusters.map((c) => c.file.split("/").pop()).join(", ")}`);

  const diff = computeDiff();
  log(`diff: ${diff.length} chars`);

  const methodology = triagerMethodology();
  log(`methodology: ${methodology?.length ?? 0} chars`);

  const system =
    "You are the care-loop triager verifying ONE file's review findings. The shared context is " +
    "the FULL change diff (for cross-file awareness). For each finding on your file, read the cited " +
    `path in the repo to verify it before verdicting. Repo (read-only, absolute paths; feedback ` +
    `paths are RELATIVE to it): ${WORKTREE}. Set needs_cross_file=true only when a verdict genuinely ` +
    "depends on a file you were not given. Return items[] for THIS file only." +
    (methodology ? `\n\n=== TRIAGE METHODOLOGY ===\n${methodology}\n=== END METHODOLOGY ===` : "");

  log(`system: ${system.length} chars, context (diff): ${diff.length} chars`);
  log("calling forkedFanOut (production code path)...");

  const res = await forkedFanOut({
    provider: PROVIDER,
    base: { system, context: diff },
    map: {
      model: MAP_MODEL,
      schema: CLUSTER_VERIFY_SCHEMA,
      tasks: clusters.map((c) => ({
        id: c.file,
        prompt: `Findings on \`${c.file}\`:\n\n${c.text}\n\nVerify each against the code and return items[].`,
      })),
    },
    reduce: {
      model: REDUCE_MODEL,
      schema: TRIAGE_SCHEMA,
      prompt: (r) =>
        "Consolidate these per-file verified findings into the FINAL triage verdict list. Dedup " +
        "overlapping bot findings; apply the Scope Governor and promote in-scope bug-class siblings; " +
        "for any item flagged needs_cross_file, resolve it now using the full diff; fold in the bot " +
        "summary comments below. Return ONE item per distinct finding with its missed_by attribution.\n\n" +
        "=== PER-FILE VERIFIED FINDINGS ===\n" +
        r.map((x) => `## ${x.id}${x.error ? ` (VERIFY FAILED: ${x.error})` : ""}\n${JSON.stringify(x.data)}`).join("\n\n") +
        (summary ? `\n\n=== BOT SUMMARY COMMENTS ===\n${summary}` : ""),
    },
    concurrency: 5,
    timeoutMs: 720_000,
  });

  log("forkedFanOut returned!");
  log(`baseMs: ${res.baseMs}ms, baseCache: ${JSON.stringify(res.baseCache)}`);
  log(`map results: ${res.map.length}`);
  for (const m of res.map) {
    log(`  ${m.id}: ${m.ms}ms, items=${m.data?.items?.length ?? "ERR:" + m.error}, cache=${JSON.stringify(m.cache)}`);
  }
  if (res.reduce) {
    log(`reduce: items=${res.reduce.data?.items?.length ?? "null"}, cache=${JSON.stringify(res.reduce.cache)}`);
  }
  log("done");
}

main().catch((err) => {
  log(`FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
