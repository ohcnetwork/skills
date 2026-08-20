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
import type { TicketFetcher } from "./ports.js";
import {
  enrichPlanInput,
  jiraConfigFromEnv,
  jiraTicketFetcher,
} from "./ticket-fetch.js";
import { defaultSeams, defaultPlanSeams } from "./default-wiring.js";
import { runEndOfRunDoctor } from "./auto-doctor-wiring.js";
import { OctokitGitHub } from "./github.js";
import { loadModels } from "./models-config.js";
import { symlinkProvisioner } from "./provision.js";
import { adoptPr } from "./adopt.js";
import { salvageGate } from "./salvage-gate-terminal.js";
import { opencodeIntentReconstructor } from "./skills-opencode.js";
import { openRunStore, setActiveRunStore, SqliteRunStore } from "./run-store.js";
import { reindexRuns } from "./reindex.js";
import { resolveRunId } from "./run-context.js";
import { startService } from "./service/serve.js";

const RUNS_ROOT = join(__dirname, "../../runs");
const DB_PATH = join(RUNS_ROOT, "loops.db");

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
              --requested-by <github-login> (or CARE_REQUESTED_BY; attribution only, never authz)
       (end-of-run self-improvement runs by default; --no-doctor or CARE_DOCTOR=0 to skip)

  care-loopd --pr <n> [flags]    SALVAGE an existing PR instead of planning a new change: reconstruct
       its intent from the diff (blind — the description is not fed to the model), confirm it at the one
       human gate (with a description-vs-diff divergence check), synthesize the run dir, then enter the
       CI-round loop (address bot reviews → push → wait → repeat). Re-invoke after CI re-reviews.
       flags: --repo · --main · --worktree · --run-dir · --models · --max-rounds <n> (1 = one-shot)

  care-loopd serve [flags]       HTTP API + web app over loops.db (PLAN-loop-service §6). DB-only: no
       route touches a run dir. Serves ../web/dist when built, so the app and the API share one origin.
       Writes only service-owned tables (users/sessions); run rows stay the owning child's. Binds
       loopback unless --host says otherwise — there is no authentication, the login is a claim, and
       the trust boundary is the network.
       flags: --port <n> (default 3142) · --db <path> (default ../runs/loops.db) · --host <addr>
              --secure-cookies (set once TLS terminates in front) · --static <dir> · --repos a/b,c/d
              --backup-dir <path> · --backup-keep <n>

  care-loopd reindex [flags]     Rebuild runs/loops.db from every run dir's journal.jsonl — the SQLite
       fleet projection that serve and status read (PLAN-sqlite-run-store.md). It clears and rebuilds
       ONLY from the journals. REFUSES while any run looks live, because the rebuild deletes run_events
       out from under a running child and kills it — wait, or --force if you are sure.
       flags: --runs-dir <path> (default ../runs) · --force

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
  // resolveRunId (not a placeholder string): read() is DB-backed now (§10) and queries by run_id,
  // so the CLI needs the run's actual ULID, not an arbitrary label.
  return new Journal(join(runDir, "journal.jsonl"), resolveRunId(runDir));
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

/** Build the ticket fetcher from env (Jira), unless the operator opted out with `--no-ticket-fetch`.
 *  Unconfigured env ⇒ undefined ⇒ enrichment is a no-op (planner runs on the raw kickoff task). */
function ticketFetcherFromEnv(
  flags: Record<string, string | true>,
): TicketFetcher | undefined {
  if (flags["no-ticket-fetch"] === true) return undefined;
  const cfg = jiraConfigFromEnv();
  return cfg ? jiraTicketFetcher(cfg) : undefined;
}

