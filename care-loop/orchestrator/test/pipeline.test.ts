import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runHalfPipe,
  type SpawnFn,
  type HelperFn,
  type SpawnResult,
} from "../src/pipeline.ts";
import { Journal } from "../src/journal.ts";

function runDir(): string {
  return mkdtempSync(join(tmpdir(), "careloopd-pipe-"));
}

const base = (dir: string) => ({
  runDir: dir,
  worktree: "/tmp/wt-scratch",
  task: "half-pipe scratch run",
  repo: "ohcnetwork/care_fe",
  branch: "scratch/phase3",
});

const okSpawn =
  (verdicts: Partial<Record<string, SpawnResult>> = {}): SpawnFn =>
  async ({ role }) =>
    verdicts[role] ?? {
      terminal_state: "done",
      verdict: role === "implementer" ? "implemented" : "pass",
      reason_code: "ok",
    };

const okHelper =
  (): HelperFn =>
  ({ name, runDir: dir }) => ({
    exit: 0,
    summary: `${name} PASS`,
    logPath: join(dir, `${name}.log`),
  });

test("happy path drives 2→3→4a→5 and completes", async () => {
  const dir = runDir();
  const res = await runHalfPipe({
    ...base(dir),
    spawn: okSpawn(),
    helper: okHelper(),
  });

  assert.deepEqual(res.visited, ["2", "3", "4a", "5"]);
  assert.equal(res.outcome, "complete");
  assert.equal(res.state.step, "5");

  // journal is intact and state.json + loop.log were rendered
  const { events, truncatedTail } = new Journal(
    join(dir, "journal.jsonl"),
    "x",
  ).read();
  assert.equal(truncatedTail, false);
  assert.ok(events.length > 0);
  assert.ok(existsSync(join(dir, "state.json")));
  const log = readFileSync(join(dir, "loop.log"), "utf8");
  assert.match(log, /→ step 3/);
  assert.match(log, /care-reviewer → pass/);
});

test("resumeFrom re-enters the build at the interrupted step (no setup/implement re-run), completing 4a→5", async () => {
  const dir = runDir();
  // Seed a journal as if plan + steps 2/3 already ran and the run crashed entering 4a.
  const seedJ = new Journal(
    join(dir, "journal.jsonl"),
    "ohcnetwork-care_fe-scratch/phase3",
  );
  seedJ.append({
    event: "run.start",
    step: "1",
    round: 1,
    data: {
      state: {
        task: "half-pipe scratch run",
        repo: "ohcnetwork/care_fe",
        branch: "scratch/phase3",
        worktree: "/tmp/wt-scratch",
        tier: "standard",
        pr: null,
        round: 1,
        step: "1",
        head_sha: "scratch",
        last_reviewed_sha: "",
        updated_at: new Date().toISOString(),
      },
    },
  });
  seedJ.append({
    event: "plan.approved",
    step: "1",
    round: 1,
    data: { classification: "standard", state: { tier: "standard" } },
  });

  const visitedSetup: string[] = [];
  const helper: HelperFn = ({ name, runDir: d }) => {
    visitedSetup.push(name);
    return {
      exit: 0,
      summary: `${name} PASS`,
      logPath: join(d, `${name}.log`),
    };
  };
  let implementCalls = 0;
  const spawn: SpawnFn = async ({ role }) => {
    if (role === "implementer") implementCalls++;
    return {
      terminal_state: "done",
      verdict: role === "implementer" ? "implemented" : "pass",
      reason_code: "ok",
    };
  };

  const res = await runHalfPipe({
    ...base(dir),
    spawn,
    helper,
    resumeFrom: "4a",
  });

  assert.equal(res.outcome, "complete");
  // Re-entered at 4a — setup-worktree and implement did NOT run again; only the review + gate did.
  assert.deepEqual(res.visited, ["4a", "5"]);
  assert.equal(implementCalls, 0);
  assert.ok(!visitedSetup.includes("setup-worktree"));
  // A run.resume event marks the re-entry.
  const { events } = new Journal(join(dir, "journal.jsonl"), "x").read();
  assert.ok(events.some((e) => e.event === "run.resume"));
});

