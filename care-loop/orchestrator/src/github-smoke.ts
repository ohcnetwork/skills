// github-smoke.ts — read-only liveness check of the Octokit GitHubApi boundary (no writes).
// Proves the token resolves and every read path works over HTTPS (no gh, no pager, no wedge).
// Usage: npm run smoke:github [-- <pr-number>]   (default PR: 16557, the closed CI-probe PR)

import { OctokitGitHub } from "./github.js";
import { collectFeedback } from "./feedback.js";
import { probePr } from "./resume.js";

const pr = Number(process.argv[2] ?? process.env.SMOKE_PR ?? 16557);

async function main() {
  const gh = new OctokitGitHub();
  console.log(`▶ Octokit smoke test — read-only, PR #${pr} on ohcnetwork/care_fe\n`);

  const info = await gh.getPr(pr);
  console.log(`  getPr           → #${info.number} ${info.state}  head=${info.headSha.slice(0, 9)}  "${info.title}"`);

  const reviews = await gh.listReviews(pr);
  console.log(`  listReviews     → ${reviews.length} (bots: ${[...new Set(reviews.map((r) => r.user))].filter((u) => u.includes("[bot]")).join(", ") || "none"})`);

  const revComments = await gh.listReviewComments(pr);
  console.log(`  listReviewComments → ${revComments.length}`);

  const issComments = await gh.listIssueComments(pr);
  console.log(`  listIssueComments  → ${issComments.length}`);

  const checks = await gh.getChecks(info.headSha);
  console.log(`  getChecks       → total=${checks.total} pending=${checks.pending} failing=${checks.failing} → ${checks.conclusion}`);

  // new ports: collect-feedback + resume-probe (PR half)
  const fb = await collectFeedback(gh, { pr });
  console.log(`  collectFeedback → ${fb.count} bot item(s) digested (${fb.markdown.length} chars)`);

  const probe = await probePr(gh, pr, info.headSha);
  console.log(`  probePr         → state=${probe.state} ci=${probe.ci} bots-at-head=[${probe.botsAtHead.join(", ") || "none"}]`);

  console.log(`\n✅ GitHubApi (Octokit) live — poll, feedback, and resume-probe all off the gh CLI.`);
}

main().catch((err) => {
  console.error(`\n❌ smoke FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
