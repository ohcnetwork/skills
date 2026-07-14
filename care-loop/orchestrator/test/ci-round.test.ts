import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCiRounds,
  type CiRoundsOptions,
  type TriageResult,
} from "../src/ci-round.ts";
import { Journal } from "../src/journal.ts";
import { makeFakeGitHub } from "./fake-github.ts";
import type { CiConclusion } from "../src/github.ts";

const rd = () => mkdtempSync(join(tmpdir(), "careloopd-ci-"));
const BOTS = [{ name: "a", aliases: ["a[bot]"] }];

// A GitHub fake whose single bot has reviewed at head and CI is terminal → pollPr converges at once.
// submittedAt is far-future so the review counts as "arrived" against ANY round's baseline (runCiRounds
// advances sinceIso to now() on each re-round).
const convergingGh = (ci: CiConclusion = "pass") =>
  makeFakeGitHub({
    getPr: async () => ({
      number: 1,
      state: "open",
      headSha: "h",
      headRef: "b",
      title: "[ENG-1] x",
    }),
    listReviews: async () => [
      {
        user: "a[bot]",
        submittedAt: "2099-01-01T00:00:00Z",
        state: "COMMENTED",
        commitId: "h",
      },
    ],
    getChecks: async () => ({
      total: 1,
      pending: 0,
      failing: ci === "fail" ? 1 : 0,
      conclusion: ci,
    }),
  });

function opts(over: Partial<CiRoundsOptions> = {}): CiRoundsOptions {
  return {
    gh: convergingGh(),
    runDir: rd(),
    repo: "ohcnetwork/care_fe",
    branch: "scratch",
    pr: 1,
    headSha: "h",
    sinceIso: "2026-07-13T00:00:00Z",
    bots: BOTS,
    triage: async () => ({ addressCount: 0, declineCount: 0, deferCount: 0 }),
    apply: async () => ({ terminalState: "done" }),
    gate: () => ({ exit: 0, summary: "run_gate: ALL PASSED" }),
    push: () => ({ exit: 0, summary: "pushed", headSha: "h2" }),
    pollDeps: { now: () => 0, sleep: async () => {} },
    ...over,
  };
}

test("converges in round 1 when CI is green and triage finds nothing to address (zero nudges)", async () => {
  const o = opts();
  const res = await runCiRounds(o);
  assert.equal(res.outcome, "converged");
  assert.equal(res.rounds, 1);
  assert.equal(res.state.step, "7");

  const { events, truncatedTail } = new Journal(
    join(o.runDir, "journal.jsonl"),
    "x",
  ).read();
  assert.equal(truncatedTail, false);
  assert.ok(existsSync(join(o.runDir, "loop.log")));
  assert.match(readFileSync(join(o.runDir, "loop.log"), "utf8"), /ci\.done/);
});

test("one address round then converge: 6a→6b→5→5-await→6a→7", async () => {
  let call = 0;
  const triage = async (): Promise<TriageResult> => {
    call++;
    return call === 1
      ? { addressCount: 2, declineCount: 0, deferCount: 0 }
      : { addressCount: 0, declineCount: 0, deferCount: 0 };
  };
  const res = await runCiRounds(opts({ triage }));
  assert.equal(res.outcome, "converged");
  assert.equal(res.rounds, 2); // one loop-back bumped the round
});

test("poll timeout → deferred checkpoint (not a hang)", async () => {
  const noBot = makeFakeGitHub({
    getPr: async () => ({
      number: 1,
      state: "open",
      headSha: "h",
      headRef: "b",
      title: "t",
    }),
    listReviews: async () => [], // bot never responds
    getChecks: async () => ({
      total: 1,
      pending: 1,
      failing: 0,
      conclusion: "pending",
    }),
  });
  let t = 0;
  const res = await runCiRounds(
    opts({
      gh: noBot,
      cfg: { pollTimeoutMs: 100, pollIntervalMs: 10 },
      pollDeps: { now: () => (t += 1000), sleep: async () => {} },
    }),
  );
  assert.equal(res.outcome, "deferred");
});

test("a defer-to-human verdict checkpoints the run", async () => {
  const res = await runCiRounds(
    opts({
      triage: async () => ({ addressCount: 0, declineCount: 0, deferCount: 1 }),
    }),
  );
  assert.equal(res.outcome, "deferred");
  assert.equal(res.state.step, "6a");
});

test("never-clean triage is capped at maxRounds (bounded loop)", async () => {
  const res = await runCiRounds(
    opts({
      triage: async () => ({ addressCount: 1, declineCount: 0, deferCount: 0 }),
      cfg: { maxRounds: 2 },
    }),
  );
  assert.equal(res.outcome, "capped");
  assert.equal(res.rounds, 3); // rounds 1 and 2 ran; the 3rd trip past the cap stops it
});

test("CI red with nothing to auto-apply → deferred, not a futile loop", async () => {
  const res = await runCiRounds(
    opts({
      gh: convergingGh("fail"),
      triage: async () => ({ addressCount: 0, declineCount: 0, deferCount: 0 }),
    }),
  );
  assert.equal(res.outcome, "deferred");
});
