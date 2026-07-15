// orchestrate.ts — the end-to-end `start` composition (PLAN §10 phases 3+4+5, assembled). Under one
// run lock it drives build (2→3→4a→5, gate+commit) → push → open PR (GitHubApi, [ENG-###] title) →
// CI rounds (5-await→6a→6b→5), all on ONE journal. It depends only on the injected seams, so it's
// fully fake-testable; cli.ts wires the default opencode/shell/octokit adapters.

import { join } from "node:path";
import { Journal } from "./journal.js";
import { projectAndWrite, type CareState } from "./state.js";
import { runHalfPipe, type HelperFn, type SpawnFn } from "./pipeline.js";
import {
  runCiRounds,
  type ApplyFn,
  type CiRoundsConfig,
  type GateFn,
  type PushFn,
  type TriageFn,
} from "./ci-round.js";
import { withLock } from "./lock.js";
import type { Bot } from "./poll.js";
import type { GitHubApi } from "./github.js";
import type { Implementer, Reviewer, Triager } from "./ports.js";

export interface StartOptions {
  runDir: string;
  worktree: string;
  repo: string; // owner/name
  branch: string;
  base?: string; // PR base, default "develop"
  task: string;
  ticket: string; // e.g. "ENG-648" — baked into the PR title as [ENG-###] (IMP-12)
  summary: string; // PR title summary
  prBody: string;

  // seams
  gh: GitHubApi;
  spawn: SpawnFn; // build-phase agent bridge (see roleSpawn)
  helper: HelperFn; // build-phase git/gate
  push: (input: { runDir: string; worktree: string; branch: string }) => {
    exit: number;
    summary: string;
    headSha?: string;
  };
  triage: Triager;
  apply: ApplyFn;
  gate: GateFn;
  pushRound: PushFn;
  bots: Bot[];

  cfg?: CiRoundsConfig;
  pollDeps?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
  lockOpts?: { pid?: number; isAlive?: (pid: number) => boolean };
}

export type StartPhase = "build" | "push" | "ci";
export interface StartResult {
  phase: StartPhase;
  outcome: string; // build: aborted; push: push-failed; ci: converged|capped|deferred|gate-blocked
  pr?: number;
  state: CareState;
}

export async function runStart(o: StartOptions): Promise<StartResult> {
  return withLock(
    o.runDir,
    async (): Promise<StartResult> => {
      const runId = `${o.repo.replace("/", "-")}-${o.branch}`;

      // Phase 1 — build to a committed change (no PR). finalize:false keeps the journal open.
      const build = await runHalfPipe({
        runDir: o.runDir,
        worktree: o.worktree,
        task: o.task,
        repo: o.repo,
        branch: o.branch,
        spawn: o.spawn,
        helper: o.helper,
        finalize: false,
      });
      if (build.outcome !== "complete") {
        return { phase: "build", outcome: build.outcome, state: build.state };
      }

      const j = new Journal(join(o.runDir, "journal.jsonl"), runId);

      // Phase 2 — push, then open the PR with the required [ENG-###] title (IMP-12).
      const p = o.push({
        runDir: o.runDir,
        worktree: o.worktree,
        branch: o.branch,
      });
      const headSha = p.headSha ?? build.state.head_sha;
      j.append({
        event: "push",
        data: {
          exit: p.exit,
          head_sha: headSha,
          summary: p.summary,
          state: { head_sha: headSha, step: "5-pushing" },
        },
      });
      if (p.exit !== 0) {
        j.append({
          event: "run.end",
          data: {
            outcome: "push-failed",
            reason_code: `push_exit_${p.exit}`,
            state: { step: "5-pushing" },
          },
        });
        return {
          phase: "push",
          outcome: "push-failed",
          state: projectAndWrite(o.runDir, j.read().events),
        };
      }

      const title = `[${o.ticket}] ${o.summary}`;
      if (!/^\[ENG-\d+\]\s/.test(title)) {
        throw new Error(
          `PR title must match [ENG-###] <summary> (IMP-12); got: ${title}`,
        );
      }
      const pr = await o.gh.createPr({
        head: o.branch,
        base: o.base ?? "develop",
        title,
        body: o.prBody,
      });
      await o.gh.addLabel(pr, "agentic-workflows");
      j.append({
        event: "decision",
        data: { note: "pr-opened", pr, title, state: { pr, step: "5-await" } },
      });
      projectAndWrite(o.runDir, j.read().events);

      // Phase 3 — CI rounds on the SAME journal (runCiRounds seeds run.start only when empty).
      const ci = await runCiRounds({
        gh: o.gh,
        runDir: o.runDir,
        repo: o.repo,
        branch: o.branch,
        pr,
        headSha,
        sinceIso: new Date().toISOString(),
        bots: o.bots,
        triage: reduceTriage(o.triage),
        apply: o.apply,
        gate: o.gate,
        push: o.pushRound,
        cfg: o.cfg,
        pollDeps: o.pollDeps,
      });
      return { phase: "ci", outcome: ci.outcome, pr, state: ci.state };
    },
    o.lockOpts,
  );
}

/**
 * Bridge the ergonomic role skills (Reviewer/Implementer) to the build driver's internal SpawnFn.
 * This is where "swap a reviewer" takes effect — pass a different Reviewer here. The reviewer needs
 * the diff, computed from the worktree by `diffOf` (default: staged git diff).
 */
export function roleSpawn(opts: {
  reviewer: Reviewer;
  implementer: Implementer;
  worktree: string;
  task: string;
  base?: string; // base branch the change is measured against (default "develop")
  diffOf?: (worktree: string, base: string) => string;
}): SpawnFn {
  const base = opts.base ?? "develop";
  const diffOf = opts.diffOf ?? defaultDiffOf;
  return async ({ role, round, runDir, context }) => {
    if (role === "implementer") {
      const r = await opts.implementer({
        task: opts.task,
        worktree: opts.worktree,
        runDir,
        round,
        findings: context,
      });
      return {
        terminal_state: r.terminalState,
        verdict: r.verdict,
        reason_code: r.reasonCode,
        model_used: r.modelUsed,
        timedOut: r.payload.timedOut,
      };
    }
    if (role === "care-reviewer") {
      const r = await opts.reviewer({
        diff: diffOf(opts.worktree, base),
        runDir,
        round,
      });
      return {
        terminal_state: r.terminalState,
        verdict: r.verdict,
        reason_code: r.reasonCode,
        model_used: r.modelUsed,
      };
    }
    return {
      terminal_state: "done",
      verdict: "pass",
      reason_code: "role_noop",
    };
  };
}

/** Adapt the Triager skill (SkillResult envelope) down to the ci-round driver's minimal digest — the
 *  triager's counterpart to roleSpawn, keeping the deterministic driver free of the skill envelope.
 *  Exported so `resume` can re-enter runCiRounds with the same reduction runStart applies. */
export function reduceTriage(t: Triager): TriageFn {
  return async (input) => {
    const r = await t(input);
    return {
      addressCount: r.payload.addressCount,
      declineCount: r.payload.declineCount,
      deferCount: r.payload.deferCount,
      items: r.payload.items,
    };
  };
}

import { spawnSync } from "node:child_process";
// The change under review = everything the branch adds vs its base (COMMITTED, since the agent may
// commit itself) PLUS any still-uncommitted edits.
function defaultDiffOf(worktree: string, base: string): string {
  const run = (...a: string[]) =>
    spawnSync("git", ["-C", worktree, ...a], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }).stdout ?? "";
  const committed = run("diff", `${base}...HEAD`);
  const uncommitted = run("diff", "HEAD");
  return committed + uncommitted;
}
