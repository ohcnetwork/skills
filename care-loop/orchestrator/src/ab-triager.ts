// ab-triager.ts — timing harness for the triager.
//
// Runs opencodeTriager with a worktree (the pre-read path) and reports
// per-step timing + verdict breakdown. Used to measure optimization impact.
//
// Run:  npx tsx src/ab-triager.ts
//
// Env:  FEEDBACK_PATH  — path to a real feedback.md (required)
//       WORKTREE       — path to the repo worktree (required)
//       BASE           — base branch for diff (default: develop)

import { opencodeTriager } from "./skills-opencode.js";

/** These need a real worktree and a real feedback.md to run against. Defaulting to whichever run dir
 *  happened to be open when this was written left both pointing at a branch that has since been
 *  deleted, so the harness failed on a path rather than saying what it wanted. */
function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(
      `${name} is required.\n` +
        `  FEEDBACK_PATH  a feedback.md from a real run (care-loop/runs/<slug>/feedback.md)\n` +
        `  WORKTREE       the matching repo worktree\n` +
        `  BASE           base branch for the diff (default: develop)`,
    );
    process.exit(2);
  }
  return v;
}

const FEEDBACK_PATH =
required("FEEDBACK_PATH");
const WORKTREE = required("WORKTREE");
const BASE = process.env.BASE || "develop";

async function main() {
  console.log("═══ Triager timing ═══");
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
