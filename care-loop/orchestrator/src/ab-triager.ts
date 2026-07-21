// ab-triager.ts — fan-out timing harness for the triager.
//
// Runs opencodeTriager with worktree (triggers fan-out for ≥2 clusters) and reports
// per-step timing + verdict breakdown. Used to measure optimization impact.
//
// Run:  npx tsx src/ab-triager.ts
//
// Env:  FEEDBACK_PATH  — path to a real feedback.md (default: eng-642 run)
//       WORKTREE       — path to the repo worktree (default: ~/Desktop/care_fe)
//       BASE           — base branch for diff (default: develop)

import { opencodeTriager } from "./skills-opencode.js";

const FEEDBACK_PATH =
  process.env.FEEDBACK_PATH ||
  "/Users/jacob/Desktop/skills/care-loop/runs/care_fe-eng-642-questionnaire-value-cleanup/feedback.md";
const WORKTREE = process.env.WORKTREE || "/Users/jacob/Desktop/care_fe-eng-642-questionnaire-value-cleanup";
const BASE = process.env.BASE || "develop";

async function main() {
  console.log("═══ Triager fan-out timing ═══");
  console.log(`Feedback: ${FEEDBACK_PATH}`);
  console.log(`Worktree: ${WORKTREE}`);
  console.log(`Base: ${BASE}\n`);

  const triager = opencodeTriager({}, WORKTREE, BASE);
  const t0 = Date.now();
  const res = await triager({ pr: 0, round: 1, runDir: "/tmp", feedbackPath: FEEDBACK_PATH });
  const wallMs = Date.now() - t0;
  const p = res.payload;

  console.log(`\n═══ Results ═══`);
  console.log(`Wall: ${(wallMs / 1000).toFixed(1)}s`);
  const items = p.items ?? [];
  console.log(`Verdict: ${res.verdict}  (A=${p.addressCount} D=${p.declineCount}, ${items.length} items)`);
  console.log(`\n── items ──`);
  for (const it of items) console.log(`  ${it.verdict.padEnd(8)} ${(it.class ?? "").padEnd(16)} ${(it.reason ?? "").slice(0, 120)}`);
}

main().catch((err) => {
  console.error(`\n❌ FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
