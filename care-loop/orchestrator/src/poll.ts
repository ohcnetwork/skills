// poll.ts — token-free wait for bot reviews + CI, ported from poll-pr.sh onto the GitHubApi
// boundary (no `gh`, no subprocess, no pager). Blocks until every configured bot has responded
// after the baseline AND CI is terminal, or a timeout. The per-round decision is a PURE function
// over already-fetched data (unit-testable); the async loop just fetches + sleeps.
//
// This is the IMP-5 kill-shot in reliable form: the orchestrator awaits pollPr() and self-resumes
// the instant it returns — no "status?" nudge, and no terminal to wedge.

import type {
  CheckSummary,
  CiConclusion,
  GitHubApi,
  PrComment,
  PrReview,
} from "./github.js";

/** A reviewer bot and its alias logins (e.g. Copilot posts reviews + inline comments under 2 logins). */
export interface Bot {
  name: string; // canonical label for reporting
  aliases: string[]; // logins that all count as this one bot
  /** Commit-status context substrings that signal this bot is ACTIVE on the PR (e.g. "CodeRabbit").
   *  Defaults to [name]. Used to (a) treat the bot's own status as advisory (non-blocking for CI) and
   *  (b) detect presence — the loop only waits for a bot that shows a presence. */
  statusPatterns?: string[];
}

/** Does a commit-status context belong to this bot? (case-insensitive substring over statusPatterns) */
export function botMatchesContext(bot: Bot, context: string): boolean {
  const ctx = context.toLowerCase();
  return (bot.statusPatterns ?? [bot.name]).some(
    (p) => p !== "" && ctx.includes(p.toLowerCase()),
  );
}

export interface PollOptions {
  pr: number;
  sinceIso: string; // baseline: only signals AFTER this count (pass the push time)
  sha?: string; // pushed SHA — matched in bot summary bodies (Greptile edits in place)
  bots: Bot[];
  timeoutMs?: number; // default 30 min
  intervalMs?: number; // default 60 s
  ciGraceMs?: number; // default 120 s — how long "no checks yet" reads as not-started
}

export interface PollResult {
  converged: boolean;
  reason: "converged" | "timeout";
  missing: string[]; // bot names still not responded
  ci: CiConclusion;
  rounds: number;
}

/** One bot has arrived if ANY alias produced a post-baseline review/comment, or referenced the SHA. */
export function botArrived(
  bot: Bot,
  reviews: PrReview[],
  reviewComments: PrComment[],
  issueComments: PrComment[],
  sinceIso: string,
  sha?: string,
): boolean {
  const since = Date.parse(sinceIso);
  const after = (iso: string) => iso !== "" && Date.parse(iso) > since;
  return bot.aliases.some(
    (a) =>
      reviews.some((r) => r.user === a && after(r.submittedAt)) ||
      reviewComments.some(
        (c) => c.user === a && (after(c.createdAt) || after(c.updatedAt)),
      ) ||
      issueComments.some(
        (c) =>
          c.user === a &&
          (after(c.createdAt) ||
            after(c.updatedAt) ||
            (!!sha && c.body.includes(sha))),
      ),
  );
}

/** CI is terminal when no REAL check is pending. Advisory review-bot commit statuses (e.g. a
 *  perpetually-pending "CodeRabbit" context that the bot sets but never clears) are excluded — a
 *  review bot's feedback is tracked via its review/comments (botArrived), not its status marker.
 *  Zero real checks only counts as terminal past the grace window. */
export function ciTerminal(
  checks: CheckSummary,
  graceElapsed: boolean,
  bots: Bot[] = [],
): boolean {
  const isBot = (ctx: string) => bots.some((b) => botMatchesContext(b, ctx));
  const botStatuses = (checks.statuses ?? []).filter((s) => isBot(s.context));
  const botPending = botStatuses.filter((s) => s.state === "pending").length;
  const realTotal = checks.total - botStatuses.length;
  const realPending = checks.pending - botPending;
  if (realTotal <= 0) return graceElapsed;
  return realPending === 0;
}

