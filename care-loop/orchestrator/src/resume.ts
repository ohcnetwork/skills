// resume.ts — the PR-derived half of resume-probe.sh over the GitHubApi boundary. The git/fs half
// (working-tree dirty, local HEAD, pushed-ahead relation, run-dir artifacts) stays with git+fs in
// the caller — those aren't gh and have no API substitute. This module answers the three facts that
// required `gh`: the PR head SHA, which reviewers are up-to-date at the local head, and CI status.

import type { CiConclusion, GitHubApi } from "./github.js";

export interface PrProbe {
  prHead: string;
  state: string; // open | closed
  botsAtHead: string[]; // reviewer logins whose review is AT the local head (up to date)
  ci: CiConclusion;
}

/** PR-side ground truth for resume. `localHead` = the worktree's current HEAD SHA (git, caller). */
export async function probePr(gh: GitHubApi, pr: number, localHead: string): Promise<PrProbe> {
  const [info, reviews] = await Promise.all([gh.getPr(pr), gh.listReviews(pr)]);
  const checks = await gh.getChecks(info.headSha);
  const botsAtHead = [...new Set(reviews.filter((r) => r.commitId === localHead).map((r) => r.user))].sort();
  return { prHead: info.headSha, state: info.state, botsAtHead, ci: checks.conclusion };
}
