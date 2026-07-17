import { test } from "node:test";
import assert from "node:assert/strict";
import {
  botArrived,
  ciTerminal,
  missingBots,
  evaluateRound,
  pollPr,
  CARE_FE_BOTS,
  type Bot,
} from "../src/poll.ts";
import type {
  CheckSummary,
  GitHubApi,
  PrComment,
  PrInfo,
  PrReview,
} from "../src/github.ts";

const SINCE = "2026-07-13T10:00:00Z";
const AFTER = "2026-07-13T10:05:00Z";
const BEFORE = "2026-07-13T09:55:00Z";
const bot = (name: string, ...aliases: string[]): Bot => ({ name, aliases });

const review = (user: string, submittedAt: string): PrReview => ({
  user,
  submittedAt,
  state: "COMMENTED",
  commitId: "",
});
const comment = (user: string, createdAt: string, body = ""): PrComment => ({
  user,
  createdAt,
  updatedAt: createdAt,
  body,
});
const checks = (
  pending: number,
  failing = 0,
  total = pending + failing + 1,
  statuses: { context: string; state: string }[] = [],
): CheckSummary => ({
  total,
  pending,
  failing,
  statuses,
  conclusion:
    total === 0
      ? "none"
      : failing > 0
        ? "fail"
        : pending > 0
          ? "pending"
          : "pass",
});

test("botArrived: a post-baseline review counts; a pre-baseline one does not", () => {
  const b = bot("greptile", "greptile-apps[bot]");
  assert.equal(
    botArrived(b, [review("greptile-apps[bot]", AFTER)], [], [], SINCE),
    true,
  );
  assert.equal(
    botArrived(b, [review("greptile-apps[bot]", BEFORE)], [], [], SINCE),
    false,
  );
});

test("botArrived: SHA in an issue comment body counts (Greptile edits in place)", () => {
  const b = bot("greptile", "greptile-apps[bot]");
  const c = comment(
    "greptile-apps[bot]",
    BEFORE,
    "Last reviewed commit: abc123def",
  );
  assert.equal(botArrived(b, [], [], [c], SINCE, "abc123def"), true);
  assert.equal(botArrived(b, [], [], [c], SINCE, "zzz999"), false);
});

test("botArrived: any alias satisfies the bot (Copilot's two logins)", () => {
  const b = bot("copilot", "copilot-pull-request-reviewer[bot]", "Copilot");
  assert.equal(botArrived(b, [], [comment("Copilot", AFTER)], [], SINCE), true);
});

test("ciTerminal: zero checks only terminal past the grace window", () => {
  assert.equal(ciTerminal(checks(0, 0, 0), false), false);
  assert.equal(ciTerminal(checks(0, 0, 0), true), true);
  assert.equal(ciTerminal(checks(1), true), false); // a pending check is never terminal
  assert.equal(ciTerminal(checks(0, 1), false), true); // failing-but-settled is terminal
});

test("ciTerminal: a pending review-bot status context is advisory, not a CI gate", () => {
  const bots = [bot("coderabbit", "coderabbitai[bot]")];
  // one real passing check + a stuck-pending "CodeRabbit" commit status
  const c = checks(1, 0, 2, [{ context: "CodeRabbit", state: "pending" }]);
  assert.equal(ciTerminal(c, true, bots), true); // bot status excluded → terminal
  assert.equal(ciTerminal(c, true, []), false); // without bot-awareness → old blocking behavior
});

test("missingBots: an absent bot (no presence) is skipped once grace elapses (e.g. codex not installed)", () => {
  const bots = [
    bot("copilot", "Copilot"),
    bot("codex", "chatgpt-codex-connector[bot]"),
  ];
  const reviews = [review("Copilot", AFTER)]; // copilot posted; codex has no status + no post
  assert.deepEqual(
    missingBots(bots, reviews, [], [], checks(0), SINCE, true),
    [],
  ); // codex skipped
  assert.deepEqual(
    missingBots(bots, reviews, [], [], checks(0), SINCE, false),
    ["codex"],
  ); // before grace, still waited
});

test("missingBots: a present bot (status set) that hasn't posted is still waited on", () => {
  const bots = [bot("a", "a[bot]"), bot("coderabbit", "coderabbitai[bot]")];
  // coderabbit set its status (present) but hasn't posted a review yet → keep waiting even past grace
  const c = checks(0, 0, 1, [{ context: "CodeRabbit", state: "pending" }]);
  assert.deepEqual(
    missingBots(bots, [review("a[bot]", AFTER)], [], [], c, SINCE, true),
    ["coderabbit"],
  );
});

test("evaluateRound reports the missing bots", () => {
  const bots = [bot("a", "a[bot]"), bot("b", "b[bot]")];
  const r = evaluateRound(
    bots,
    [review("a[bot]", AFTER)],
    [],
    [],
    checks(0),
    SINCE,
    false, // before grace: a not-yet-seen bot is still waited for
  );
  assert.deepEqual(r.missing, ["b"]);
  assert.equal(r.ciOk, true);
});