test("resumeFrom rejects a non-build step", async () => {
  const dir = runDir();
  new Journal(join(dir, "journal.jsonl"), "x").append({
    event: "run.start",
    step: "1",
    round: 1,
    data: {
      state: {
        task: "t",
        repo: "ohcnetwork/care_fe",
        branch: "b",
        worktree: "/tmp/wt",
        tier: "standard",
        pr: null,
        round: 1,
        step: "1",
        head_sha: "scratch",
        last_reviewed_sha: "",
        updated_at: new Date().toISOString(),
      },
    },
  });
  await assert.rejects(
    () =>
      runHalfPipe({
        ...base(dir),
        spawn: okSpawn(),
        helper: okHelper(),
        resumeFrom: "6a" as never,
      }),
    /resumeFrom must be a build step/,
  );
});

test("reviewer loopback re-enters implement: 2→3→4a→3→4a→5", async () => {
  const dir = runDir();
  let reviewCalls = 0;
  const spawn: SpawnFn = async ({ role }) => {
    if (role === "care-reviewer") {
      reviewCalls++;
      return reviewCalls === 1
        ? {
            terminal_state: "done",
            verdict: "blocked",
            reason_code: "prop_contract_break",
          }
        : { terminal_state: "done", verdict: "pass", reason_code: "clean" };
    }
    return {
      terminal_state: "done",
      verdict: "implemented",
      reason_code: "ok",
    };
  };

  const res = await runHalfPipe({ ...base(dir), spawn, helper: okHelper() });
  assert.deepEqual(res.visited, ["2", "3", "4a", "3", "4a", "5"]);
  assert.equal(res.outcome, "complete");
});

test("test-grade gate (4b) loops back on 'wrong' and feeds findings to the re-implement", async () => {
  // BS-2 (HARNESS-COVERAGE.md): with 4b enabled, a `wrong` verdict must (a) loop back to implement
  // and (b) carry the grader's findings as re-implement context — else the maker re-implements blind.
  const dir = runDir();
  let gradeCalls = 0;
  const implContexts: (string | undefined)[] = [];
  const spawn: SpawnFn = async ({ role, context }) => {
    if (role === "implementer") {
      implContexts.push(context);
      return {
        terminal_state: "done",
        verdict: "implemented",
        reason_code: "ok",
      };
    }
    if (role === "care-test-grader") {
      gradeCalls++;
      return gradeCalls === 1
        ? {
            terminal_state: "done",
            verdict: "wrong",
            reason_code: "graded",
            findingsDigest:
              "- [Wrong/Critical] AC3: spec asserts the wrong total (fix: assert net-of-discount)",
          }
        : { terminal_state: "done", verdict: "pass", reason_code: "graded" };
    }
    return { terminal_state: "done", verdict: "pass", reason_code: "ok" };
  };

  const res = await runHalfPipe({
    ...base(dir),
    spawn,
    helper: okHelper(),
    cfg: { reviewSteps: ["4a", "4b"], maxImplementRetries: 2 },
  });

  assert.deepEqual(res.visited, ["2", "3", "4a", "4b", "3", "4a", "4b", "5"]);
  assert.equal(res.outcome, "complete");
  // first implement had no findings; the loopback re-implement received the grader's digest
  assert.equal(implContexts[0], undefined);
  assert.match(implContexts[1] ?? "", /care-test-grader/);
  assert.match(implContexts[1] ?? "", /assert net-of-discount/);
});

test("inner-gate failure retries implement: 2→3→3→4a→5", async () => {
  const dir = runDir();
  let innerGate = 0;
  const helper: HelperFn = ({ name, runDir: d }) => {
    if (name === "gate-inner") {
      innerGate++;
      return {
        exit: innerGate === 1 ? 1 : 0,
        summary: `gate-inner ${innerGate === 1 ? "FAIL" : "PASS"}`,
        logPath: join(d, "gi.log"),
      };
    }
    return {
      exit: 0,
      summary: `${name} PASS`,
      logPath: join(d, `${name}.log`),
    };
  };

  const res = await runHalfPipe({ ...base(dir), spawn: okSpawn(), helper });
  assert.deepEqual(res.visited, ["2", "3", "3", "4a", "5"]);
  assert.equal(res.outcome, "complete");
});

test("setup helper failure aborts at step 2", async () => {
  const dir = runDir();
  const helper: HelperFn = ({ name, runDir: d }) => ({
    exit: name === "setup-worktree" ? 2 : 0,
    summary: `${name} ${name === "setup-worktree" ? "FAIL" : "PASS"}`,
    logPath: join(d, `${name}.log`),
  });

  const res = await runHalfPipe({ ...base(dir), spawn: okSpawn(), helper });
  assert.deepEqual(res.visited, ["2"]);
  assert.equal(res.outcome, "aborted");
  assert.equal(res.state.step, "aborted");
});

