// smoke-reviewer.ts — prove the care-reviewer judgment spawn works STANDALONE against a diff that
// references a REAL, on-disk care_fe file — the exact condition that hung the live ENG-613 run (opus
// tried to open the changed source, hit opencode's headless `external_directory=ask`, and waited
// forever). Unlike spike-reviewer (cr-01 fixture = a non-existent file, so no read is ever attempted),
// this exercises the file-read path, so a PASS proves the permission + timeout fix.
//
// Run:  cd care-loop/orchestrator && npm run smoke:reviewer            (single run)
//       RUNS=3 npm run smoke:reviewer                                  (reliability: N back-to-back)
// Needs: opencode authed to GitHub Copilot; a care_fe checkout at ~/Desktop/care_fe (override CARE_FE).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { opencodeReviewer } from "./skills-opencode.js";
import { runJudgmentSpawn } from "./opencode-runner.js";

const REPO = process.env.CARE_FE ?? join(process.env.HOME ?? "", "Desktop/care_fe");
const FILE = process.env.SMOKE_FILE ?? "src/pages/Facility/services/inventory/SupplyDeliveryTable.tsx";
const RUNS = Number(process.env.RUNS) || 1;
const PROVIDER = process.env.OC_PROVIDER ?? "github-copilot";
const MODEL = process.env.OC_MODEL ?? "claude-opus-4.8";

/** A small, realistic unified diff that references a REAL file (so the model may open it for context). */
function realFileDiff(): string {
  const head = readFileSync(join(REPO, FILE), "utf8").split("\n").slice(0, 5);
  return [
    `diff --git a/${FILE} b/${FILE}`,
    `--- a/${FILE}`,
    `+++ b/${FILE}`,
    `@@ -1,5 +1,6 @@`,
    ...head.map((l) => ` ${l}`),
    `+// TODO(eng-613): render the supply-delivery expiry date column here`,
    ``,
  ].join("\n");
}

// FORCE_READ: deterministically make the model open the real file BEFORE reviewing — this is what
// triggers opencode's external_directory permission gate. With the fix (external_directory:"allow")
// it proceeds silently; WITHOUT the fix it hangs on `action=ask`. This is the true regression check.
const FORCE_READ_SYSTEM =
  "You are the care-loop reviewer (judgment tier). You have a file-read tool. BEFORE reviewing, you " +
  "MUST read the full file at the absolute path given below to ground your review in the surrounding " +
  "code. Then review the supplied diff for correctness/overengineering/legibility. Set verdict=pass " +
  "if clean, else findings. Fill model_used. Respond ONLY as the required JobResult.";

async function one(i: number): Promise<{ ok: boolean }> {
  const t0 = Date.now();
  const forceRead = process.env.FORCE_READ === "1";
  try {
    if (forceRead) {
      const abs = resolve(REPO, FILE);
      const out = await runJudgmentSpawn({
        role: "care-reviewer",
        providerID: PROVIDER,
        modelID: MODEL,
        system: FORCE_READ_SYSTEM,
        task: `Read this file in full first: ${abs}\n\nThen review this diff:\n=== DIFF ===\n${realFileDiff()}\n=== END DIFF ===`,
        runId: "smoke",
        round: 1,
      });
      const s = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${i}] ✔ ${s}s (force-read) — verdict=${out.jobResult.verdict} findings=${out.jobResult.findings.length} model=${out.jobResult.model_used}`);
      return { ok: true };
    }
    const res = await opencodeReviewer()({ diff: realFileDiff(), runDir: "/tmp", round: 1 });
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [${i}] ✔ ${s}s — verdict=${res.verdict} reason=${res.reasonCode} findings=${res.payload.findings.length} model=${res.modelUsed}`);
    for (const f of res.payload.findings) console.log(`        • [${f.class}] ${f.file} ${f.lineHint ?? ""} — ${f.note}`);
    return { ok: true };
  } catch (e) {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [${i}] ❌ ${s}s — ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false };
  }
}

async function main() {
  const mode = process.env.FORCE_READ === "1" ? "FORCE-READ (exercises external_directory)" : "diff-only";
  console.log(`▶ smoke: care-reviewer on a REAL file (${FILE}), ${RUNS} run(s), mode=${mode}, timeout=${(Number(process.env.OC_JUDGMENT_TIMEOUT_MS) || 240000) / 1000}s`);
  let pass = 0;
  for (let i = 1; i <= RUNS; i++) {
    const r = await one(i);
    if (r.ok) pass++;
  }
  console.log(`\n${pass === RUNS ? "✅" : "❌"} ${pass}/${RUNS} returned a valid result without hanging.`);
  process.exit(pass === RUNS ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n❌ smoke FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
