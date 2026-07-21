import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCiRounds,
  type CiRoundsOptions,
  type TriageResult,
  type CiFixFn,
} from "../src/ci-round.ts";
import { Journal } from "../src/journal.ts";
import { makeFakeGitHub } from "./fake-github.ts";
import type { CiConclusion } from "../src/github.ts";
import { renderFeedback } from "../src/feedback.ts";

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
    triage: async () => ({ addressCount: 0, declineCount: 0 }),
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
      ? { addressCount: 2, declineCount: 0 }
      : { addressCount: 0, declineCount: 0 };
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

test("decline items alone are non-blocking: addressCount=0 + declineCount=1 → converges", async () => {
  const res = await runCiRounds(
    opts({
      triage: async () => ({ addressCount: 0, declineCount: 1 }),
    }),
  );
  // decline items are informational; with no address items and CI green, the run converges
  assert.equal(res.outcome, "converged");
  assert.equal(res.state.step, "7");
});

test("never-clean triage is capped at maxRounds (bounded loop)", async () => {
  const res = await runCiRounds(
    opts({
      triage: async () => ({ addressCount: 1, declineCount: 0 }),
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
      triage: async () => ({ addressCount: 0, declineCount: 0 }),
    }),
  );
  assert.equal(res.outcome, "deferred");
});

test("Step 7: converged exit invokes the reply seam with the final round's items", async () => {
  const items = [
    { verdict: "decline" as const, reason: "outdated", threads: [11] },
    { verdict: "decline" as const, reason: "out of scope", threads: [12] },
  ];
  const seen: { pr: number; items: unknown[] }[] = [];
  const reply = async (i: {
    pr: number;
    round: number;
    runDir: string;
    items: unknown[];
  }) => {
    seen.push({ pr: i.pr, items: i.items });
    return { replied: 2, resolved: 2, skipped: 0 };
  };
  const res = await runCiRounds(
    opts({
      triage: async () => ({ addressCount: 0, declineCount: 2, items }),
      reply,
    }),
  );
  assert.equal(res.outcome, "converged");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pr, 1);
  assert.equal(seen[0].items.length, 2);

  const { events } = new Journal(
    join(res.state.worktree, "journal.jsonl"),
    "x",
  ).read();
  assert.ok(
    events.some(
      (e) =>
        e.step === "5-replying" &&
        /replied 2, resolved 2/.test(String((e.data as any)?.summary)),
    ),
    "a 5-replying helper.exec is journaled with the tallies",
  );
});

test("Step 7: a throwing reply seam is swallowed — the run still converges", async () => {
  const reply = async () => {
    throw new Error("copilot flaked");
  };
  const res = await runCiRounds(
    opts({
      triage: async () => ({
        addressCount: 0,
        declineCount: 1,
        items: [{ verdict: "decline" as const, reason: "x", threads: [1] }],
      }),
      reply,
    }),
  );
  assert.equal(res.outcome, "converged");
});

test("Step 7: address round replies AFTER the push (step 5), not before", async () => {
  let call = 0;
  const triage = async (): Promise<TriageResult> => {
    call++;
    return call === 1
      ? {
          addressCount: 1,
          declineCount: 0,
          items: [{ verdict: "address" as const, reason: "fix", threads: [1] }],
        }
      : { addressCount: 0, declineCount: 0, items: [] };
  };
  const order: string[] = [];
  const res = await runCiRounds(
    opts({
      triage,
      push: () => {
        order.push("push");
        return { exit: 0, summary: "pushed", headSha: "h2" };
      },
      reply: async () => {
        order.push("reply");
        return { replied: 1, resolved: 1, skipped: 0 };
      },
    }),
  );
  assert.equal(res.outcome, "converged");
  assert.deepEqual(
    order,
    ["push", "reply"],
    "the round's fix is pushed before its threads are replied",
  );
});

// ── Re-address prevention ────────────────────────────────────────────────────────────────────────

