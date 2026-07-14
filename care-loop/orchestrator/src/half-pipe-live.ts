// half-pipe-live.ts — the FIRST live run of the Phase-3 half-pipe (2→3→4a→5) against a real
// care_fe scratch branch, off the VS Code chat turn (PLAN-orchestrator-architecture §10 phase 3).
//
// Wires the deterministic core (runHalfPipe) to REAL side-effecting seams:
//   • HelperFn  → shell.ts: git worktree add · run_gate.sh -n · git commit
//   • SpawnFn   → opencode + Copilot: implementer via `opencode run --dir <wt>` (cheap tier, tools
//                 on, edits the worktree); reviewer via the structured-output boundary (Opus, the
//                 worktree diff inline).
//
// Safety for this first proof: a trivial new-file task, a BUILD-LESS gate (`-n`, type/lint only —
// the memory-heavy full build is deferred to the CI-round-trip hardening pass), no push/PR, and
// guaranteed worktree+branch cleanup in a finally block. Nothing here touches the main checkout.
//
// Run: cd care-loop/orchestrator && npm run live:halfpipe
//   env: CARE_FE (default ~/Desktop/care_fe) · IMPL_MODEL · REVIEW_MODEL · KEEP=1 to skip cleanup.

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runHalfPipe, type SpawnFn, type HelperFn, type SpawnResult } from "./pipeline.js";
import { runHelper } from "./shell.js";
import { runJudgmentSpawn } from "./opencode-runner.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.."); // care-loop/
const RUN_GATE = join(SKILL_DIR, "run_gate.sh");
const CARE_FE = process.env.CARE_FE ?? join(homedir(), "Desktop/care_fe");
const IMPL_MODEL = process.env.IMPL_MODEL ?? "claude-sonnet-4.6"; // cheap maker tier
const REVIEW_MODEL = process.env.REVIEW_MODEL ?? "claude-opus-4.8"; // judgment tier
const PROVIDER = "github-copilot";
const STAMP = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const BRANCH = `scratch/careloopd-${STAMP}`;
const WORKTREE = join(homedir(), `Desktop/care_fe-careloopd-${STAMP}`);
const RUN_DIR = mkdtempSync(join(tmpdir(), "careloopd-live-"));

const TASK =
  "Create a new file at src/Utils/careloopdProbe.ts that exports a single pure function " +
  "`add(a: number, b: number): number` returning a + b, with a one-line JSDoc comment. " +
  "Do not modify any other file. Keep it minimal; it must pass TypeScript and ESLint.";

