#!/usr/bin/env node
// cli.ts — care-loopd entrypoint (PLAN-orchestrator-architecture §9 cli). Subcommands operate on a
// run dir whose single source of truth is journal.jsonl; state.json / loop.log are derived views.
// `resume` is the crash-only recovery path (§6). `start` runs the plan-gate-free pipeline (build →
// PR → CI rounds) via the default opencode/shell/octokit seams (default-wiring.ts).

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { Journal } from "./journal.js";
import { projectAndWrite, projectState } from "./state.js";
import { renderEvent } from "./render.js";
import { withLock } from "./lock.js";
import {
  runStart,
  reduceTriage,
  reduceCiFix,
  reduceTestGrade,
} from "./orchestrate.js";
import { runCiRounds, type CiRoundsConfig } from "./ci-round.js";
import { runPlan, hasApprovedPlan } from "./plan.js";
import { terminalFront, derivePaths } from "./front-terminal.js";
import { probePr, planResume, type ResumePlan } from "./resume.js";
import type { PlanInput } from "./plan-front.js";
import { defaultSeams, defaultPlanSeams } from "./default-wiring.js";
import { runEndOfRunDoctor } from "./auto-doctor-wiring.js";
import { startDashboard } from "./dashboard.js";

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
              --build-less · --max-rounds <n> · --poll-timeout-ms <ms> · --no-doctor
       (end-of-run self-improvement runs by default; --no-doctor or CARE_DOCTOR=0 to skip)

  care-loopd dashboard [flags]   Web dashboard — fleet view of all runs + drill-down timelines.
       flags: --port <n> (default 3141) · --runs-dir <path> (default ../runs)

  care-loopd status <run-dir>    Projected state + recent journal events (read-only).
  care-loopd resume <run-dir>    Resume a crashed run. If a PR is open, reconcile it (probePr: head ·
       CI · bots-at-head) and RE-ENTER the CI-round loop at the journal-head round — no re-push, no
       duplicate PR. If the crash was AFTER plan approval but BEFORE the PR was opened, re-enter the
       BUILD pipeline at the interrupted step and drive through push → open-PR → CI (worktree reused,
       review re-run read-only). Refuses a pre-plan crash (interview isn't re-entrant — re-run fresh).
       flags: --main <care_fe path> · --ticket ENG-### / --summary <text> (only if the run predates
              ticket persistence) · --max-rounds <n> · --no-doctor

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
  console.log(
    `step=${s.step}  round=${s.round}  pr=${s.pr ?? "-"}  head=${s.head_sha.slice(0, 9)}  ci-branch=${s.branch}`,
  );
  console.log(
    `updated_at=${s.updated_at}${truncatedTail ? "   (journal tail torn — crash-recovered)" : ""}`,
  );
  console.log(`\nlast events:`);
  for (const e of events.slice(-6)) console.log("  " + renderEvent(e));
}