test("addressed threads are tagged [addressed round N] in the next round's feedback — implementer is NOT re-called for them", async () => {
  // Round 1: triage returns 1 address item with thread 42. Round 2: triage returns 0.
  // The important thing is that addressed-threads.json is written after round 1, so round 2's
  // collectFeedback would annotate thread 42 as "[addressed round 1]". We verify this by checking
  // the file is present with the right content.
  let triageRound = 0;
  let applyCallCount = 0;
  const triage = async (): Promise<TriageResult> => {
    triageRound++;
    return triageRound === 1
      ? {
          addressCount: 1,
          declineCount: 0,
          items: [
            { verdict: "address" as const, reason: "fix this", threads: [42] },
          ],
        }
      : { addressCount: 0, declineCount: 0, items: [] };
  };
  const apply = async () => {
    applyCallCount++;
    return { terminalState: "done" as const };
  };
  const runDir = rd();
  const res = await runCiRounds(opts({ triage, apply, runDir }));
  assert.equal(res.outcome, "converged");
  assert.equal(
    applyCallCount,
    1,
    "implementer called exactly once (round 1 only)",
  );
  // addressed-threads.json must record thread 42 from round 1.
  const at = JSON.parse(
    readFileSync(join(runDir, "addressed-threads.json"), "utf8"),
  ) as { threadId: number; round: number }[];
  assert.equal(at.length, 1);
  assert.equal(at[0].threadId, 42);
  assert.equal(at[0].round, 1);
});

test("re-surfaced thread tagged [addressed round N] causes triager to receive the tag — no second apply cycle", async () => {
  // Simulate: round 1 addresses thread 42, round 2 the same thread re-appears as a bot comment.
  // We verify the feedback rendered for round 2 carries "[addressed round 1]" on that thread.
  const { markdown } = renderFeedback({
    pr: 1,
    reviewComments: [
      {
        user: "coderabbit[bot]",
        createdAt: "2026-07-16T00:00:00Z",
        updatedAt: "2026-07-16T00:00:00Z",
        body: "Fix this please",
        id: 42,
        path: "src/foo.ts",
        line: 10,
      },
    ],
    issueComments: [],
    resolvedIds: [],
    addressedThreads: [{ threadId: 42, round: 1 }],
  });
  assert.match(
    markdown,
    /\[addressed round 1\]/,
    "thread 42 is tagged with [addressed round 1]",
  );
  // The raw bot body is still present so the triager has context to verify the fix.
  assert.match(markdown, /Fix this please/);
});

// ── Bot-track / CI-track full loop ───────────────────────────────────────────────────────────────

test("bot-track priority: CI red + bot comments → bot fix first, CI re-checked next round", async () => {
  // Round 1: CI fail + 1 address item → bot track runs (NOT ci-fix), fix commits, round 2 CI passes.
  let triageCall = 0;
  let ciFixCalled = false;
  let applyCall = 0;
  let pushCall = 0;
  const triage = async (): Promise<TriageResult> => {
    triageCall++;
    return triageCall === 1
      ? { addressCount: 1, declineCount: 0 }
      : { addressCount: 0, declineCount: 0 };
  };
  const apply = async () => {
    applyCall++;
    return { terminalState: "done" as const };
  };
  const ciFix: CiFixFn = async () => {
    ciFixCalled = true;
    return { outcome: "fixed" };
  };
  // Make CI depend on push count: before first push → fail; after → pass.
  const gh = makeFakeGitHub({
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
    getChecks: async () => {
      const failing = pushCall < 1 ? 1 : 0;
      return {
        total: 1,
        pending: 0,
        failing,
        conclusion: failing ? "fail" : "pass",
      };
    },
  });
  const res = await runCiRounds(
    opts({
      gh,
      triage,
      apply,
      ciFix,
      push: () => {
        pushCall++;
        return { exit: 0, summary: "pushed", headSha: "h2" };
      },
    }),
  );
  assert.equal(res.outcome, "converged");
  assert.equal(applyCall, 1, "bot apply ran once");
  assert.equal(
    ciFixCalled,
    false,
    "CI-fixer was NOT invoked (bot track had priority)",
  );
});

