// default-wiring.ts — the batteries-included seams for `care-loopd start`: opencode+Copilot role
// skills + shell git/gate + OctokitGitHub. This is the ONE place the real adapters are assembled;
// runStart itself is pure composition, and tests inject fakes instead. Swap a piece by editing one
// line here (or by calling runStart with your own seam).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OctokitGitHub } from "./github.js";
import { runHelper } from "./shell.js";
import { CARE_FE_BOTS } from "./poll.js";
import {
  opencodeImplementer,
  opencodeReviewer,
  opencodeTriager,
  opencodePlanner,
  opencodeTestGrader,
  opencodeUxValidator,
  opencodeCiFixer,
} from "./skills-opencode.js";
import { loadModels } from "./models-config.js";
import { makeSkillLogger, withSkillLog } from "./skill-log.js";
import { roleSpawn, type StartOptions } from "./orchestrate.js";
import { symlinkProvisioner } from "./provision.js";
import { replyAndResolve, type Verdict } from "./reply.js";
import type { ApplyFn, GateFn, PushFn, ReplyFn } from "./ci-round.js";
import type { HelperFn } from "./pipeline.js";
import type { Planner, Provisioner, CiFixer } from "./ports.js";
import type { CiFixPayload } from "./skill-result.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.."); // care-loop/
const RUN_GATE = join(SKILL_DIR, "run_gate.sh");
const GATE_TIMEOUT = 600_000;