async function cmdPlan(flags: Record<string, string | true>): Promise<void> {
  // The pluggable front sources the input + pairs the terminal gate; the planner is the default
  // opencode Opus skill; runPlan is the invariant core. A different workflow swaps only the front.
  const { input: seed, gate } = await terminalFront(flags).resolve();
  // Pre-Step-1 enrichment: fold the Jira ticket (text + image attachments) into the planner input,
  // cached under runDir + resume-safe; a no-op when no fetcher is configured (PLAN-jira-ticket-fetch).
  const input = await enrichPlanInput(seed, ticketFetcherFromEnv(flags));
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
/** Ensure a worktree exists on the PR branch at the remote head. Fresh checkout for salvage (adopt),
 *  provisioned with the generated-artifact symlinks the gate/build need. If the worktree already
 *  exists it is left as-is — cmdResume's reconcile (fetch + rebase) brings it to the remote head. */
function ensureSalvageWorktree(
  mainRepoPath: string,
  worktree: string,
  branch: string,
): void {
  if (existsSync(worktree)) return; // cmdResume reconciles an existing checkout
  const g = (...a: string[]) =>
    spawnSync("git", ["-C", mainRepoPath, ...a], { encoding: "utf8" });
  g("fetch", "origin", branch);
  const add = g("worktree", "add", "-B", branch, worktree, `origin/${branch}`);
  if (add.status !== 0)
    throw new Error(
      `git worktree add failed for ${branch}: ${(add.stderr || "").trim()}`,
    );
  const prov = symlinkProvisioner()({ worktree, mainRepoPath });
  if (prov.exit !== 0) console.error(`  provision warning: ${prov.summary}`);
}

/** `care-loopd --pr <n>` — salvage an existing PR: reconstruct its intent from the diff, confirm it
 *  at the one human gate, synthesize the run dir, then hand off to the CI-round loop (PLAN-pr-salvage).
 *  The adopted journal projects to mode "ci", so the handoff is literally `cmdResume`. */
async function cmdSalvage(
  prNum: number,
  flags: Record<string, string | true>,
): Promise<void> {
  const repo = typeof flags.repo === "string" ? flags.repo : "ohcnetwork/care_fe";
  const [owner, name] = repo.split("/");
  const gh = new OctokitGitHub({ owner, name });
  const prInfo = await gh.getPr(prNum);
  if (prInfo.state !== "open") {
    console.error(`PR #${prNum} is ${prInfo.state} — nothing to salvage`);
    process.exit(2);
  }
  const branch = prInfo.headRef;
  const base =
    prInfo.baseRef || (typeof flags.base === "string" ? flags.base : "develop");
  const { mainRepoPath, worktree, runDir } = derivePaths(branch, flags);
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;
  const models = loadModels(modelsFile);

  console.log(`care-loopd salvage: PR #${prNum} (${repo})`);
  console.log(`  branch=${branch}  base=${base}`);
  console.log(`  worktree=${worktree}\n  run dir=${runDir}\n`);

  ensureSalvageWorktree(mainRepoPath, worktree, branch);

  const res = await adoptPr({
    gh,
    pr: prNum,
    repo,
    runDir,
    worktree,
    // Head-vs-base diff from the checked-out worktree. NOT handed the PR body (§3.1 blindness).
    diffProvider: async () =>
      spawnSync("git", ["-C", worktree, "diff", `origin/${base}...HEAD`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }).stdout ?? "",
    reconstruct: opencodeIntentReconstructor(models, worktree, runDir),
    gate: salvageGate(),
    reconstructedBy: `care-intent (${models.plannerRecon ?? "maker"})`,
  });

  if (!res.approved) {
    console.log(`\nsalvage: rejected at gate — nothing adopted`);
    process.exit(1);
  }
  console.log(
    `\n── adopted PR #${prNum} — entering the CI-round loop ${"─".repeat(24)}\n`,
  );
  // The adopted run dir IS a valid mode:"ci" resume — reuse the whole resume path (probe, reconcile,
  // lock, runCiRounds) with zero duplication.
  await cmdResume(runDir, flags);
}

async function cmdRun(flags: Record<string, string | true>): Promise<void> {
  // `--pr <n>` salvages an existing PR instead of planning a new change.
  if (flags.pr !== undefined && flags.pr !== true) {
    const pr = Number(flags.pr);
    if (!Number.isInteger(pr) || pr <= 0) {
      console.error(`--pr must be a positive integer, got ${String(flags.pr)}`);
      process.exit(2);
    }
    await cmdSalvage(pr, flags);
    return;
  }
  const { input: seed, gate } = await terminalFront(flags).resolve();
  const input = await enrichPlanInput(seed, ticketFetcherFromEnv(flags));
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

/** `care-loopd doctor <run-dir> [--dry|--report] [--models <file>]` — run the end-of-run doctor against
 *  an existing completed run, standalone from the loop. `--dry` = diagnose + apply + verify but NO
 *  branch/commit/PR (working-tree edits stand for inspection); the Phase-3 smoke path. `--report` =
 *  diagnose only and write ONE proposal doc to `care-loop-doctor/proposals/`, editing nothing else —
 *  meant to be run across many runs so the proposals can be collated. `--report` wins over `--dry`. */
async function cmdDoctor(
  runDir: string,
  flags: Record<string, string | true>,
): Promise<void> {
  if (!existsSync(join(runDir, "journal.jsonl"))) {
    console.error(`no journal at ${runDir} — nothing to diagnose`);
    process.exit(2);
  }
  const report = flags.report === true;
  const dry = flags.dry === true;
  const modelsFile =
    typeof flags.models === "string" ? flags.models : undefined;
  const mode = report ? " (report)" : dry ? " (dry)" : "";
  console.log(`care-loopd doctor${mode}: ${runDir}\n`);
  const r = await runEndOfRunDoctor({
    runDir,
    runSlug: basename(runDir),
    modelsFile,
    enabled: true,
    dry,
    report,
  });
  if (!r.ran) {
    console.log(`\ndoctor: skipped (${r.skipped})`);
    return;
  }
  if (r.report) {
    console.log(`\ndoctor (report): wrote ${r.reportPath}`);
    console.log(`  propose-only=${r.proposeOnly}`);
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
  // The DB is the source of truth now (PLAN-sqlite-run-store.md §2/§10) — every command opens it
  // unconditionally; `openRunStore` is fatal if `DB_PATH` can't be reached (no `--no-db` opt-out any
  // more, §10 item 5: a run that can't reach the DB can no longer resume or project state).
  setActiveRunStore(openRunStore(DB_PATH));
  // `--requested-by <login>` is sugar over CARE_REQUESTED_BY, which is the single channel the four
  // seed sites read (run-context.ts#resolveRequestedBy). The loop-service supervisor sets the env var
  // per child instead; the flag exists so a local run can attribute itself without exporting anything.
  // Parsed off the RAW argv so it works before the subcommand switch, on every command alike.
  const rb = parseFlags(argv)["requested-by"]; // parseFlags already skips non-flag tokens
  if (typeof rb === "string" && rb.trim()) process.env.CARE_REQUESTED_BY = rb.trim();
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
    case "serve": {
      const sf = parseFlags(rest);
      const port = typeof sf.port === "string" ? Number.parseInt(sf.port, 10) : 3142;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`serve: --port must be 1-65535, got '${String(sf.port)}'`);
        process.exit(2);
      }
      startService({
        dbPath: typeof sf.db === "string" ? resolve(sf.db) : DB_PATH,
        port,
        host: typeof sf.host === "string" ? sf.host : undefined,
        // Reachable configuration: these existed on ServeOptions but nothing could set them, which
        // would have been discovered at deploy — `--secure-cookies` in particular is what
        // PLAN-loop-service §6 tells you to turn on once TLS terminates in front.
        secureCookies: sf["secure-cookies"] === true,
        staticDir: typeof sf.static === "string" ? resolve(sf.static) : undefined,
        backupDir: typeof sf["backup-dir"] === "string" ? resolve(sf["backup-dir"]) : undefined,
        backupKeep:
          typeof sf["backup-keep"] === "string" ? Number.parseInt(sf["backup-keep"], 10) : undefined,
        allowedRepos:
          typeof sf.repos === "string" ? sf.repos.split(",").map((r) => r.trim()).filter(Boolean) : undefined,
      });
      break;
    }
    case "reindex": {
      const df = parseFlags(rest);
      const runsDir =
        typeof df["runs-dir"] === "string" ? resolve(df["runs-dir"]) : RUNS_ROOT;
      const dbPath = join(runsDir, "loops.db");
      const store = new SqliteRunStore(dbPath);
      const result = reindexRuns(store, runsDir, { force: df.force === true });
      store.close();
      console.log(
        `reindex: ${result.runsIndexed} run(s), ${result.artifactsIndexed} artifact(s) indexed` +
          (result.runsSkipped.length ? `, ${result.runsSkipped.length} skipped` : ""),
      );
      for (const s of result.runsSkipped)
        console.log(`  skipped ${s.slug}: ${s.error}`);
      break;
    }
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