/** Synchronous git read against a repo dir. */
function git(dir: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const helper: HelperFn = ({ name, runDir, worktree }) => {
  const log = join(runDir, "gate", `${name}.log`);
  switch (name) {
    case "setup-worktree": {
      // `git worktree add -b <branch> <wt> develop` off the main checkout.
      return runHelper({ cmd: "git", args: ["-C", CARE_FE, "worktree", "add", "-b", BRANCH, worktree, "develop"], logPath: log });
    }
    case "gate-inner":
    case "gate-full": {
      // build-less gate (type + lint) scoped to the worktree; logs under RUN_DIR/gate.
      return runHelper({
        cmd: RUN_GATE,
        args: ["-n", "-d", join(runDir, "gate")],
        cwd: worktree,
        logPath: log,
        summaryMatch: /ALL PASSED|FAIL|PASS/,
        timeoutMs: 240_000,
      });
    }
    case "commit": {
      git(worktree, "add", "-A");
      const r = runHelper({ cmd: "git", args: ["-C", worktree, "commit", "-m", `feat(scratch): careloopd half-pipe probe [${BRANCH}]`], logPath: log });
      const head = git(worktree, "rev-parse", "HEAD").out.trim();
      return { ...r, head_sha: head };
    }
    default:
      return { exit: 0, summary: `${name} noop`, logPath: log };
  }
};

const spawn: SpawnFn = async ({ role }) => {
  if (role === "implementer") {
    // Real maker: opencode run scoped to the worktree, tools on (default build agent).
    const r = runHelper({
      cmd: "opencode",
      args: ["run", "--dir", WORKTREE, "--model", `${PROVIDER}/${IMPL_MODEL}`, TASK],
      logPath: join(RUN_DIR, "agents", "implementer.log"),
      timeoutMs: 300_000,
    });
    git(WORKTREE, "add", "-A"); // stage new/untracked so the diff is reviewable
    const diff = git(WORKTREE, "diff", "--cached", "--stat").out.trim();
    const done = r.exit === 0 && diff.length > 0;
    return {
      terminal_state: done ? "done" : "failed",
      verdict: done ? "implemented" : "no_change",
      reason_code: done ? "opencode_run_ok" : `exit_${r.exit}_diff_${diff.length}`,
      model_used: IMPL_MODEL,
    } satisfies SpawnResult;
  }

  // care-reviewer: structured-output boundary (Opus), the worktree diff inline.
  const diff = git(WORKTREE, "diff", "--cached").out;
  const outcome = await runJudgmentSpawn({
    role: "care-reviewer",
    providerID: PROVIDER,
    modelID: REVIEW_MODEL,
    system:
      "You are the care-loop reviewer (judgment tier). Review the supplied diff for worth-deciding " +
      "correctness/overengineering/legibility issues. Set verdict=\"pass\" if clean, \"findings\" if " +
      "there are non-blocking notes, \"blocked\" only for a real defect that must be fixed before merge. " +
      "Fill model_used. Respond ONLY as the required JobResult.",
    task: `Review this staged diff on a scratch branch.\n\n=== DIFF ===\n${diff}\n=== END DIFF ===`,
    runId: "live-halfpipe",
    round: 1,
  });
  return {
    terminal_state: outcome.jobResult.terminal_state,
    verdict: outcome.jobResult.verdict,
    reason_code: outcome.jobResult.reason_code,
    model_used: outcome.jobResult.model_used,
    head_sha: git(WORKTREE, "rev-parse", "HEAD").out.trim(),
  } satisfies SpawnResult;
};

function cleanup() {
  if (process.env.KEEP === "1") {
    console.log(`\n(KEEP=1) left worktree ${WORKTREE} and branch ${BRANCH} in place`);
    return;
  }
  git(CARE_FE, "worktree", "remove", "--force", WORKTREE);
  git(CARE_FE, "branch", "-D", BRANCH);
  console.log(`\ncleaned up worktree + branch ${BRANCH}`);
}

async function main() {
  console.log(`▶ LIVE half-pipe against ${CARE_FE}`);
  console.log(`  branch=${BRANCH}  worktree=${WORKTREE}`);
  console.log(`  impl=${PROVIDER}/${IMPL_MODEL}  review=${PROVIDER}/${REVIEW_MODEL}`);
  console.log(`  gate=build-less (-n)  run-dir=${RUN_DIR}\n`);

  try {
    const res = await runHalfPipe({
      runDir: RUN_DIR,
      worktree: WORKTREE,
      task: TASK,
      repo: "ohcnetwork/care_fe",
      branch: BRANCH,
      spawn,
      helper,
    });
    console.log(`\n${res.outcome === "complete" ? "✅" : "⚠️"} outcome=${res.outcome}`);
    console.log(`  steps visited: ${res.visited.join(" → ")}`);
    console.log(`  final state.step=${res.state.step}  head=${res.state.head_sha}`);
    console.log(`  journal + state.json + loop.log → ${RUN_DIR}`);
    console.log(`\n--- loop.log ---\n${spawnSync("cat", [join(RUN_DIR, "loop.log")], { encoding: "utf8" }).stdout}`);
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(`\n❌ live half-pipe FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  cleanup();
  process.exit(1);
});
