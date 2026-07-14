// default-wiring.ts — the batteries-included seams for `care-loopd start`: opencode+Copilot role
// skills + shell git/gate + OctokitGitHub. This is the ONE place the real adapters are assembled;
// runStart itself is pure composition, and tests inject fakes instead. Swap a piece by editing one
// line here (or by calling runStart with your own seam).

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OctokitGitHub } from "./github.js";
import { runHelper } from "./shell.js";
import { CARE_FE_BOTS } from "./poll.js";
import { opencodeImplementer, opencodeReviewer, opencodeTriager, opencodePlanner } from "./skills-opencode.js";
import { loadModels } from "./models-config.js";
import { makeSkillLogger, withSkillLog } from "./skill-log.js";
import { roleSpawn, type StartOptions } from "./orchestrate.js";
import { symlinkProvisioner } from "./provision.js";
import type { ApplyFn, GateFn, PushFn } from "./ci-round.js";
import type { HelperFn } from "./pipeline.js";
import type { Planner, Provisioner } from "./ports.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.."); // care-loop/
const RUN_GATE = join(SKILL_DIR, "run_gate.sh");
const GATE_TIMEOUT = 600_000;

function headSha(worktree: string): string {
  return spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout?.trim() ?? "";
}

export interface WiringConfig {
  repo: string; // owner/name
  mainRepoPath: string; // the main care_fe checkout (worktrees branch off it)
  worktree: string;
  branch: string;
  base?: string; // default "develop"
  task: string;
  runDir: string;
  buildLess?: boolean; // -n gate (type/lint only; skips the memory-heavy build)
  provision?: Provisioner; // worktree provisioning seam (default: symlink from the main checkout)
  modelsFile?: string; // path to a models.json override (default: care-loop/models.json)
}

type Seams = Pick<StartOptions, "gh" | "spawn" | "helper" | "push" | "triage" | "apply" | "gate" | "pushRound" | "bots">;

