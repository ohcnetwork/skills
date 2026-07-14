#!/usr/bin/env node
// cli.ts — care-loopd entrypoint (PLAN-orchestrator-architecture §9 cli). Subcommands operate on a
// run dir whose single source of truth is journal.jsonl; state.json / loop.log are derived views.
// `resume` is the crash-only recovery path (§6). `start` runs the plan-gate-free pipeline (build →
// PR → CI rounds) via the default opencode/shell/octokit seams (default-wiring.ts).

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Journal } from "./journal.js";
import { projectAndWrite, projectState } from "./state.js";
import { renderEvent } from "./render.js";
import { acquireLock } from "./lock.js";
import { runStart } from "./orchestrate.js";
import { runPlan, hasApprovedPlan } from "./plan.js";
import { terminalFront, derivePaths } from "./front-terminal.js";
import type { PlanInput } from "./plan-front.js";
import { defaultSeams, defaultPlanSeams } from "./default-wiring.js";

function usage(): never {
  console.error(`care-loopd — headless care-loop orchestrator

Usage:
  care-loopd [run] [flags]       The one command. Interactive questionnaire (prompts for any of
       --task / --ticket / --branch / --summary not given as a flag, validated), then plan
       recon → interview → the single human gate → on approval, runs the autonomous loop
       (build → PR → CI rounds) straight through. Flags override the prompts — supply all four
       for a non-interactive (CI/bot) run. Bare \`care-loopd\` starts the questionnaire.
       flags: --repo owner/name (ohcnetwork/care_fe) · --main <care_fe path> · --worktree <path>
              --run-dir <path> · --base <develop> · --body <pr body> · --models <file>
              --build-less · --max-rounds <n> · --poll-timeout-ms <ms>

  care-loopd status <run-dir>    Projected state + recent journal events (read-only).
  care-loopd resume <run-dir>    Acquire the run lock, recover the journal head, report re-entry.

Advanced (the two phases of \`run\`, split for scripting/debugging):
  care-loopd plan  [flags]       Just the interactive plan stage — writes criteria.md / baseline.md /
       decisions.md (+ ui-surfaces.md) + a plan.approved event, then stops.
  care-loopd start [flags]       Just the autonomous loop. REFUSES without an approved plan in the run
       dir (run \`plan\` first) unless --skip-plan is passed for a throwaway/dev run.

Notes:
  • \`run\` needs no approved-plan flag — it plans then starts on one continuous run dir; the
    plan.approved journal event is the INTERNAL phase boundary, not a CLI boundary.
  • In a non-TTY session a missing required field is an error (not a hang) — pass it as a flag.
  • state.json / loop.log are DERIVED from journal.jsonl — never hand-edit them.
  • While an orchestrator holds a run, <run-dir>/.orchestrator.lock exists (pid inside).`);
  process.exit(2);
}

function parseFlags(argv: string[]): Record<string, string | true> {
  const f: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) f[key] = true;
    else {
      f[key] = next;
      i++;
    }
  }
  return f;
}

function journalOf(runDir: string): Journal {
  return new Journal(join(runDir, "journal.jsonl"), "cli");
}

function cmdStatus(runDir: string): void {
  if (!existsSync(join(runDir, "journal.jsonl"))) {
    console.log(`(no journal at ${runDir})`);
    return;
  }
  const { events, truncatedTail } = journalOf(runDir).read();
  const s = projectState(events);
  console.log(`run:  ${runDir}`);
  console.log(`step=${s.step}  round=${s.round}  pr=${s.pr ?? "-"}  head=${s.head_sha.slice(0, 9)}  ci-branch=${s.branch}`);
  console.log(`updated_at=${s.updated_at}${truncatedTail ? "   (journal tail torn — crash-recovered)" : ""}`);
  console.log(`\nlast events:`);
  for (const e of events.slice(-6)) console.log("  " + renderEvent(e));
}