/** Which configured bots are we still legitimately waiting on? A bot is waited for ONLY if it has a
 *  PRESENCE (a matching commit-status context = it's actively reviewing) and hasn't posted yet. A bot
 *  with no presence is treated as not-participating and skipped ONCE the grace window elapses (so a
 *  bot that isn't installed / is down — e.g. codex on a repo without it — never blocks convergence).
 *  Before grace, a not-yet-seen bot is still waited for (it may just be slow to register). */
export function missingBots(
  bots: Bot[],
  reviews: PrReview[],
  reviewComments: PrComment[],
  issueComments: PrComment[],
  checks: CheckSummary,
  sinceIso: string,
  graceElapsed: boolean,
  sha?: string,
): string[] {
  return bots
    .filter((b) => {
      if (botArrived(b, reviews, reviewComments, issueComments, sinceIso, sha))
        return false; // done
      const present = (checks.statuses ?? []).some((s) =>
        botMatchesContext(b, s.context),
      );
      if (present) return true; // actively reviewing (status set) but hasn't posted yet → wait
      return !graceElapsed; // absent: wait only until grace elapses, then treat as not-participating
    })
    .map((b) => b.name);
}

/** Evaluate one already-fetched round (pure). */
export function evaluateRound(
  bots: Bot[],
  reviews: PrReview[],
  reviewComments: PrComment[],
  issueComments: PrComment[],
  checks: CheckSummary,
  sinceIso: string,
  graceElapsed: boolean,
  sha?: string,
): { missing: string[]; ciOk: boolean } {
  const missing = missingBots(
    bots,
    reviews,
    reviewComments,
    issueComments,
    checks,
    sinceIso,
    graceElapsed,
    sha,
  );
  return { missing, ciOk: ciTerminal(checks, graceElapsed, bots) };
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The blocking wait. `now`/`sleep` are injectable so tests run instantly and deterministically. */
export async function pollPr(
  gh: GitHubApi,
  o: PollOptions,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PollResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepReal;
  const timeout = o.timeoutMs ?? 30 * 60_000;
  const interval = o.intervalMs ?? 60_000;
  const grace = o.ciGraceMs ?? 120_000;

  const start = now();
  const deadline = start + timeout;
  const graceUntil = start + grace;
  // Hard iteration cap: even with a mis-injected/stuck clock (now() not advancing), the wait can
  // never spin forever — it is bounded by the intended number of poll intervals.
  const maxIterations = Math.max(
    2,
    Math.ceil(timeout / Math.max(interval, 1)) + 2,
  );
  let rounds = 0;

  for (;;) {
    rounds++;
    const [reviews, reviewComments, issueComments] = await Promise.all([
      gh.listReviews(o.pr),
      gh.listReviewComments(o.pr),
      gh.listIssueComments(o.pr),
    ]);
    const pr = await gh.getPr(o.pr);
    const checks = await gh.getChecks(pr.headSha);
    const { missing, ciOk } = evaluateRound(
      o.bots,
      reviews,
      reviewComments,
      issueComments,
      checks,
      o.sinceIso,
      now() >= graceUntil,
      o.sha,
    );

    if (missing.length === 0 && ciOk) {
      return {
        converged: true,
        reason: "converged",
        missing: [],
        ci: checks.conclusion,
        rounds,
      };
    }
    if (now() >= deadline || rounds >= maxIterations) {
      return {
        converged: false,
        reason: "timeout",
        missing,
        ci: checks.conclusion,
        rounds,
      };
    }
    await sleep(interval);
  }
}

/** The care_fe default bot set (single-sourced from poll-pr.sh's default). */
export const CARE_FE_BOTS: Bot[] = [
  { name: "coderabbit", aliases: ["coderabbitai[bot]"] },
  { name: "greptile", aliases: ["greptile-apps[bot]"] },
  {
    name: "copilot",
    aliases: ["copilot-pull-request-reviewer[bot]", "Copilot"],
  },
  { name: "codex", aliases: ["chatgpt-codex-connector[bot]"] },
];