// A fake GitHubApi whose data evolves across rounds — simulates bots + CI arriving over time.
class FakeGitHub implements GitHubApi {
  round = 0;
  constructor(
    private script: Array<{ reviews?: PrReview[]; checks?: CheckSummary }>,
  ) {}
  private cur() {
    return this.script[Math.min(this.round, this.script.length - 1)];
  }
  async getPr(): Promise<PrInfo> {
    return {
      number: 1,
      state: "open",
      headSha: "deadbeef",
      headRef: "scratch",
      title: "[ENG-648] x",
    };
  }
  async listReviews(): Promise<PrReview[]> {
    const r = this.cur().reviews ?? [];
    this.round++; // advance once per fetch cycle (listReviews is first in pollPr's round)
    return r;
  }
  async listReviewComments(): Promise<PrComment[]> {
    return [];
  }
  async listIssueComments(): Promise<PrComment[]> {
    return [];
  }
  async getChecks(): Promise<CheckSummary> {
    return this.cur().checks ?? checks(0, 0, 0);
  }
  async listResolvedReviewCommentIds(): Promise<number[]> {
    return [];
  }
  async listReviewThreads() {
    return [];
  }
  async replyToReviewComment(): Promise<void> {}
  async resolveReviewThread(): Promise<void> {}
  async createPr(): Promise<number> {
    return 1;
  }
  async addLabel(): Promise<void> {}
  async createComment(): Promise<void> {}
  async listFailingChecks(): Promise<{ name: string; summary?: string }[]> {
    return [];
  }
  async getCheckFailureContext() {
    return [];
  }
}

test("pollPr converges with ZERO nudges once all bots + CI arrive (IMP-5 kill-shot)", async () => {
  // round 1: no bots yet, CI pending → round 2: both bots in, CI pass → converge.
  // Non-zero grace (with a frozen clock) keeps grace un-elapsed, so the not-yet-arrived bots are
  // still waited for in round 1 (presence-gating only skips absent bots AFTER grace).
  const both = [review("a[bot]", AFTER), review("b[bot]", AFTER)];
  const gh = new FakeGitHub([
    { reviews: [], checks: checks(2) },
    { reviews: both, checks: checks(0) },
  ]);
  let slept = 0;
  const res = await pollPr(
    gh,
    {
      pr: 1,
      sinceIso: SINCE,
      bots: [bot("a", "a[bot]"), bot("b", "b[bot]")],
      ciGraceMs: 100000,
    },
    { now: () => 0, sleep: async () => void slept++ },
  );
  assert.equal(res.converged, true);
  assert.equal(res.reason, "converged");
  assert.equal(res.ci, "pass");
  assert.ok(res.rounds >= 2);
  assert.ok(slept >= 1);
});

test("pollPr returns timeout (not a hang) when a PRESENT bot never posts", async () => {
  const gh = new FakeGitHub([
    // 'b' set its status context (present, actively reviewing) but never posts a review
    {
      reviews: [review("a[bot]", AFTER)],
      checks: checks(0, 0, 1, [{ context: "b", state: "pending" }]),
    },
  ]);
  let t = 0;
  const res = await pollPr(
    gh,
    {
      pr: 1,
      sinceIso: SINCE,
      bots: [bot("a", "a[bot]"), bot("b", "b[bot]")],
      timeoutMs: 100,
      intervalMs: 40,
      ciGraceMs: 0,
    },
    { now: () => (t += 60), sleep: async () => {} }, // clock jumps 60ms/read → crosses 100ms deadline fast
  );
  assert.equal(res.converged, false);
  assert.equal(res.reason, "timeout");
  assert.deepEqual(res.missing, ["b"]);
});

test("pollPr converges (does NOT hang) when a configured bot is simply absent", async () => {
  // 'a' reviews + CI passes; 'b' never shows any presence → skipped after grace → converge.
  const gh = new FakeGitHub([
    { reviews: [review("a[bot]", AFTER)], checks: checks(0) },
  ]);
  const res = await pollPr(
    gh,
    {
      pr: 1,
      sinceIso: SINCE,
      bots: [bot("a", "a[bot]"), bot("b", "b[bot]")],
      timeoutMs: 1000,
      intervalMs: 40,
      ciGraceMs: 0,
    },
    { now: () => 0, sleep: async () => {} },
  );
  assert.equal(res.converged, true);
  assert.equal(res.reason, "converged");
});

test("CARE_FE_BOTS carries the four-bot default with Copilot's alias pair", () => {
  assert.equal(CARE_FE_BOTS.length, 4);
  assert.deepEqual(CARE_FE_BOTS.find((b) => b.name === "copilot")?.aliases, [
    "copilot-pull-request-reviewer[bot]",
    "Copilot",
  ]);
});