test("CI-fix residual: bots clean + CI red → ci-fixer runs, commits, loop → CI pass → converged", async () => {
  let ciFixCall = 0;
  let pushCall = 0;
  const triage = async (): Promise<TriageResult> => ({
    addressCount: 0,
    declineCount: 0,
  });
  const ciFix: CiFixFn = async () => {
    ciFixCall++;
    return { outcome: "fixed" };
  };
  // CI red until first push (ci-fixer commit), then pass.
  const gh = makeFakeGitHub({
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
    getChecks: async () => {
      const failing = pushCall < 1 ? 1 : 0;
      return {
        total: 1,
        pending: 0,
        failing,
        conclusion: failing ? "fail" : "pass",
      };
    },
  });
  const res = await runCiRounds(
    opts({
      gh,
      triage,
      ciFix,
      push: () => {
        pushCall++;
        return { exit: 0, summary: "pushed", headSha: "h2" };
      },
    }),
  );
  assert.equal(res.outcome, "converged");
  assert.equal(ciFixCall, 1, "ci-fixer ran once");
});

test("§3 guard: ci-fixer edits a spec + 4b flags it wrong → deferred ci_fix_spec_wrong, NOT pushed", async () => {
  let pushCall = 0;
  let commentPosted = false;
  let gradeCall = 0;
  const gh = makeFakeGitHub({
    ...convergingGh("fail"),
    createComment: async () => {
      commentPosted = true;
    },
  });
  const res = await runCiRounds(
    opts({
      gh,
      triage: async () => ({ addressCount: 0, declineCount: 0 }),
      ciFix: async () => ({
        outcome: "fixed",
        filesChanged: ["tests/patient/patientRegistration.spec.ts"],
      }),
      testGrade: async () => {
        gradeCall++;
        return { blocking: true, summary: "AC1 — asserts the wrong value" };
      },
      push: () => {
        pushCall++;
        return { exit: 0, summary: "pushed", headSha: "h2" };
      },
    }),
  );
  assert.equal(res.outcome, "deferred");
  assert.equal(gradeCall, 1, "the 4b guard ran once");
  assert.equal(pushCall, 0, "the green-but-wrong spec edit was NOT pushed");
  assert.equal(commentPosted, true, "human-facing PR comment was posted");
  const { events } = new Journal(
    join(res.state.worktree, "journal.jsonl"),
    "x",
  ).read();
  const checkpoint = events.find((e) => e.event === "checkpoint.written");
  assert.equal((checkpoint!.data as any)?.reason_code, "ci_fix_spec_wrong");
});

test("§3 guard: ci-fixer edits a spec + 4b passes → proceeds to push → converges", async () => {
  let pushCall = 0;
  let gradeCall = 0;
  const gh = makeFakeGitHub({
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
    getChecks: async () => {
      const failing = pushCall < 1 ? 1 : 0;
      return {
        total: 1,
        pending: 0,
        failing,
        conclusion: failing ? "fail" : "pass",
      };
    },
  });
  const res = await runCiRounds(
    opts({
      gh,
      triage: async () => ({ addressCount: 0, declineCount: 0 }),
      ciFix: async () => ({
        outcome: "fixed",
        filesChanged: ["tests/patient/patientRegistration.spec.ts"],
      }),
      testGrade: async () => {
        gradeCall++;
        return { blocking: false };
      },
      push: () => {
        pushCall++;
        return { exit: 0, summary: "pushed", headSha: "h2" };
      },
    }),
  );
  assert.equal(res.outcome, "converged");
  assert.equal(gradeCall, 1, "the 4b guard ran once and passed");
  assert.equal(pushCall, 1, "the sound spec edit was pushed");
});

