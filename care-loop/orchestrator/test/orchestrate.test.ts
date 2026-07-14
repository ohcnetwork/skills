import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStart, roleSpawn, type StartOptions } from "../src/orchestrate.ts";
import type { SpawnFn, HelperFn } from "../src/pipeline.ts";
import type { CiConclusion } from "../src/github.ts";
import type { Reviewer, Implementer } from "../src/ports.ts";
import { makeFakeGitHub } from "./fake-github.ts";

const rd = () => mkdtempSync(join(tmpdir(), "careloopd-orch-"));
const BOTS = [{ name: "a", aliases: ["a[bot]"] }];

const convergingGh = (ci: CiConclusion = "pass", prNumber = 100) =>
  makeFakeGitHub({
    getPr: async () => ({
      number: prNumber,
      state: "open",
      headSha: "h2",
      headRef: "b",
      title: "[ENG-648] x",
    }),
    listReviews: async () => [
      {
        user: "a[bot]",
        submittedAt: "2099-01-01T00:00:00Z",
        state: "COMMENTED",
        commitId: "h2",
      },
    ],
    getChecks: async () => ({
      total: 1,
      pending: 0,
      failing: ci === "fail" ? 1 : 0,
      conclusion: ci,
    }),
    createPr: async () => prNumber,
  });

const buildSpawn: SpawnFn = async ({ role }) =>
  role === "implementer"
    ? { terminal_state: "done", verdict: "implemented", reason_code: "ok" }
    : { terminal_state: "done", verdict: "pass", reason_code: "ok" };
const okHelper: HelperFn = ({ name, runDir }) => ({
  exit: 0,
  summary: `${name} PASS`,
  logPath: join(runDir, `${name}.log`),
});

function opts(over: Partial<StartOptions> = {}): StartOptions {
  return {
    runDir: rd(),
    worktree: "/tmp/wt",
    repo: "ohcnetwork/care_fe",
    branch: "eng-648/x",
    task: "do the thing",
    ticket: "ENG-648",
    summary: "add the thing",
    prBody: "## Changes\n- thing",
    gh: convergingGh(),
    spawn: buildSpawn,
    helper: okHelper,
    push: () => ({ exit: 0, summary: "pushed", headSha: "h2" }),
    triage: async () => ({
      schema: "care-loop/skill-result@1",
      skill: "care-triager",
      round: 1,
      terminalState: "done",
      verdict: "clean",
      reasonCode: "triaged",
      payload: { addressCount: 0, declineCount: 0, deferCount: 0 },
    }),
    apply: async () => ({ terminalState: "done" }),
    gate: () => ({ exit: 0, summary: "gate ok" }),
    pushRound: () => ({ exit: 0, summary: "pushed", headSha: "h2" }),
    bots: BOTS,
    pollDeps: { now: () => 0, sleep: async () => {} },
    ...over,
  };
}

test("runStart: build → PR → CI converges end-to-end, lock released", async () => {
  const o = opts();
  const res = await runStart(o);
  assert.equal(res.phase, "ci");
  assert.equal(res.outcome, "converged");
  assert.equal(res.pr, 100);
  assert.equal(res.state.pr, 100);
  assert.equal(existsSync(join(o.runDir, ".orchestrator.lock")), false); // released
});

test("runStart: a failed build short-circuits before any PR", async () => {
  let createCalls = 0;
  const gh = makeFakeGitHub({ createPr: async () => (createCalls++, 1) });
  const helper: HelperFn = ({ name, runDir }) => ({
    exit: name === "setup-worktree" ? 1 : 0,
    summary: name,
    logPath: join(runDir, `${name}.log`),
  });
  const res = await runStart(opts({ gh, helper }));
  assert.equal(res.phase, "build");
  assert.equal(res.outcome, "aborted");
  assert.equal(res.pr, undefined);
  assert.equal(createCalls, 0); // never opened a PR
});

test("runStart: a push failure stops before opening the PR", async () => {
  let createCalls = 0;
  const gh = makeFakeGitHub({ createPr: async () => (createCalls++, 1) });
  const res = await runStart(
    opts({ gh, push: () => ({ exit: 1, summary: "push rejected" }) }),
  );
  assert.equal(res.phase, "push");
  assert.equal(res.outcome, "push-failed");
  assert.equal(createCalls, 0);
});

test("runStart: rejects a non-[ENG-###] ticket (IMP-12 title contract)", async () => {
  await assert.rejects(runStart(opts({ ticket: "648" })), /\[ENG-###\]/);
});

test("roleSpawn dispatches implementer + reviewer to the injected skills", async () => {
  const reviewer: Reviewer = async ({ diff }) => ({
    schema: "care-loop/skill-result@1",
    skill: "care-reviewer",
    round: 1,
    terminalState: "done",
    verdict: diff.includes("bug") ? "blocked" : "pass",
    reasonCode: "r",
    payload: { findings: [] },
  });
  const implementer: Implementer = async () => ({
    schema: "care-loop/skill-result@1",
    skill: "implementer",
    round: 1,
    terminalState: "done",
    verdict: "implemented",
    reasonCode: "i",
    payload: { filesChanged: [], staged: false, timedOut: false },
  });
  const spawn = roleSpawn({
    reviewer,
    implementer,
    worktree: "/tmp/wt",
    task: "t",
    diffOf: () => "clean diff",
  });

  const impl = await spawn({
    role: "implementer",
    step: "3",
    round: 1,
    runDir: "/tmp",
  });
  assert.equal(impl.terminal_state, "done");
  assert.equal(impl.verdict, "implemented");

  const rev = await spawn({
    role: "care-reviewer",
    step: "4a",
    round: 1,
    runDir: "/tmp",
  });
  assert.equal(rev.verdict, "pass"); // diffOf returned "clean diff"
});