test("implement exhaustion aborts after maxImplementRetries", async () => {
  const dir = runDir();
  // inner gate always fails → implement keeps retrying until the cap, then abort
  const helper: HelperFn = ({ name, runDir: d }) => ({
    exit: name === "gate-inner" ? 1 : 0,
    summary: `${name}`,
    logPath: join(d, `${name}.log`),
  });

  const res = await runHalfPipe({
    ...base(dir),
    spawn: okSpawn(),
    helper,
    cfg: { reviewSteps: ["4a"], maxImplementRetries: 2 },
  });
  assert.deepEqual(res.visited, ["2", "3", "3"]);
  assert.equal(res.outcome, "aborted");
});

test("a maker timeout uses its OWN budget, not the genuine-retry budget", async () => {
  const dir = runDir();
  let n = 0;
  const spawn: SpawnFn = async ({ role }) => {
    if (role !== "implementer")
      return { terminal_state: "done", verdict: "pass", reason_code: "ok" };
    n++;
    return n <= 2
      ? {
          terminal_state: "failed",
          verdict: "failed",
          reason_code: "timeout",
          timedOut: true,
        }
      : { terminal_state: "done", verdict: "implemented", reason_code: "ok" };
  };
  // maxImplementRetries=1 (a single genuine failure would abort) — yet 2 timeouts then success completes
  const res = await runHalfPipe({
    ...base(dir),
    spawn,
    helper: okHelper(),
    cfg: {
      reviewSteps: ["4a"],
      maxImplementRetries: 1,
      maxImplementTimeouts: 2,
    },
  });
  assert.deepEqual(res.visited, ["2", "3", "3", "3", "4a", "5"]);
  assert.equal(res.outcome, "complete");
});

test("maker timeouts are bounded — escalate after maxImplementTimeouts", async () => {
  const dir = runDir();
  const spawn: SpawnFn = async ({ role }) =>
    role === "implementer"
      ? {
          terminal_state: "failed",
          verdict: "failed",
          reason_code: "timeout",
          timedOut: true,
        }
      : { terminal_state: "done", verdict: "pass", reason_code: "ok" };
  const res = await runHalfPipe({
    ...base(dir),
    spawn,
    helper: okHelper(),
    cfg: {
      reviewSteps: ["4a"],
      maxImplementRetries: 2,
      maxImplementTimeouts: 2,
    },
  });
  assert.deepEqual(res.visited, ["2", "3", "3", "3"]); // 3 timeouts → escalate
  assert.equal(res.outcome, "aborted");
});

test("a gate failure is fed back to the re-implement as context", async () => {
  const dir = runDir();
  const contexts: (string | undefined)[] = [];
  const spawn: SpawnFn = async ({ role, context }) => {
    if (role !== "implementer")
      return { terminal_state: "done", verdict: "pass", reason_code: "ok" };
    contexts.push(context);
    return {
      terminal_state: "done",
      verdict: "implemented",
      reason_code: "ok",
    };
  };
  let gate = 0;
  const helper: HelperFn = ({ name, runDir: d }) => {
    if (name === "gate-inner") {
      gate++;
      return {
        exit: gate === 1 ? 1 : 0,
        summary: gate === 1 ? "tsc FAIL: TS2307 supportedBrowsers" : "PASS",
        logPath: join(d, "g.log"),
      };
    }
    return { exit: 0, summary: name, logPath: join(d, `${name}.log`) };
  };
  const res = await runHalfPipe({ ...base(dir), spawn, helper });
  assert.equal(res.outcome, "complete");
  assert.equal(contexts[0], undefined); // first implement has no prior context
  assert.match(contexts[1] ?? "", /tsc FAIL: TS2307/); // second implement got the gate error
});