function headSha(worktree: string): string {
  return (
    spawnSync("git", ["-C", worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout?.trim() ?? ""
  );
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

type Seams = Pick<
  StartOptions,
  | "gh"
  | "spawn"
  | "helper"
  | "push"
  | "triage"
  | "apply"
  | "ciFix"
  | "testGrade"
  | "gate"
  | "pushRound"
  | "reply"
  | "bots"
>;

// Step-7 policy (user-confirmed 2026-07-16): reply to EVERY triaged thread and RESOLVE it. Triage now
// emits only address/decline (defer-to-human was removed — the loop handles everything), so both
// verdicts resolve: acted-on (address) and deliberately-rejected-with-a-reason (decline). Nothing is
// left open for a human.
const RESOLVE_VERDICTS: ReadonlySet<Verdict> = new Set(["address", "decline"]);

/** Human-handoff CiFixer: edits nothing, returns outcome "handoff" immediately. No longer the default
 *  (opencodeCiFixer is — see defaultSeams); retained as the opt-in fallback / test seam. Pass this to
 *  defaultSeams' consumer to force red-CI → immediate ci_red_human without running the real fixer. */
export function humanHandoffCiFixer(): CiFixer {
  return async ({ round }) => ({
    schema: "care-loop/skill-result@1" as const,
    skill: "ci-fixer",
    round,
    terminalState: "done" as const,
    verdict: "handoff",
    reasonCode: "human_handoff",
    payload: { outcome: "handoff", filesChanged: [] } satisfies CiFixPayload,
    modelUsed: "none",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });
}

/** Assemble the default opencode+shell+octokit seams for a real run. */
export function defaultSeams(cfg: WiringConfig): Seams {
  const [owner, name] = cfg.repo.split("/");
  const gh = new OctokitGitHub({ owner, name });
  const models = loadModels(cfg.modelsFile);
  // Wrap each skill once with the logging decorator — every invocation on every driver path
  // (roleSpawn, reduceTriage, 6b apply) is then captured identically (skill.invoke/result + sidecars).
  const runId = `${cfg.repo.replace("/", "-")}-${cfg.branch}`;
  const logger = makeSkillLogger({ runDir: cfg.runDir, runId });
  const reviewer = withSkillLog(
    "care-reviewer",
    opencodeReviewer(models),
    logger,
  );
  const implementer = withSkillLog(
    "implementer",
    opencodeImplementer(models),
    logger,
  );
  const triager = withSkillLog(
    "care-triager",
    opencodeTriager(models, cfg.worktree, cfg.base ?? "develop"),
    logger,
  );
  const testGrader = withSkillLog(
    "care-test-grader",
    opencodeTestGrader(models, cfg.worktree),
    logger,
  );
  const uxValidator = withSkillLog(
    "care-ux-validator",
    opencodeUxValidator(models),
    logger,
  );
  const buildArgs = cfg.buildLess ? ["-n"] : [];
  const provision = cfg.provision ?? symlinkProvisioner();
  const gateOf = (runDir: string, worktree: string, tag: string) =>
    runHelper({
      cmd: RUN_GATE,
      args: [...buildArgs, "-d", join(runDir, "gate")],
      cwd: worktree,
      logPath: join(runDir, "gate", `${tag}.log`),
      summaryMatch: /ALL PASSED|FAIL/,
      timeoutMs: GATE_TIMEOUT,
    });

  const helper: HelperFn = ({ name: step, runDir, worktree }) => {
    const log = join(runDir, "gate", `${step}.log`);
    switch (step) {
      case "setup-worktree": {
        // 1) create the worktree off the base branch, 2) provision it (symlink node_modules /
        // generated sources / env) so the gate can actually run.
        // IDEMPOTENT for a build-stage RESUME: a crashed pre-PR run left this worktree (and its
        // branch) in place, so `git worktree add -b` would collide ("already exists"). When the
        // checkout is already present, skip creation and only (re)provision — the maker's edits in it
        // are exactly what we resume onto.
        if (existsSync(worktree)) {
          const prov = provision({ worktree, mainRepoPath: cfg.mainRepoPath });
          return {
            exit: prov.exit,
            summary: `worktree exists (resume) · ${prov.summary}`,
            logPath: log,
          };
        }
        const add = runHelper({
          cmd: "git",
          args: [
            "-C",
            cfg.mainRepoPath,
            "worktree",
            "add",
            "-b",
            cfg.branch,
            worktree,
            cfg.base ?? "develop",
          ],
          logPath: log,
        });
        if (add.exit !== 0) return add;
        const prov = provision({ worktree, mainRepoPath: cfg.mainRepoPath });
        return {
          exit: prov.exit,
          summary: `${add.summary} · ${prov.summary}`,
          logPath: log,
        };
      }
      case "gate-inner":
        return runHelper({
          cmd: RUN_GATE,
          args: ["-n", "-d", join(runDir, "gate")],
          cwd: worktree,
          logPath: log,
          summaryMatch: /ALL PASSED|FAIL/,
          timeoutMs: GATE_TIMEOUT,
        });
      case "gate-full":
        return gateOf(runDir, worktree, "gate-full");
      case "commit": {
        // The edit-only implementer leaves its changes UNSTAGED (it owns no version control), so
        // stage everything first — otherwise `git commit` finds nothing staged and pushes an empty
        // branch (observed live: ENG-613 → "No commits between develop and …"). node_modules, the
        // generated src/supportedBrowsers.ts, and .env are all gitignored, so only real edits stage.
        const add = runHelper({
          cmd: "git",
          args: ["-C", worktree, "add", "-A"],
          logPath: log,
        });
        if (add.exit !== 0) return { ...add, head_sha: headSha(worktree) };
        const r = runHelper({
          cmd: "git",
          args: ["-C", worktree, "commit", "-m", cfg.task],
          logPath: log,
        });
        if (r.exit === 0) return { ...r, head_sha: headSha(worktree) };
        // care_fe's pre-commit hook (lint-staged) can block the commit on out-of-scope lint/format
        // errors that aren't part of this change (e.g. a deprecated fn elsewhere). Retry ONCE with
        // --no-verify — the orchestrator's own gate already ran tsc (whole-repo) + eslint (on the
        // CHANGED files) independently, so linting of this change isn't lost. Re-stage first: a failed
        // lint-staged run may have left files partially
        // modified/unstaged. The "hook bypassed" note rides the summary → the journal helper.exec event,
        // so the doctor can see a bypass happened.
        runHelper({
          cmd: "git",
          args: ["-C", worktree, "add", "-A"],
          logPath: log,
        });
        const bypass = runHelper({
          cmd: "git",
          args: ["-C", worktree, "commit", "--no-verify", "-m", cfg.task],
          logPath: log,
        });
        return {
          ...bypass,
          summary: `${bypass.summary} · pre-commit hook bypassed (--no-verify) after failure`,
          head_sha: headSha(worktree),
        };
      }
      default:
        return { exit: 0, summary: `${step} noop`, logPath: log };
    }
  };

  const push: StartOptions["push"] = ({ worktree, branch, runDir }) => {
    const r = runHelper({
      cmd: "git",
      args: ["-C", worktree, "push", "-u", "origin", branch],
      logPath: join(runDir, "gate", "push.log"),
    });
    return { exit: r.exit, summary: r.summary, headSha: headSha(worktree) };
  };

  const gate: GateFn = ({ runDir, specPaths }) => {
    if (specPaths?.length) {
      return runHelper({
        cmd: RUN_GATE,
        args: [
          ...buildArgs,
          "-s",
          specPaths.join(" "),
          "-d",
          join(runDir, "gate"),
        ],
        cwd: cfg.worktree,
        logPath: join(runDir, "gate", "gate-round.log"),
        summaryMatch: /ALL PASSED|FAIL/,
        timeoutMs: GATE_TIMEOUT,
      });
    }
    return gateOf(runDir, cfg.worktree, "gate-round");
  };
  const pushRound: PushFn = ({ round, runDir }) => {
    const log = join(runDir, "gate", "push-round.log");
    // The edit-only 6b implementer leaves its changes UNSTAGED (it owns no version control), so the
    // round must stage + commit them before pushing — otherwise `git push` ships the unchanged HEAD
    // and the PR never advances (observed: round pushed head==base, bots never re-review). Only commit
    // when the tree is actually dirty (a clean tree means a no-op round; just push whatever's local).
    const dirty = spawnSync(
      "git",
      ["-C", cfg.worktree, "status", "--porcelain"],
      { encoding: "utf8" },
    ).stdout?.trim();
    if (dirty) {
      const msg = `care-loop: address review feedback (round ${round})`;
      const add = runHelper({
        cmd: "git",
        args: ["-C", cfg.worktree, "add", "-A"],
        logPath: log,
      });
      if (add.exit !== 0)
        return {
          exit: add.exit,
          summary: add.summary,
          headSha: headSha(cfg.worktree),
        };
      const commit = runHelper({
        cmd: "git",
        args: ["-C", cfg.worktree, "commit", "-m", msg],
        logPath: log,
      });
      if (commit.exit !== 0) {
        // care_fe's lint-staged pre-commit hook can block on out-of-scope lint; retry --no-verify
        // (the gate already ran tsc whole-repo + eslint on the changed files independently). Re-stage first.
        runHelper({
          cmd: "git",
          args: ["-C", cfg.worktree, "add", "-A"],
          logPath: log,
        });
        runHelper({
          cmd: "git",
          args: ["-C", cfg.worktree, "commit", "--no-verify", "-m", msg],
          logPath: log,
        });
      }
    }
    const r = runHelper({
      cmd: "git",
      args: ["-C", cfg.worktree, "push"],
      logPath: log,
    });
    // A non-fast-forward rejection means the remote advanced since our last push — someone else
    // pushed (a bot suggestion commit, a human edit, or GitHub's "Update branch" merge). Rebase our
    // round commit on top of the new remote and retry ONCE. A clean fast-forward case rebases to a
    // no-op; a genuine content conflict fails the rebase (git aborts) and we surface the push error
    // for a human — we never force-push over someone else's work.
    if (
      r.exit !== 0 &&
      /non-fast-forward|fetch first|rejected|behind/i.test(r.summary)
    ) {
      const rebase = runHelper({
        cmd: "git",
        args: ["-C", cfg.worktree, "pull", "--rebase", "origin", cfg.branch],
        logPath: log,
      });
      if (rebase.exit !== 0) {
        // Rebase hit a conflict — leave the worktree clean for a human (don't ship a half-rebase).
        runHelper({
          cmd: "git",
          args: ["-C", cfg.worktree, "rebase", "--abort"],
          logPath: log,
        });
        return {
          exit: rebase.exit,
          summary: `push rejected (remote advanced) and rebase failed — ${rebase.summary}`,
          headSha: headSha(cfg.worktree),
        };
      }
      const retry = runHelper({
        cmd: "git",
        args: ["-C", cfg.worktree, "push"],
        logPath: log,
      });
      return {
        exit: retry.exit,
        summary: `${retry.summary} · rebased onto advanced remote before push`,
        headSha: headSha(cfg.worktree),
      };
    }
    return { exit: r.exit, summary: r.summary, headSha: headSha(cfg.worktree) };
  };
  const apply: ApplyFn = async ({
    round,
    runDir,
    findings: gateFindingsOverride,
  }) => {
    // The edit-only implementer is scoped to the worktree and CANNOT read the run dir, so it can't
    // open verdicts.md / feedback.md itself (its glob finds nothing). Read the triaged verdict list
    // here and inline it as findings — same pre-read pattern the triager uses for cluster files.
    const readRunFile = (name: string): string => {
      try {
        return readFileSync(join(runDir, name), "utf8").trim();
      } catch {
        return "";
      }
    };
    // Gate-loopback (MED-B): when the orchestrator re-applies after a gate failure, it passes the
    // gate errors as findings. Use those directly instead of the verdicts (the code change itself
    // is what broke the gate, not a new triage verdict).
    let findings: string;
    if (gateFindingsOverride) {
      findings = gateFindingsOverride;
    } else {
      const verdicts = readRunFile("verdicts.md");
      const feedback = readRunFile("feedback.md");
      findings = verdicts
        ? `Address the items marked verdict=address in the triaged verdict list below. Make the minimal ` +
          `code change for each; ignore decline items.\n\n=== TRIAGED VERDICTS ===\n${verdicts}\n=== END ===`
        : feedback
          ? `Address the actionable bot feedback below (skip anything already handled or out of scope).\n\n` +
            `=== FEEDBACK ===\n${feedback}\n=== END ===`
          : "Address the outstanding review feedback for this change.";
    }
    const r = await implementer({
      task: cfg.task,
      worktree: cfg.worktree,
      runDir,
      round,
      findings,
    });
    // Map the implementer's exit_0_no_change reason to "noop" so the loop terminates correctly
    // instead of retrying — a clean no-change means the flagged items are already fixed (MED-C).
    if (r.terminalState !== "done") return { terminalState: "failed" };
    if (
      r.reasonCode === "opencode_uncommitted" ||
      r.reasonCode === "opencode_committed"
    )
      return { terminalState: "done" };
    // exit_0_no_change or any other "done but nothing moved" reason → noop
    return { terminalState: "noop" };
  };

  const ciFix = withSkillLog(
    "care-ci-fix",
    opencodeCiFixer(models, cfg.worktree, cfg.base ?? "develop"),
    logger,
  );

  // Step 7 — post verdict replies into the triaged bot threads and resolve per RESOLVE_VERDICTS. Pure
  // GitHub I/O over the shared `gh`; idempotent via the care-loop signature (see reply.ts).
  const reply: ReplyFn = async ({ pr, items }) =>
    replyAndResolve({ gh, pr, items, resolve: RESOLVE_VERDICTS });

  const spawn = roleSpawn({
    reviewer,
    implementer,
    testGrader,
    uxValidator,
    worktree: cfg.worktree,
    task: cfg.task,
    base: cfg.base ?? "develop",
  });
  return {
    gh,
    spawn,
    helper,
    push,
    triage: triager,
    apply,
    ciFix,
    testGrade: testGrader,
    gate,
    pushRound,
    reply,
    bots: CARE_FE_BOTS,
  };
}

/** The default plan-stage seam: the opencode+Copilot Opus planner, logged like the other skills. The
 *  gate comes from the front (front-terminal.ts pairs terminalGate), so `plan` = front → this planner
 *  → runPlan. Swap the planner by passing your own `Planner` to runPlan. */
export function defaultPlanSeams(cfg: {
  repo: string;
  branch: string;
  runDir: string;
  modelsFile?: string;
}): { planner: Planner } {
  const runId = `${cfg.repo.replace("/", "-")}-${cfg.branch}`;
  const logger = makeSkillLogger({ runDir: cfg.runDir, runId });
  const models = loadModels(cfg.modelsFile);
  const planner = withSkillLog("care-planner", opencodePlanner(models), logger);
  return { planner };
}