test("§3 guard: source-only ci-fix (no spec touched) → guard is SKIPPED", async () => {
  let pushCall = 0;
  let gradeCall = 0;
  const gh = makeFakeGitHub({
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
    getChecks: async () => {
      const failing = pushCall < 1 ? 1 : 0;
      return {
        total: 1,
        pending: 0,
        failing,
        conclusion: failing ? "fail" : "pass",
      };
    },
  });
  const res = await runCiRounds(
    opts({
      gh,
      triage: async () => ({ addressCount: 0, declineCount: 0 }),
      ciFix: async () => ({
        outcome: "fixed",
        filesChanged: ["src/Utils/utils.ts"], // source fix, no spec
      }),
      testGrade: async () => {
        gradeCall++;
        return { blocking: true }; // would block, but must not be consulted
      },
      push: () => {
        pushCall++;
        return { exit: 0, summary: "pushed", headSha: "h2" };
      },
    }),
  );
  assert.equal(res.outcome, "converged");
  assert.equal(gradeCall, 0, "guard skipped when no spec was touched");
  assert.equal(pushCall, 1, "source fix pushed normally");
});

test("CI-fix handoff (no ciFix injected) + bots clean → deferred ci_red_human + PR comment posted", async () => {
  let commentPosted = false;
  const gh = makeFakeGitHub({
    ...convergingGh("fail"),
    createComment: async () => {
      commentPosted = true;
    },
  });
  const res = await runCiRounds(
    opts({
      gh,
      triage: async () => ({ addressCount: 0, declineCount: 0 }),
      // no ciFix → humanHandoff path
    }),
  );
  assert.equal(res.outcome, "deferred");
  // Doctor reads reason_code from the checkpoint event.
  const { events } = new Journal(
    join(res.state.worktree, "journal.jsonl"),
    "x",
  ).read();
  const checkpoint = events.find((e) => e.event === "checkpoint.written");
  assert.ok(checkpoint, "checkpoint.written event present");
  assert.equal((checkpoint!.data as any)?.reason_code, "ci_red_human");
  assert.equal(commentPosted, true, "human-facing PR comment was posted");
});

test("step 7 is reached once BOTH bots clean + CI green (multi-round scenario)", async () => {
  // Round 1: bots have 1 address + CI red → bot track.
  // Round 2: bots clean + CI still red → ci-fix track → ci-fixer commits → push.
  // Round 3: bots clean + CI green → converged at step 7.
  let triageCall = 0;
  let ciFixCall = 0;
  let pushCall = 0;
  const triage = async (): Promise<TriageResult> => {
    triageCall++;
    return triageCall === 1
      ? { addressCount: 1, declineCount: 0 }
      : { addressCount: 0, declineCount: 0 };
  };
  const ciFix: CiFixFn = async () => {
    ciFixCall++;
    return { outcome: "fixed" };
  };
  // CI red for the first 2 rounds (i.e., until ci-fixer's push = 2nd push), green after.
  const gh = makeFakeGitHub({
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
    getChecks: async () => {
      const failing = pushCall < 2 ? 1 : 0;
      return {
        total: 1,
        pending: 0,
        failing,
        conclusion: failing ? "fail" : "pass",
      };
    },
  });
  const res = await runCiRounds(
    opts({
      gh,
      triage,
      apply: async () => ({ terminalState: "done" as const }),
      ciFix,
      push: () => {
        pushCall++;
        return { exit: 0, summary: "pushed", headSha: "h2" };
      },
    }),
  );
  assert.equal(res.outcome, "converged");
  assert.equal(res.state.step, "7");
  assert.equal(ciFixCall, 1, "ci-fixer ran once (round 2 residual)");
});

// ── Not-fixable paths → step 7 + marked ─────────────────────────────────────────────────────────

test("apply exhausted (genuine failures) → capped, NOT step 7", async () => {
  // maxImplementRetries=2: first two apply calls fail, then abort.
  const res = await runCiRounds(
    opts({
      triage: async () => ({ addressCount: 1, declineCount: 0 }),
      apply: async () => ({ terminalState: "failed" as const }),
      cfg: { maxRounds: 5 },
    }),
  );
  assert.equal(res.outcome, "capped");
  const { events } = new Journal(
    join(res.state.worktree, "journal.jsonl"),
    "x",
  ).read();
  assert.ok(
    events.some(
      (e) =>
        e.event === "step.exit" &&
        /apply_exhausted/.test(String((e.data as any)?.reason_code)),
    ),
    "apply_exhausted reason_code journaled",
  );
});

