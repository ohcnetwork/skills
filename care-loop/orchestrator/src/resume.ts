// resume.ts — the PR-derived half of resume-probe.sh over the GitHubApi boundary. The git/fs half
// (working-tree dirty, local HEAD, pushed-ahead relation, run-dir artifacts) stays with git+fs in
// the caller — those aren't gh and have no API substitute. This module answers the three facts that
// required `gh`: the PR head SHA, which reviewers are up-to-date at the local head, and CI status.

import type { CiConclusion, GitHubApi } from "./github.js";
import type { JournalEvent } from "./journal.js";
import { projectState, type CareState } from "./state.js";

export interface PrProbe {
  prHead: string;
  state: string; // open | closed
  botsAtHead: string[]; // reviewer logins whose review is AT the local head (up to date)
  ci: CiConclusion;
}

/** PR-side ground truth for resume. `localHead` = the worktree's current HEAD SHA (git, caller). */
export async function probePr(
  gh: GitHubApi,
  pr: number,
  localHead: string,
): Promise<PrProbe> {
  const [info, reviews] = await Promise.all([gh.getPr(pr), gh.listReviews(pr)]);
  const checks = await gh.getChecks(info.headSha);
  const botsAtHead = [
    ...new Set(
      reviews.filter((r) => r.commitId === localHead).map((r) => r.user),
    ),
  ].sort();
  return {
    prHead: info.headSha,
    state: info.state,
    botsAtHead,
    ci: checks.conclusion,
  };
}

export interface ResumePlan {
  resumable: boolean;
  reason: string;
  state: CareState; // projected journal-head state (the ground truth resume reconciles against)
  pr?: number; // present iff resumable
  headSha?: string;
  round?: number;
  sinceIso?: string; // the bot-activity baseline: when the current head was pushed (NOT resume-time)
}

/**
 * Decide, from a run's journal ALONE, whether it can be resumed into the CI-round loop — the pure
 * core `cmdResume` wraps with real seams. v1 scope: the CI stage (a PR is open and the run hasn't
 * ended). The plan/build stages are NOT yet re-entrant (`runStart` always rebuilds from step 2 and
 * would open a duplicate PR), so resume refuses those with a clear reason instead of corrupting a run.
 */
export function planResume(events: JournalEvent[]): ResumePlan {
  const state = projectState(events);
  // A `run.end` normally means terminal — EXCEPT `deferred`, which is a CHECKPOINT (an external-stuck
  // state: CI red with no more auto-fixes, or a poll timeout). `deferred` is exactly what resume is
  // meant to pick up: re-enter the CI stage, re-poll, re-triage, and (with 6c wired) run the ci-fix
  // track. Every other outcome — converged | capped | gate-blocked | aborted | push-failed — is
  // genuinely terminal and stays refused. We read the LAST run.end so a resumed-then-re-deferred run
  // can be resumed again.
  const lastEnd = [...events].reverse().find((e) => e.event === "run.end");
  if (lastEnd) {
    const outcome = (lastEnd.data as { outcome?: string } | undefined)?.outcome;
    if (outcome !== "deferred") {
      return {
        resumable: false,
        reason: `run already ended (outcome=${outcome ?? "unknown"}, step=${state.step})`,
        state,
      };
    }
  }
  if (state.pr == null) {
    return {
      resumable: false,
      reason: `no PR opened yet (step=${state.step}) — resume currently re-enters the CI stage only; re-run from the start for an earlier crash`,
      state,
    };
  }
  // sinceIso = when the CURRENT head was pushed — the baseline botArrived/missingBots measure against.
  // Using resume-time (now) would treat every bot that ALREADY reviewed this head as "not yet arrived"
  // and wait for them forever (they won't re-review an unchanged head), stalling the poll until timeout.
  const pushes = events.filter((e) => e.event === "push");
  const headPush =
    [...pushes]
      .reverse()
      .find(
        (e) =>
          (e.data as { head_sha?: string } | undefined)?.head_sha ===
          state.head_sha,
      ) ?? pushes[pushes.length - 1];
  const sinceIso = headPush?.ts ?? events[0]?.ts ?? new Date(0).toISOString();
  return {
    resumable: true,
    reason: `resume at CI round ${state.round} (pr #${state.pr}, head ${state.head_sha.slice(0, 9)})`,
    state,
    pr: state.pr,
    headSha: state.head_sha,
    round: state.round,
    sinceIso,
  };
}