function cmdResume(runDir: string): void {
  if (!existsSync(join(runDir, "journal.jsonl"))) {
    console.error(`no journal at ${runDir} — nothing to resume`);
    process.exit(2);
  }
  const lock = acquireLock(runDir); // refused if another orchestrator holds this run
  try {
    const { events, truncatedTail } = journalOf(runDir).read();
    const state = projectAndWrite(runDir, events); // rewrite derived state.json from the recovered head
    console.log(`resume: ${runDir}   (lock pid ${lock.pid})`);
    if (truncatedTail) console.log(`  recovered: torn journal tail truncated (crash mid-append)`);
    console.log(`  head:  step=${state.step}  round=${state.round}  pr=${state.pr ?? "-"}  head_sha=${state.head_sha.slice(0, 9)}`);
    console.log(`  next:  reconcile ground truth (git tree · PR head · CI) then continue at step ${state.step}`);
    console.log(`  note:  full resume-probe reconcile + step dispatch land with the agent-runner wiring.`);
  } finally {
    lock.release();
  }
}

async function cmdPlan(flags: Record<string, string | true>): Promise<void> {
  // The pluggable front sources the input + pairs the terminal gate; the planner is the default
  // opencode Opus skill; runPlan is the invariant core. A different workflow swaps only the front.
  const { input, gate } = await terminalFront(flags).resolve();
  const modelsFile = typeof flags.models === "string" ? flags.models : undefined;
  const { planner } = defaultPlanSeams({ repo: input.repo, branch: input.branch, runDir: input.runDir, modelsFile });
  console.log(`care-loopd plan: ${input.repo}  branch=${input.branch}  ticket=${input.ticket}`);
  console.log(`  run dir: ${input.runDir}\n`);

  const res = await runPlan({ input, planner, gate });
  console.log(`\nplan: ${res.outcome}  (${res.reasonCode})${res.classification ? `  tier=${res.classification}` : ""}`);
  if (res.outcome === "approved") {
    console.log(`  next: care-loopd start --task '${input.task}' --ticket ${input.ticket} --branch ${input.branch} --summary '${input.summary}'`);
  } else {
    process.exit(1);
  }
}

async function cmdStart(flags: Record<string, string | true>): Promise<void> {
  const need = (k: string): string => {
    const v = flags[k];
    if (typeof v !== "string") {
      console.error(`start: --${k} <value> is required`);
      process.exit(2);
    }
    return v;
  };
  const task = need("task");
  const ticket = need("ticket");
  const branch = need("branch");
  const summary = need("summary");
  const { repo, mainRepoPath, worktree, runDir } = derivePaths(branch, flags);
  mkdirSync(runDir, { recursive: true });

  // Plan gate: `start` refuses to run without an approved plan in the run dir (the human gate
  // authorizes pushing — SKILL.md). `--skip-plan` bypasses it for a throwaway/dev run.
  const skipPlan = flags["skip-plan"] === true;
  const journalPath = join(runDir, "journal.jsonl");
  const priorEvents = existsSync(journalPath) ? journalOf(runDir).read().events : [];
  if (!skipPlan && !hasApprovedPlan(priorEvents)) {
    console.error(`start: no approved plan in ${runDir} — run \`care-loopd plan …\` first (or pass --skip-plan for a throwaway run).`);
    process.exit(2);
  }

  await startFromInput({ task, ticket, branch, summary, repo, mainRepoPath, worktree, runDir }, flags);
}

/** Run the autonomous loop (build → PR → CI rounds) from a resolved `PlanInput` + the advanced flags.
 *  Shared by `start` (raw flag path) and `run` (post-approval continuation) so neither re-derives the
 *  tier/prBody/seams. Reads the tier from the journal the plan stage wrote. */