test("ci-fixer handoff with bots clean → deferred ci_red_human (not step 7 / not capped)", async () => {
  const ciFix: CiFixFn = async () => ({ outcome: "handoff" });
  const res = await runCiRounds(
    opts({
      gh: convergingGh("fail"),
      triage: async () => ({ addressCount: 0, declineCount: 0 }),
      ciFix,
    }),
  );
  assert.equal(res.outcome, "deferred");
  const { events } = new Journal(
    join(res.state.worktree, "journal.jsonl"),
    "x",
  ).read();
  assert.ok(
    events.some(
      (e) =>
        e.event === "checkpoint.written" &&
        (e.data as any)?.reason_code === "ci_red_human",
    ),
  );
});

test("noop apply (items already fixed) + CI green → converged, NOT capped/aborted", async () => {
  // Simulates: triage flags an item but the fix was already applied by a prior commit.
  const res = await runCiRounds(
    opts({
      triage: async () => ({ addressCount: 1, declineCount: 0 }),
      apply: async () => ({ terminalState: "noop" as const }),
    }),
  );
  assert.equal(res.outcome, "converged");
});

test("noop apply + CI red → deferred ci_red_human, not capped", async () => {
  const res = await runCiRounds(
    opts({
      gh: convergingGh("fail"),
      triage: async () => ({ addressCount: 1, declineCount: 0 }),
      apply: async () => ({ terminalState: "noop" as const }),
    }),
  );
  assert.equal(res.outcome, "deferred");
  const { events } = new Journal(
    join(res.state.worktree, "journal.jsonl"),
    "x",
  ).read();
  assert.ok(
    events.some(
      (e) =>
        e.event === "checkpoint.written" &&
        (e.data as any)?.reason_code === "ci_red_human",
    ),
  );
});

test("gate-loopback: gate fail → re-apply with gate errors → gate passes → push → converge", async () => {
  let gateCall = 0;
  let applyFindings: string[] = [];
  let triageCall = 0;
  const res = await runCiRounds(
    opts({
      triage: async (): Promise<TriageResult> => {
        triageCall++;
        // Only flag address items on the first triage call; converge on the second.
        return triageCall === 1
          ? { addressCount: 1, declineCount: 0 }
          : { addressCount: 0, declineCount: 0 };
      },
      apply: async ({ findings }) => {
        if (findings) applyFindings.push(findings);
        return { terminalState: "done" as const };
      },
      gate: () => {
        gateCall++;
        // First gate call (normal) fails. Second call (loopback retry) passes.
        return gateCall === 1
          ? { exit: 1, summary: "TS error: Cannot find name 'foo'" }
          : { exit: 0, summary: "run_gate: ALL PASSED" };
      },
    }),
  );
  assert.equal(res.outcome, "converged");
  assert.equal(
    applyFindings.length,
    1,
    "re-apply received gate-error findings once",
  );
  assert.match(
    applyFindings[0],
    /Cannot find name 'foo'/,
    "gate error text forwarded to re-apply",
  );
});

test("gate-loopback exhausted → gate-blocked (not capped)", async () => {
  // Gate always fails; after maxImplementRetries re-applies → gate-blocked.
  const res = await runCiRounds(
    opts({
      triage: async () => ({ addressCount: 1, declineCount: 0 }),
      apply: async () => ({ terminalState: "done" as const }),
      gate: () => ({ exit: 1, summary: "FAIL: type error" }),
    }),
  );
  assert.equal(res.outcome, "gate-blocked");
});

// ── Decline re-surfacing: LLM context ───────────────────────────────────────────────────────────

