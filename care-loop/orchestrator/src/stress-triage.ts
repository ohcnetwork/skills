// stress-triage.ts — run the triager fan-out N times sequentially and report pass/fail.
// Tests reliability of the base warm-up retry + 90s timeout fix against Copilot flakiness.
//
// Run: npx tsx src/stress-triage.ts
// Env: N (default 5), FEEDBACK_PATH, WORKTREE, BASE (same as ab-triager.ts)

import { opencodeTriager } from "./skills-opencode.js";

const N = Number(process.env.N ?? 5);
const FEEDBACK_PATH =
  process.env.FEEDBACK_PATH ||
  "/Users/jacob/Desktop/skills/care-loop/runs/care_fe-eng-642-questionnaire-value-cleanup/feedback.md";
const WORKTREE = process.env.WORKTREE || "/Users/jacob/Desktop/care_fe-eng-642-questionnaire-value-cleanup";
const BASE = process.env.BASE || "develop";

async function runOnce(i: number): Promise<{ ok: boolean; wall: number; verdict: string; a: number; d: number }> {
  const triager = opencodeTriager({}, WORKTREE, BASE);
  const t0 = Date.now();
  try {
    const res = await triager({ pr: 0, round: i, runDir: "/tmp", feedbackPath: FEEDBACK_PATH });
    const wall = (Date.now() - t0) / 1000;
    const p = res.payload;
    return { ok: true, wall, verdict: res.verdict, a: p.addressCount, d: p.declineCount };
  } catch (e) {
    return { ok: false, wall: (Date.now() - t0) / 1000, verdict: "ERROR", a: 0, d: 0 };
  }
}

async function main() {
  console.log(`═══ Triager stress test  N=${N} (parallel) ═══`);
  console.log(`Feedback: ${FEEDBACK_PATH}`);
  console.log(`Worktree: ${WORKTREE}\n`);

  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => runOnce(i + 1)),
  );

  console.log(`\n═══ Results ═══`);
  results.forEach((r, i) => {
    const status = r.ok ? "✓" : "✗";
    console.log(`Run ${i + 1}: ${status}  ${r.wall.toFixed(1)}s  verdict=${r.verdict}  A=${r.a} D=${r.d}`);
  });

  const pass = results.filter((r) => r.ok).length;
  const walls = results.filter((r) => r.ok).map((r) => r.wall);
  const avgWall = walls.length ? walls.reduce((a, b) => a + b, 0) / walls.length : 0;
  const maxWall = walls.length ? Math.max(...walls) : 0;
  console.log(`\n═══ Summary ═══`);
  console.log(`Pass: ${pass}/${N}  (${((pass / N) * 100).toFixed(0)}%)`);
  if (walls.length) console.log(`Wall: avg=${avgWall.toFixed(1)}s  max=${maxWall.toFixed(1)}s  (parallel, so wall≈max)`);
  if (pass < N) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