async function startFromInput(input: PlanInput, flags: Record<string, string | true>): Promise<void> {
  const { task, ticket, branch, summary, repo, mainRepoPath, worktree, runDir } = input;
  const base = typeof flags.base === "string" ? flags.base : "develop";
  const buildLess = flags["build-less"] === true;
  const modelsFile = typeof flags.models === "string" ? flags.models : undefined;

  // Tier flows plan → start via the projected state. A trivial change notes the test skip in the PR.
  const priorEvents = existsSync(join(runDir, "journal.jsonl")) ? journalOf(runDir).read().events : [];
  const tier = priorEvents.length ? projectState(priorEvents).tier : "standard";
  let prBody = typeof flags.body === "string" ? flags.body : `## Changes\n\n${summary}`;
  if (tier === "trivial") prBody += `\n\n_Tests skipped — trivial change._`;

  const cfg: { maxRounds?: number; pollTimeoutMs?: number } = {};
  if (typeof flags["max-rounds"] === "string") cfg.maxRounds = Number(flags["max-rounds"]);
  if (typeof flags["poll-timeout-ms"] === "string") cfg.pollTimeoutMs = Number(flags["poll-timeout-ms"]);

  const seams = defaultSeams({ repo, mainRepoPath, worktree, branch, base, task, runDir, buildLess, modelsFile });
  console.log(`care-loopd start: ${repo}  branch=${branch}  worktree=${worktree}`);
  console.log(`  PR title will be: [${ticket}] ${summary}${buildLess ? "   (build-less gate)" : ""}${tier ? `   (tier=${tier})` : ""}\n`);

  const res = await runStart({
    runDir,
    worktree,
    repo,
    branch,
    base,
    task,
    ticket,
    summary,
    prBody,
    cfg,
    ...seams,
  });
  console.log(`\ndone: phase=${res.phase}  outcome=${res.outcome}${res.pr ? `  pr=#${res.pr}` : ""}`);
  if (res.phase === "ci" && res.outcome !== "converged") process.exit(1);
}

/** The single entry point: the questionnaire front sources + validates the seed input, `runPlan` drives
 *  recon → interview → consolidated human gate, and on approval we continue STRAIGHT into the autonomous
 *  loop with the SAME input — no re-supplied flags. `hasApprovedPlan` stays the INTERNAL phase boundary
 *  (runPlan just wrote `plan.approved`); it is no longer a CLI boundary. */
async function cmdRun(flags: Record<string, string | true>): Promise<void> {
  const { input, gate } = await terminalFront(flags).resolve();
  const modelsFile = typeof flags.models === "string" ? flags.models : undefined;
  const { planner } = defaultPlanSeams({ repo: input.repo, branch: input.branch, runDir: input.runDir, modelsFile });
  console.log(`care-loopd: ${input.repo}  branch=${input.branch}  ticket=${input.ticket}`);
  console.log(`  run dir: ${input.runDir}\n`);

  const plan = await runPlan({ input, planner, gate });
  console.log(`\nplan: ${plan.outcome}  (${plan.reasonCode})${plan.classification ? `  tier=${plan.classification}` : ""}`);
  if (plan.outcome !== "approved") process.exit(1);

  console.log(`\n── plan approved — starting the autonomous loop ${"─".repeat(28)}\n`);
  await startFromInput(input, flags);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  // Bare `care-loopd` (or `care-loopd --task … --ticket …`) is the primary path: the combined
  // questionnaire → plan → gate → autonomous loop. A leading flag means "run with these overrides".
  if (cmd === undefined || cmd.startsWith("--")) {
    await cmdRun(parseFlags(argv));
    return;
  }
  switch (cmd) {
    case "status":
      if (!rest[0]) usage();
      cmdStatus(resolve(rest[0]));
      break;
    case "resume":
      if (!rest[0]) usage();
      cmdResume(resolve(rest[0]));
      break;
    case "run":
      await cmdRun(parseFlags(rest));
      break;
    case "plan":
      await cmdPlan(parseFlags(rest));
      break;
    case "start":
      await cmdStart(parseFlags(rest));
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(`care-loopd: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
