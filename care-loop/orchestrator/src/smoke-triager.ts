// smoke-triager.ts — prove the care-triager judgment spawn works STANDALONE. The triager shares the
// reviewer's transport (promptStructured → promptStructuredOnce), so it inherits the same
// external_directory + timeout fix; this exercises it end-to-end against real bot-feedback text and
// confirms it returns valid tallies without hanging. (Unit tests use fakes and can't catch a transport
// hang — the whole reason the reviewer bug slipped through.)
//
// Run:  npm run smoke:triager       |      RUNS=3 npm run smoke:triager

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeTriager } from "./skills-opencode.js";

const RUNS = Number(process.env.RUNS) || 1;

const SAMPLE_FEEDBACK = `## Bot feedback (PR #123)

### coderabbitai[bot]
- \`src/pages/Facility/SupplyDeliveryTable.tsx:88\` — The expiry date is rendered without a null check; \`item.expiry\` can be undefined for older deliveries and will print "Invalid Date".
- \`src/pages/Facility/SupplyDeliveryTable.tsx:92\` — Consider using the shared \`formatDate\` util instead of \`new Date().toLocaleString()\` for consistency.

### greptile
- Nit: the new column header "Expiry" should be "Expiry Date" to match the design spec.

### github-actions[bot]
- CI: 1 failing test in \`SupplyDeliveryTable.test.tsx\` — snapshot out of date.
`;

async function one(i: number, feedbackPath: string): Promise<boolean> {
  const t0 = Date.now();
  try {
    const res = await opencodeTriager()({ pr: 123, round: 1, runDir: "/tmp", feedbackPath });
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    const p = res.payload;
    console.log(`  [${i}] ✔ ${s}s — verdict=${res.verdict} address=${p.addressCount} decline=${p.declineCount} model=${res.modelUsed}`);
    return true;
  } catch (e) {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  [${i}] ❌ ${s}s — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-smoke-tri-"));
  const feedbackPath = join(dir, "feedback.md");
  writeFileSync(feedbackPath, SAMPLE_FEEDBACK);
  console.log(`▶ smoke: care-triager on sample bot feedback, ${RUNS} run(s), timeout=${(Number(process.env.OC_JUDGMENT_TIMEOUT_MS) || 240000) / 1000}s`);
  let pass = 0;
  for (let i = 1; i <= RUNS; i++) if (await one(i, feedbackPath)) pass++;
  console.log(`\n${pass === RUNS ? "✅" : "❌"} ${pass}/${RUNS} returned valid tallies without hanging.`);
  process.exit(pass === RUNS ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n❌ smoke FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