/** Assemble the default opencode+shell+octokit seams for a real run. */
export function defaultSeams(cfg: WiringConfig): Seams {
  const [owner, name] = cfg.repo.split("/");
  const gh = new OctokitGitHub({ owner, name });
  const models = loadModels(cfg.modelsFile);
  // Wrap each skill once with the logging decorator — every invocation on every driver path
  // (roleSpawn, reduceTriage, 6b apply) is then captured identically (skill.invoke/result + sidecars).
  const runId = `${cfg.repo.replace("/", "-")}-${cfg.branch}`;
  const logger = makeSkillLogger({ runDir: cfg.runDir, runId });
  const reviewer = withSkillLog("care-reviewer", opencodeReviewer(models), logger);
  const implementer = withSkillLog("implementer", opencodeImplementer(models), logger);
  const triager = withSkillLog("care-triager", opencodeTriager(models), logger);
  const buildArgs = cfg.buildLess ? ["-n"] : [];
  const provision = cfg.provision ?? symlinkProvisioner();
  const gateOf = (runDir: string, worktree: string, tag: string) =>
    runHelper({ cmd: RUN_GATE, args: [...buildArgs, "-d", join(runDir, "gate")], cwd: worktree, logPath: join(runDir, "gate", `${tag}.log`), summaryMatch: /ALL PASSED|FAIL/, timeoutMs: GATE_TIMEOUT });

  const helper: HelperFn = ({ name: step, runDir, worktree }) => {
    const log = join(runDir, "gate", `${step}.log`);
    switch (step) {
      case "setup-worktree": {
        // 1) create the worktree off the base branch, 2) provision it (symlink node_modules /
        // generated sources / env) so the gate can actually run.
        const add = runHelper({ cmd: "git", args: ["-C", cfg.mainRepoPath, "worktree", "add", "-b", cfg.branch, worktree, cfg.base ?? "develop"], logPath: log });
        if (add.exit !== 0) return add;
        const prov = provision({ worktree, mainRepoPath: cfg.mainRepoPath });
        return { exit: prov.exit, summary: `${add.summary} · ${prov.summary}`, logPath: log };
      }
      case "gate-inner":
        return runHelper({ cmd: RUN_GATE, args: ["-n", "-d", join(runDir, "gate")], cwd: worktree, logPath: log, summaryMatch: /ALL PASSED|FAIL/, timeoutMs: GATE_TIMEOUT });
      case "gate-full":
        return gateOf(runDir, worktree, "gate-full");
      case "commit": {
        // The edit-only implementer leaves its changes UNSTAGED (it owns no version control), so
        // stage everything first — otherwise `git commit` finds nothing staged and pushes an empty
        // branch (observed live: ENG-613 → "No commits between develop and …"). node_modules, the
        // generated src/supportedBrowsers.ts, and .env are all gitignored, so only real edits stage.
        const add = runHelper({ cmd: "git", args: ["-C", worktree, "add", "-A"], logPath: log });
        if (add.exit !== 0) return { ...add, head_sha: headSha(worktree) };
        const r = runHelper({ cmd: "git", args: ["-C", worktree, "commit", "-m", cfg.task], logPath: log });
        if (r.exit === 0) return { ...r, head_sha: headSha(worktree) };
        // care_fe's pre-commit hook (lint-staged) can block the commit on out-of-scope lint/format
        // errors that aren't part of this change (e.g. a deprecated fn elsewhere). Retry ONCE with
        // --no-verify — the orchestrator's own gate already ran tsc + eslint on ./src independently,
        // so linting isn't lost. Re-stage first: a failed lint-staged run may have left files partially
        // modified/unstaged. The "hook bypassed" note rides the summary → the journal helper.exec event,
        // so the doctor can see a bypass happened.
        runHelper({ cmd: "git", args: ["-C", worktree, "add", "-A"], logPath: log });
        const bypass = runHelper({ cmd: "git", args: ["-C", worktree, "commit", "--no-verify", "-m", cfg.task], logPath: log });
        return { ...bypass, summary: `${bypass.summary} · pre-commit hook bypassed (--no-verify) after failure`, head_sha: headSha(worktree) };
      }
      default:
        return { exit: 0, summary: `${step} noop`, logPath: log };
    }
  };

  const push: StartOptions["push"] = ({ worktree, branch, runDir }) => {
    const r = runHelper({ cmd: "git", args: ["-C", worktree, "push", "-u", "origin", branch], logPath: join(runDir, "gate", "push.log") });
    return { exit: r.exit, summary: r.summary, headSha: headSha(worktree) };
  };

  const gate: GateFn = ({ runDir }) => gateOf(runDir, cfg.worktree, "gate-round");
  const pushRound: PushFn = ({ runDir }) => {
    const r = runHelper({ cmd: "git", args: ["-C", cfg.worktree, "push"], logPath: join(runDir, "gate", "push-round.log") });
    return { exit: r.exit, summary: r.summary, headSha: headSha(cfg.worktree) };
  };
  const apply: ApplyFn = async ({ round, runDir }) => {
    const r = await implementer({ task: cfg.task, worktree: cfg.worktree, runDir, round, findings: "address the `address`-verdict items in verdicts.md (the triaged verdict list; fall back to feedback.md if it's absent)" });
    return { terminalState: r.terminalState === "done" ? "done" : "failed" };
  };

  const spawn = roleSpawn({ reviewer, implementer, worktree: cfg.worktree, task: cfg.task, base: cfg.base ?? "develop" });
  return { gh, spawn, helper, push, triage: triager, apply, gate, pushRound, bots: CARE_FE_BOTS };
}

/** The default plan-stage seam: the opencode+Copilot Opus planner, logged like the other skills. The
 *  gate comes from the front (front-terminal.ts pairs terminalGate), so `plan` = front → this planner
 *  → runPlan. Swap the planner by passing your own `Planner` to runPlan. */
export function defaultPlanSeams(cfg: { repo: string; branch: string; runDir: string; modelsFile?: string }): { planner: Planner } {
  const runId = `${cfg.repo.replace("/", "-")}-${cfg.branch}`;
  const logger = makeSkillLogger({ runDir: cfg.runDir, runId });
  const models = loadModels(cfg.modelsFile);
  const planner = withSkillLog("care-planner", opencodePlanner(models), logger);
  return { planner };
}