test("seeds run.start only when the journal is empty (plan → start continuity)", async () => {
  const dir = runDir();
  // Simulate the `plan` stage having already seeded this shared journal at step 1.
  const runId = "ohcnetwork-care_fe-scratch/phase3";
  const pre = new Journal(join(dir, "journal.jsonl"), runId);
  pre.append({
    event: "run.start",
    step: "1",
    round: 1,
    data: {
      state: {
        task: "t",
        repo: "ohcnetwork/care_fe",
        branch: "scratch/phase3",
        worktree: "/tmp/wt",
        tier: "standard",
        pr: null,
        round: 1,
        step: "1",
        head_sha: "scratch",
        last_reviewed_sha: "",
        updated_at: new Date().toISOString(),
      },
    },
  });
  pre.append({
    event: "plan.approved",
    step: "1",
    round: 1,
    data: {
      planned_by: "Opus 4.8",
      classification: "standard",
      push_authorized: true,
    },
  });

  const res = await runHalfPipe({
    ...base(dir),
    spawn: okSpawn(),
    helper: okHelper(),
  });
  assert.equal(res.outcome, "complete");

  const { events } = new Journal(join(dir, "journal.jsonl"), runId).read();
  // exactly ONE run.start (plan's) — the pipeline did NOT re-seed and fork the projection
  assert.equal(events.filter((e) => e.event === "run.start").length, 1);
  // the pre-existing approval survived, and the pipeline continued the same chain into step 2
  assert.ok(events.some((e) => e.event === "plan.approved"));
  assert.ok(events.some((e) => e.event === "step.enter" && e.step === "2"));
});

test("full [4a,4b,4c] profile: happy path 2→3→4a→4b→4c→5", async () => {
  const dir = runDir();
  const res = await runHalfPipe({
    ...base(dir),
    spawn: okSpawn(),
    helper: okHelper(),
    cfg: { reviewSteps: ["4a", "4b", "4c"], maxImplementRetries: 2 },
  });
  assert.deepEqual(res.visited, ["2", "3", "4a", "4b", "4c", "5"]);
  assert.equal(res.outcome, "complete");
});

test("4b 'wrong' loopbacks to 3, re-implement then restarts review chain: 2→3→4a→4b→3→4a→4b→4c→5", async () => {
  const dir = runDir();
  let gradeCalls = 0;
  const spawn: SpawnFn = async ({ role }) => {
    if (role === "care-test-grader") {
      gradeCalls++;
      return gradeCalls === 1
        ? {
            terminal_state: "done",
            verdict: "wrong",
            reason_code: "spec_wrong",
          }
        : { terminal_state: "done", verdict: "pass", reason_code: "ok" };
    }
    return {
      terminal_state: "done",
      verdict: role === "implementer" ? "implemented" : "pass",
      reason_code: "ok",
    };
  };
  const res = await runHalfPipe({
    ...base(dir),
    spawn,
    helper: okHelper(),
    cfg: { reviewSteps: ["4a", "4b", "4c"], maxImplementRetries: 2 },
  });
  assert.deepEqual(res.visited, [
    "2",
    "3",
    "4a",
    "4b",
    "3",
    "4a",
    "4b",
    "4c",
    "5",
  ]);
  assert.equal(res.outcome, "complete");
});

test("4c 'overflow' loopbacks to 3, re-implement then restarts review chain: 2→3→4a→4b→4c→3→4a→4b→4c→5", async () => {
  const dir = runDir();
  let uxCalls = 0;
  const spawn: SpawnFn = async ({ role }) => {
    if (role === "care-ux-validator") {
      uxCalls++;
      return uxCalls === 1
        ? {
            terminal_state: "done",
            verdict: "overflow",
            reason_code: "layout_broken",
          }
        : { terminal_state: "done", verdict: "pass", reason_code: "ok" };
    }
    return {
      terminal_state: "done",
      verdict: role === "implementer" ? "implemented" : "pass",
      reason_code: "ok",
    };
  };
  const res = await runHalfPipe({
    ...base(dir),
    spawn,
    helper: okHelper(),
    cfg: { reviewSteps: ["4a", "4b", "4c"], maxImplementRetries: 2 },
  });
  assert.deepEqual(res.visited, [
    "2",
    "3",
    "4a",
    "4b",
    "4c",
    "3",
    "4a",
    "4b",
    "4c",
    "5",
  ]);
  assert.equal(res.outcome, "complete");
});

test("4b 'advisory' is non-blocking: advances straight through to 4c", async () => {
  const dir = runDir();
  const spawn: SpawnFn = async ({ role }) => ({
    terminal_state: "done",
    verdict:
      role === "care-test-grader"
        ? "advisory"
        : role === "implementer"
          ? "implemented"
          : "pass",
    reason_code: "ok",
  });
  const res = await runHalfPipe({
    ...base(dir),
    spawn,
    helper: okHelper(),
    cfg: { reviewSteps: ["4a", "4b", "4c"], maxImplementRetries: 2 },
  });
  assert.deepEqual(res.visited, ["2", "3", "4a", "4b", "4c", "5"]);
  assert.equal(res.outcome, "complete");
});
