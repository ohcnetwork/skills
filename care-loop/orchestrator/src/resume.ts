// resume.ts — the PR-derived half of resume-probe.sh over the GitHubApi boundary. The git/fs half
// (working-tree dirty, local HEAD, pushed-ahead relation, run-dir artifacts) stays with git+fs in
// the caller — those aren't gh and have no API substitute. This module answers the three facts that
// required `gh`: the PR head SHA, which reviewers are up-to-date at the local head, and CI status.

import type { CiConclusion, GitHubApi } from "./github.js";
import type { JournalEvent } from "./journal.js";
import { projectState, type CareState, type Step } from "./state.js";

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
  /** Which stage the run re-enters. "ci" = a PR is open, re-enter the CI-round loop. "build" = a
   *  crash AFTER plan approval but BEFORE the PR was opened — re-enter the build pipeline (§ below). */
  mode: "ci" | "build";
  reason: string;
  state: CareState; // projected journal-head state (the ground truth resume reconciles against)
  pr?: number; // present iff resumable && mode==="ci"
  headSha?: string;
  round?: number;
  sinceIso?: string; // the bot-activity baseline: when the current head was pushed (NOT resume-time)
  // ── build-mode fields (present iff resumable && mode==="build") ──
  resumeStep?: Step; // the interrupted build step to re-enter (idempotent: setup skips an existing
  // worktree, review is read-only)
  ticket?: string; // persisted in plan.approved (older runs lack it — the caller falls back to a flag)
  summary?: string; // persisted in plan.approved (older runs lack it — the caller falls back)
}

/** The build steps a crashed pre-PR run can re-enter. A crash at step 1 (plan/interview) is NOT here —
 *  the interview isn't re-entrant, so it must re-run from the start. */
const BUILD_STEPS = new Set<string>(["2", "3", "4a", "4b", "4c", "5"]);

/** Pull the ticket/summary the plan stage persisted into the `plan.approved` event (added 2026-07-21
 *  so a build-stage resume can reopen the PR without re-supplied flags). Older runs predate this and
 *  return {} — the caller falls back to --ticket/--summary (or derives from the branch). */
function readPlanMeta(events: JournalEvent[]): {
  ticket?: string;
  summary?: string;
} {
  const ev = events.find((e) => e.event === "plan.approved");
  const d = ev?.data as { ticket?: string; summary?: string } | undefined;
  return { ticket: d?.ticket, summary: d?.summary };
}

/**
 * Decide, from a run's journal ALONE, whether it can be resumed — the pure core `cmdResume` wraps with
 * real seams. Two re-entry modes:
 *   • mode "ci"    — a PR is open and the run hasn't terminally ended: re-enter the CI-round loop at the
 *                    journal-head round (no re-push, no duplicate PR).
 *   • mode "build" — the run crashed AFTER plan approval but BEFORE opening a PR (no `pr` yet). The
 *                    worktree may already hold the maker's edits + a partial review; re-enter the build
 *                    pipeline at the interrupted step and let it flow through to push → PR → CI exactly
 *                    as a fresh `start` would. Idempotent: setup-worktree skips an existing checkout and
 *                    the review steps are read-only, so re-running the interrupted step is safe.
 * Refused (re-run from the start) when: the plan never completed (no `plan.approved` — the interview
 * isn't re-entrant), or the build already ABORTED (a terminal run.end — re-running won't fix an
 * exhausted maker).
 */
export function planResume(events: JournalEvent[]): ResumePlan {
  const state = projectState(events);
  // A `run.end` normally means terminal — EXCEPT the CHECKPOINT outcomes, which are budget/external-stuck
  // states with an open PR that resume is meant to pick up by re-entering the CI stage:
  //   • `deferred` — external-stuck: CI red with no more auto-fixes, or a poll timeout. Resume re-polls,
  //     re-triages, and (with 6c wired) runs the ci-fix track.
  //   • `capped`   — the round/implement budget ran out; nothing was actually resolved. Raising
  //     `--max-rounds` and resuming continues the SAME PR from its head round (the counter carries over).
  // Every other outcome — converged | gate-blocked | aborted | push-failed — is genuinely terminal and
  // stays refused. We read the LAST run.end so a resumed-then-re-checkpointed run can be resumed again.
  const RESUMABLE_OUTCOMES = new Set(["deferred", "capped"]);
  const lastEnd = [...events].reverse().find((e) => e.event === "run.end");
  const lastOutcome = (lastEnd?.data as { outcome?: string } | undefined)
    ?.outcome;

  // ── Build-stage resume: no PR opened yet ──────────────────────────────────────────────────────
  if (state.pr == null) {
    // ANY run.end with no PR is a terminal build outcome (aborted / plan_rejected / plan_wrong_tier /
    // push-failed-before-PR): re-running won't help, refuse and let the operator re-run from the start.
    if (lastEnd) {
      return {
        resumable: false,
        mode: "build",
        reason: `run already ended before opening a PR (outcome=${lastOutcome ?? "unknown"}, step=${state.step}) — re-run from the start`,
        state,
      };
    }
    const approved = events.some((e) => e.event === "plan.approved");
    if (!approved || !BUILD_STEPS.has(state.step)) {
      return {
        resumable: false,
        mode: "build",
        reason: approved
          ? `crashed at step ${state.step} (pre-build) — the plan/interview stage isn't re-entrant; re-run from the start`
          : `no PR opened yet and the plan was never approved (step=${state.step}) — the plan/interview stage isn't re-entrant; re-run from the start`,
        state,
      };
    }
    // Re-enter at the last step we ENTERED but never cleanly exited — the interrupted step.
    const lastEnter = [...events]
      .reverse()
      .find((e) => e.event === "step.enter");
    const resumeStep = (lastEnter?.step ?? state.step) as Step;
    const meta = readPlanMeta(events);
    return {
      resumable: true,
      mode: "build",
      reason: `resume the build at step ${resumeStep} (no PR yet; branch ${state.branch})`,
      state,
      resumeStep,
      ticket: meta.ticket,
      summary: meta.summary,
    };
  }

  // ── CI-stage resume: a PR is open ─────────────────────────────────────────────────────────────
  if (lastEnd && !RESUMABLE_OUTCOMES.has(lastOutcome ?? "")) {
    return {
      resumable: false,
      mode: "ci",
      reason: `run already ended (outcome=${lastOutcome ?? "unknown"}, step=${state.step})`,
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
    mode: "ci",
    reason: `resume at CI round ${state.round} (pr #${state.pr}, head ${state.head_sha.slice(0, 9)})`,
    state,
    pr: state.pr,
    headSha: state.head_sha,
    round: state.round,
    sinceIso,
  };
}