test("declined thread re-surfaced by a bot carries [addressed round N] tag in next-round feedback", async () => {
  // The mechanism: ci-round writes addressed-threads.json when it marks items for address.
  // On the next round, collectFeedback reads that file and passes addressedThreads to renderFeedback,
  // which tags the thread. The triager then sees "[addressed round 1]" and can decline re-litigating.
  // We test the renderFeedback layer directly (the integration point is collectFeedback → renderFeedback).
  const { markdown } = renderFeedback({
    pr: 5,
    reviewComments: [
      // Thread 99 was declined in round 1; the bot re-commented (same thread, new comment).
      {
        user: "coderabbit[bot]",
        createdAt: "2026-07-16T01:00:00Z",
        updatedAt: "2026-07-16T01:00:00Z",
        body: "Still think this needs a null check",
        id: 99,
        path: "src/bar.tsx",
        line: 20,
      },
    ],
    issueComments: [],
    resolvedIds: [],
    // Simulate: this thread was triaged "address" in round 1 (the loop writes this entry).
    addressedThreads: [{ threadId: 99, round: 1 }],
  });
  // The tag must appear so the triager has the prior-round signal.
  assert.match(
    markdown,
    /\[addressed round 1\]/,
    "thread 99 carries the addressed tag",
  );
  // The bot's new comment body is still present — the triager needs context to verify the fix.
  assert.match(markdown, /null check/);
  // The triager's system prompt already instructs it: "if the fix is there, verdict it `decline`".
  // We cannot test the LLM's decision, but we CAN assert the CONTEXT it receives is correct.
  // The tag is the lever; the model handles the judgment.
});

test("ci-fix track: the mocked CI failure (with extracted job-log detail) reaches the fixer intact", async () => {
  // The whole point of getCheckFailureContext: the fixer must receive the REAL failure — the failing
  // spec + expected-vs-received from the Actions job log — not just "shard N failed" runner noise.
  // Mock a red CI whose getCheckFailureContext yields a log-bearing failure and capture what the
  // fixer is handed. Bots are clean, so the loop takes the CI-fix residual track in 6b.
  const failure = {
    name: "Test (1/4)",
    summary: "Process completed with exit code 1.",
    annotations: [
      { path: "shard-1", line: 0, message: "shard 1 failed" }, // runner noise
    ],
    log: [
      "1) [chromium] › tests/facility/patient/patientRegistration.spec.ts:352:5 › registers a patient",
      "   Error: expect(locator).toHaveText(expected)",
      '   Expected string: "25 Y"',
      '   Received string: "25y"',
    ].join("\n"),
  };
  let gotFailures: import("../src/skill-result.ts").CiFailure[] | undefined;
  const gh = makeFakeGitHub({
    ...convergingGh("fail"),
    getCheckFailureContext: async () => [failure],
  });
  const ciFix: CiFixFn = async ({ ciFailures }) => {
    gotFailures = ciFailures;
    return { outcome: "handoff" }; // stop after one pass; we only care about the input
  };
  const res = await runCiRounds(
    opts({
      gh,
      triage: async () => ({ addressCount: 0, declineCount: 0 }),
      ciFix,
    }),
  );
  assert.equal(res.outcome, "deferred"); // handoff with bots clean → ci_red_human checkpoint
  assert.ok(gotFailures, "the ci-fixer was invoked with the CI failure context");
  assert.equal(gotFailures!.length, 1);
  assert.equal(gotFailures![0].name, "Test (1/4)");
  // The extracted job-log detail — the assertion the fixer actually reasons over — survives the hop.
  assert.match(gotFailures![0].log ?? "", /patientRegistration\.spec\.ts:352/);
  assert.match(gotFailures![0].log ?? "", /Received string: "25y"/);
});

test("ci-fix track: getCheckFailureContext throwing degrades to an empty context, not a crash", async () => {
  // Best-effort contract: if the enriched-context fetch throws, the fixer still runs (with []),
  // rather than the loop blowing up. Proves the try/catch around getCheckFailureContext holds.
  let invoked = false;
  const gh = makeFakeGitHub({
    ...convergingGh("fail"),
    getCheckFailureContext: async () => {
      throw new Error("gh API 500");
    },
  });
  const ciFix: CiFixFn = async ({ ciFailures }) => {
    invoked = true;
    assert.deepEqual(ciFailures, []);
    return { outcome: "handoff" };
  };
  const res = await runCiRounds(
    opts({
      gh,
      triage: async () => ({ addressCount: 0, declineCount: 0 }),
      ciFix,
    }),
  );
  assert.equal(invoked, true, "fixer still runs despite the context fetch throwing");
  assert.equal(res.outcome, "deferred");
});