async function cmdResume(
  runDir: string,
  flags: Record<string, string | true>,
): Promise<void> {
  if (!existsSync(join(runDir, "journal.jsonl"))) {
    console.error(`no journal at ${runDir} — nothing to resume`);
    process.exit(2);
  }
  const { events, truncatedTail } = journalOf(runDir).read();
  const plan = planResume(events);
  const s = plan.state;
  console.log(`resume: ${runDir}`);
  if (truncatedTail)
    console.log(`  recovered: torn journal tail truncated (crash mid-append)`);
  console.log(
    `  head:  step=${s.step}  round=${s.round}  pr=${s.pr ?? "-"}  head_sha=${s.head_sha.slice(0, 9)}`,
  );
  if (!plan.resumable) {
    console.error(`  cannot resume: ${plan.reason}`);
    process.exit(2);
  }

  // A crash AFTER plan approval but BEFORE the PR was opened re-enters the BUILD pipeline (idempotent
  // worktree + read-only review) and flows through push → open-PR → CI as a fresh start would.
  if (plan.mode === "build") {
    await resumeBuild(runDir, plan, flags);
    return;
  }

  // Reconstruct the same real seams `start` uses (mainRepoPath from --main; worktree/repo/branch/task
  // come from the journal-head state, so resume needs no re-supplied seed flags).
  const { mainRepoPath } = derivePaths(s.branch, flags);
  const base = typeof flags.base === "string" ? flags.base : "develop";
  const buildLess = flags["build-less"] === true;
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;
  const seams = defaultSeams({
    repo: s.repo,
    mainRepoPath,
    worktree: s.worktree,
    branch: s.branch,
    base,
    task: s.task,
    runDir,
    buildLess,
    modelsFile,
  });

  // Reconcile PR ground truth (probePr = the resume-probe PR half) BEFORE re-entering the loop.
  const probe = await probePr(seams.gh, plan.pr!, plan.headSha!);
  console.log(
    `  probe: pr #${plan.pr}  state=${probe.state}  ci=${probe.ci}  pr-head=${probe.prHead.slice(0, 9)}  bots@head=[${probe.botsAtHead.join(", ")}]`,
  );
  if (probe.state !== "open") {
    console.error(
      `  cannot resume: PR #${plan.pr} is ${probe.state} (nothing to converge)`,
    );
    process.exit(2);
  }

  // Reconcile the worktree with the live remote BEFORE re-entering the loop. While the run sat
  // capped/deferred (or even mid-run), someone else can advance the PR branch — a bot suggestion
  // commit, a human edit, or GitHub's "Update branch" merge. `probe.prHead` (from the Octokit SDK,
  // getPr) is the remote ground truth; the worktree HEAD is local git. If they diverge, our next
  // plain push is rejected non-fast-forward. Bring the checkout up to the remote (fetch + rebase our
  // local work, if any, on top) so the loop pushes cleanly. A rebase CONFLICT is a genuine
  // human-resolve state — abort and refuse rather than clobber or ship a half-rebase.
  let resumeHead = plan.headSha!;
  const localHead =
    spawnSync("git", ["-C", s.worktree, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).stdout?.trim() ?? "";
  if (probe.prHead && probe.prHead !== localHead) {
    console.log(
      `  reconcile: remote advanced (pr-head ${probe.prHead.slice(0, 9)} ≠ local ${localHead.slice(0, 9)}) — syncing worktree`,
    );
    const fetch = spawnSync(
      "git",
      ["-C", s.worktree, "fetch", "origin", s.branch],
      { encoding: "utf8" },
    );
    const rebase = spawnSync(
      "git",
      ["-C", s.worktree, "pull", "--rebase", "origin", s.branch],
      { encoding: "utf8" },
    );
    if (fetch.status !== 0 || rebase.status !== 0) {
      spawnSync("git", ["-C", s.worktree, "rebase", "--abort"], {
        encoding: "utf8",
      });
      console.error(
        `  cannot resume: worktree diverged from the remote and could not rebase cleanly ` +
          `(${(rebase.stderr || fetch.stderr || "").trim().split("\n").pop()}). ` +
          `Resolve the conflict in ${s.worktree} (git pull --rebase origin ${s.branch}), then resume again.`,
      );
      process.exit(2);
    }
    resumeHead =
      spawnSync("git", ["-C", s.worktree, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).stdout?.trim() || probe.prHead;
    console.log(`  reconcile: worktree now at ${resumeHead.slice(0, 9)}`);
  }

  const cfg: CiRoundsConfig = {};
  if (typeof flags["max-rounds"] === "string")
    cfg.maxRounds = Number(flags["max-rounds"]);
  if (typeof flags["poll-timeout-ms"] === "string")
    cfg.pollTimeoutMs = Number(flags["poll-timeout-ms"]);

  // Re-enter the CI-round loop under the run lock, on the SAME journal (a stale lock from the crashed
  // run is stolen — its holder pid is dead). runCiRounds picks up at the recorded round against the
  // existing PR: no re-push, no duplicate PR (that was the whole reason `start` could not resume).
  console.log(
    `\n── resuming autonomous loop at CI round ${s.round} (pr #${plan.pr}) ${"─".repeat(20)}\n`,
  );
  const res = await withLock(runDir, async () => {
    const j = journalOf(runDir);
    j.append({
      event: "run.resume",
      step: s.step,
      round: s.round,
      data: { pr: plan.pr, head_sha: resumeHead },
    });
    projectAndWrite(runDir, j.read().events);
    return runCiRounds({
      gh: seams.gh,
      runDir,
      repo: s.repo,
      branch: s.branch,
      pr: plan.pr!,
      headSha: resumeHead,
      sinceIso: plan.sinceIso!,
      bots: seams.bots,
      triage: reduceTriage(seams.triage),
      apply: seams.apply,
      ciFix: seams.ciFix ? reduceCiFix(seams.ciFix, s.worktree) : undefined,
      testGrade: seams.testGrade
        ? reduceTestGrade(seams.testGrade, s.worktree, base)
        : undefined,
      gate: seams.gate,
      push: seams.pushRound,
      reply: seams.reply,
      cfg,
      startRound: s.round,
    });
  });
  console.log(
    `\ndone: outcome=${res.outcome}  rounds=${res.rounds}  pr=#${plan.pr}`,
  );

  await maybeRunDoctor(
    runDir,
    `${s.repo.replace("/", "-")}-${s.branch}`,
    flags,
  );

  if (res.outcome !== "converged") process.exit(1);
}

/** Ticket derived from a branch slug like `eng-747-patient-age-format` → `ENG-747` (older runs predate
 *  the plan.approved ticket/summary persistence — this is the last-resort fallback after the flag). */
function ticketFromBranch(branch: string): string | undefined {
  const m = branch.match(/^([A-Za-z]+)-(\d+)/);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : undefined;
}

/** A human-ish PR summary derived from the branch slug after the ticket prefix — used only when neither
 *  the journal nor a --summary flag supplies one on a build-stage resume of an older run. */
function summaryFromBranch(branch: string): string {
  const words = branch
    .replace(/^[A-Za-z]+-\d+-?/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!words) return branch;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Build-stage resume: re-enter the build pipeline at the interrupted step and drive it through push →
 *  open-PR → CI, exactly as a fresh `start` would. ticket/summary come from the journal (persisted in
 *  plan.approved) with --ticket/--summary and branch-derivation as fallbacks for runs that predate it. */
async function resumeBuild(
  runDir: string,
  plan: ResumePlan,
  flags: Record<string, string | true>,
): Promise<void> {
  const s = plan.state;
  const { mainRepoPath } = derivePaths(s.branch, flags);
  const base = typeof flags.base === "string" ? flags.base : "develop";
  const buildLess = flags["build-less"] === true;
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;

  const ticket =
    plan.ticket ??
    (typeof flags.ticket === "string" ? flags.ticket : undefined) ??
    ticketFromBranch(s.branch);
  if (!ticket || !/^ENG-\d+$/i.test(ticket)) {
    console.error(
      `  cannot resume: no ticket to reopen the PR with — pass --ticket ENG-### ` +
        `(the plan stage of this run predates ticket persistence).`,
    );
    process.exit(2);
  }
  const summary =
    plan.summary ??
    (typeof flags.summary === "string" ? flags.summary : undefined) ??
    summaryFromBranch(s.branch);

  let prBody =
    typeof flags.body === "string" ? flags.body : `## Changes\n\n${summary}`;
  if (s.tier === "trivial") prBody += `\n\n_Tests skipped — trivial change._`;

  const cfg: CiRoundsConfig = {};
  if (typeof flags["max-rounds"] === "string")
    cfg.maxRounds = Number(flags["max-rounds"]);
  if (typeof flags["poll-timeout-ms"] === "string")
    cfg.pollTimeoutMs = Number(flags["poll-timeout-ms"]);

  const seams = defaultSeams({
    repo: s.repo,
    mainRepoPath,
    worktree: s.worktree,
    branch: s.branch,
    base,
    task: s.task,
    runDir,
    buildLess,
    modelsFile,
  });

  console.log(
    `\n── resuming build at step ${plan.resumeStep} (no PR yet; branch ${s.branch}) ${"─".repeat(12)}\n`,
  );
  console.log(`  PR title will be: [${ticket.toUpperCase()}] ${summary}\n`);

  // runStart re-enters the build half-pipe at plan.resumeStep, then pushes + opens the PR + runs CI.
  // It holds the run lock itself (stealing the crashed run's stale lock — its holder pid is dead).
  const res = await runStart({
    runDir,
    worktree: s.worktree,
    repo: s.repo,
    branch: s.branch,
    base,
    task: s.task,
    ticket: ticket.toUpperCase(),
    summary,
    prBody,
    resumeFrom: plan.resumeStep,
    cfg,
    ...seams,
  });
  console.log(
    `\ndone: phase=${res.phase}  outcome=${res.outcome}${res.pr ? `  pr=#${res.pr}` : ""}`,
  );

  await maybeRunDoctor(
    runDir,
    `${s.repo.replace("/", "-")}-${s.branch}`,
    flags,
  );

  if (res.phase === "ci" && res.outcome !== "converged") process.exit(1);
  if (res.phase !== "ci") process.exit(1);
}

async function cmdPlan(flags: Record<string, string | true>): Promise<void> {
  // The pluggable front sources the input + pairs the terminal gate; the planner is the default
  // opencode Opus skill; runPlan is the invariant core. A different workflow swaps only the front.
  const { input, gate } = await terminalFront(flags).resolve();
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;
  const { planner } = defaultPlanSeams({
    repo: input.repo,
    branch: input.branch,
    runDir: input.runDir,
    modelsFile,
  });
  console.log(
    `care-loopd plan: ${input.repo}  branch=${input.branch}  ticket=${input.ticket}`,
  );
  console.log(`  run dir: ${input.runDir}\n`);

  const res = await runPlan({ input, planner, gate });
  console.log(
    `\nplan: ${res.outcome}  (${res.reasonCode})${res.classification ? `  tier=${res.classification}` : ""}`,
  );
  if (res.outcome === "approved") {
    console.log(
      `  next: care-loopd start --task '${input.task}' --ticket ${input.ticket} --branch ${input.branch} --summary '${input.summary}'`,
    );
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
  const priorEvents = existsSync(journalPath)
    ? journalOf(runDir).read().events
    : [];
  if (!skipPlan && !hasApprovedPlan(priorEvents)) {
    console.error(
      `start: no approved plan in ${runDir} — run \`care-loopd plan …\` first (or pass --skip-plan for a throwaway run).`,
    );
    process.exit(2);
  }

  await startFromInput(
    { task, ticket, branch, summary, repo, mainRepoPath, worktree, runDir },
    flags,
  );
}

/** Run the autonomous loop (build → PR → CI rounds) from a resolved `PlanInput` + the advanced flags.
 *  Shared by `start` (raw flag path) and `run` (post-approval continuation) so neither re-derives the
 *  tier/prBody/seams. Reads the tier from the journal the plan stage wrote. */
async function startFromInput(
  input: PlanInput,
  flags: Record<string, string | true>,
): Promise<void> {
  const {
    task,
    ticket,
    branch,
    summary,
    repo,
    mainRepoPath,
    worktree,
    runDir,
  } = input;
  const base = typeof flags.base === "string" ? flags.base : "develop";
  const buildLess = flags["build-less"] === true;
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;

  // Tier flows plan → start via the projected state. A trivial change notes the test skip in the PR.
  const priorEvents = existsSync(join(runDir, "journal.jsonl"))
    ? journalOf(runDir).read().events
    : [];
  const tier = priorEvents.length ? projectState(priorEvents).tier : "standard";
  let prBody =
    typeof flags.body === "string" ? flags.body : `## Changes\n\n${summary}`;
  if (tier === "trivial") prBody += `\n\n_Tests skipped — trivial change._`;

  const cfg: { maxRounds?: number; pollTimeoutMs?: number } = {};
  if (typeof flags["max-rounds"] === "string")
    cfg.maxRounds = Number(flags["max-rounds"]);
  if (typeof flags["poll-timeout-ms"] === "string")
    cfg.pollTimeoutMs = Number(flags["poll-timeout-ms"]);

  const seams = defaultSeams({
    repo,
    mainRepoPath,
    worktree,
    branch,
    base,
    task,
    runDir,
    buildLess,
    modelsFile,
  });
  console.log(
    `care-loopd start: ${repo}  branch=${branch}  worktree=${worktree}`,
  );
  console.log(
    `  PR title will be: [${ticket}] ${summary}${buildLess ? "   (build-less gate)" : ""}${tier ? `   (tier=${tier})` : ""}\n`,
  );

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
  console.log(
    `\ndone: phase=${res.phase}  outcome=${res.outcome}${res.pr ? `  pr=#${res.pr}` : ""}`,
  );

  await maybeRunDoctor(runDir, `${repo.replace("/", "-")}-${branch}`, flags);

  if (res.phase === "ci" && res.outcome !== "converged") process.exit(1);
}

/** End-of-run self-improvement (default-on; --no-doctor / CARE_DOCTOR=0 to skip). Best-effort — the
 *  doctor swallows its own errors, and a failed loop is exactly when there's most to learn, so this
 *  runs BEFORE any non-converged exit. Shared by every loop-terminating path (`start`/`run` AND
 *  `resume`) so a resumed run gets the same self-improvement pass as a fresh one. */
async function maybeRunDoctor(
  runDir: string,
  runSlug: string,
  flags: Record<string, string | true>,
): Promise<void> {
  const enabled =
    flags["no-doctor"] !== true && process.env.CARE_DOCTOR !== "0";
  if (!enabled) return;
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;
  const r = await runEndOfRunDoctor({
    runDir,
    runSlug,
    modelsFile,
    enabled: true,
  });
  if (r.ran)
    console.log(
      `auto-doctor: ${r.pr ? `${r.draft ? "draft " : ""}PR #${r.pr}` : "report-only"}  applied=[${r.applied.join(",")}]  propose-only=${r.proposeOnly}`,
    );
  else console.log(`auto-doctor: skipped (${r.skipped})`);
}

/** The single entry point: the questionnaire front sources + validates the seed input, `runPlan` drives
 *  recon → interview → consolidated human gate, and on approval we continue STRAIGHT into the autonomous
 *  loop with the SAME input — no re-supplied flags. `hasApprovedPlan` stays the INTERNAL phase boundary
 *  (runPlan just wrote `plan.approved`); it is no longer a CLI boundary. */
async function cmdRun(flags: Record<string, string | true>): Promise<void> {
  const { input, gate } = await terminalFront(flags).resolve();
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;
  const { planner } = defaultPlanSeams({
    repo: input.repo,
    branch: input.branch,
    runDir: input.runDir,
    modelsFile,
  });
  console.log(
    `care-loopd: ${input.repo}  branch=${input.branch}  ticket=${input.ticket}`,
  );
  console.log(`  run dir: ${input.runDir}\n`);

  const plan = await runPlan({ input, planner, gate });
  console.log(
    `\nplan: ${plan.outcome}  (${plan.reasonCode})${plan.classification ? `  tier=${plan.classification}` : ""}`,
  );
  if (plan.outcome !== "approved") process.exit(1);

  console.log(
    `\n── plan approved — starting the autonomous loop ${"─".repeat(28)}\n`,
  );
  await startFromInput(input, flags);
}

/** `care-loopd doctor <run-dir> [--dry] [--models <file>]` — run the end-of-run doctor against an
 *  existing completed run, standalone from the loop. `--dry` = diagnose + apply + verify but NO
 *  branch/commit/PR (the working-tree edits stand for inspection); the Phase-3 smoke path. */
async function cmdDoctor(
  runDir: string,
  flags: Record<string, string | true>,
): Promise<void> {
  if (!existsSync(join(runDir, "journal.jsonl"))) {
    console.error(`no journal at ${runDir} — nothing to diagnose`);
    process.exit(2);
  }
  const dry = flags.dry === true;
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;
  console.log(`care-loopd doctor${dry ? " (dry)" : ""}: ${runDir}\n`);
  const r = await runEndOfRunDoctor({
    runDir,
    runSlug: basename(runDir),
    modelsFile,
    enabled: true,
    dry,
  });
  if (!r.ran) {
    console.log(`\ndoctor: skipped (${r.skipped})`);
    return;
  }
  console.log(
    `\ndoctor${r.dry ? " (dry)" : ""}: ${r.pr ? `${r.draft ? "draft " : ""}PR #${r.pr}` : r.dry ? `would-be ${r.draft === undefined ? "no-op" : r.draft ? "draft" : "ready"}` : "report-only"}`,
  );
  console.log(
    `  applied=[${r.applied.join(",")}]  demoted=[${r.demoted.join(",")}]  propose-only=${r.proposeOnly}`,
  );
  console.log(
    `  fixtures: committed=[${r.fixtures.committed.join(",")}] proposed=[${r.fixtures.proposed.join(",")}]`,
  );
  if (r.verify)
    console.log(
      `  verify: tests=${r.verify.tests} evals=${r.verify.evals}  coherence=${r.coherenceOk}`,
    );
  if (r.dry)
    console.log(
      `\n  (dry run — inspect the working-tree edits with \`git status\` / \`git diff\`)`,
    );
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
    case "dashboard": {
      const df = parseFlags(rest);
      const port = typeof df.port === "string" ? Number(df.port) : 3141;
      const runsDir =
        typeof df["runs-dir"] === "string"
          ? df["runs-dir"]
          : join(__dirname, "../../runs");
      startDashboard(runsDir, port);
      return;
    }
    case "status":
      if (!rest[0]) usage();
      cmdStatus(resolve(rest[0]));
      break;
    case "resume":
      if (!rest[0]) usage();
      await cmdResume(resolve(rest[0]), parseFlags(rest.slice(1)));
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
    case "doctor":
      if (!rest[0]) usage();
      await cmdDoctor(resolve(rest[0]), parseFlags(rest.slice(1)));
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(
    `care-loopd: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
