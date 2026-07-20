// auto-doctor-wiring.ts — the ONE place the real seams for the end-of-run doctor are assembled
// (sibling of default-wiring.ts, kept separate as a distinct concern). Deterministic verbs reuse the
// loop's existing infra: git/tests/evals via shell.runHelper, the PR via the SAME OctokitGitHub SDK
// boundary the loop uses, the coherence check via a read-only judgment spawn, and the edit-enabled
// doctor core via opencode-runner.driveDoctorSpawn. See PLAN-auto-doctor.md.
//
// PR TARGET: the self-improvement PR lands in the SKILLS repo (where the skills live), NOT care_fe —
// so `gh` is an OctokitGitHub pointed at the skills repo's own origin, derived from its git remote.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OctokitGitHub } from "./github.js";
import { runHelper } from "./shell.js";
import { Journal } from "./journal.js";
import { loadModels } from "./models-config.js";
import {
  promptStructured,
  driveDoctorSpawn,
  startEvalServer,
} from "./opencode-runner.js";
import { doctorMethodology, skillsRoot } from "./skill-source.js";
import {
  runAutoDoctor,
  type AutoDoctorSeams,
  type AutoDoctorResult,
  type DoctorOutput,
} from "./auto-doctor.js";

const ORCHESTRATOR_DIR = resolve(skillsRoot, "care-loop/orchestrator");
const EVALS_RUNNER_DIR = resolve(skillsRoot, "care-evals/runner");
const EVALS_TASKS_DIR = resolve(skillsRoot, "care-evals/tasks");
const HELPER_TIMEOUT = 15 * 60 * 1000; // tests/evals can be slow
// The doctor spawn is a large multi-file EDITING session (read the whole run dir + edit skills + write
// the diagnosis/IMPROVEMENTS/coverage/fixtures), NOT a quick judgment call — the 240s judgment default
// starves it mid-Turn-A (dry smoke 2026-07-20: timed out at 240s having written the diagnosis + a
// triager edit but never reaching the Turn-B manifest emit). Give it real headroom.
const DOCTOR_SPAWN_TIMEOUT = 20 * 60 * 1000;

/** Parse `git@github.com:owner/name.git` or `https://github.com/owner/name(.git)` → "owner/name". */
export function parseRemoteSlug(url: string): string | null {
  const m = url
    .trim()
    .match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function skillsRepoSlug(): string | null {
  const r = runHelper({
    cmd: "git",
    args: ["-C", skillsRoot, "remote", "get-url", "origin"],
    logPath: join(skillsRoot, ".git", "auto-doctor-remote.log"),
  });
  return r.exit === 0 ? parseRemoteSlug(r.summary) : null;
}

/** Expand care-evals task prefixes (e.g. ["ux","cr"]) → concrete task-dir names for run_eval.py. */
function tasksForPrefixes(prefixes: string[]): string[] {
  if (!prefixes.length || !existsSync(EVALS_TASKS_DIR)) return [];
  const all = readdirSync(EVALS_TASKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  return all.filter((t) => prefixes.some((p) => t.startsWith(`${p}-`)));
}

// JSON schema for the doctor's structured emit (mirrors DoctorOutput in auto-doctor.ts).
const DOCTOR_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings", "skillEdits", "proposeOnly", "fixtures", "coverageDelta", "reportBody"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["imp", "dimension", "sensorType", "summary", "reObserved", "seen", "regression"],
        properties: {
          imp: { type: "string" },
          dimension: { type: "number" },
          sensorType: { type: "string", enum: ["computational", "inferential", "none"] },
          bsRow: { type: "string" },
          summary: { type: "string" },
          reObserved: { type: "boolean" },
          seen: { type: "number" },
          regression: { type: "boolean" },
        },
      },
    },
    skillEdits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["skill", "files", "note"],
        properties: {
          skill: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          note: { type: "string" },
        },
      },
    },
    proposeOnly: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "reason", "patch"],
        properties: {
          target: { type: "string" },
          reason: {
            type: "string",
            enum: ["orchestrator-code", "no-eval-coverage", "unrecurred-fixture", "coherence"],
          },
          patch: { type: "string" },
        },
      },
    },
    fixtures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "skill", "kind", "recurred"],
        properties: {
          name: { type: "string" },
          skill: { type: "string" },
          kind: { type: "string", enum: ["verbatim", "class-sibling"] },
          recurred: { type: "boolean" },
        },
      },
    },
    coverageDelta: {
      type: "object",
      additionalProperties: false,
      required: ["green", "yellow", "red"],
      properties: {
        green: { type: "number" },
        yellow: { type: "number" },
        red: { type: "number" },
      },
    },
    reportBody: { type: "string" },
  },
} as const;

const COHERENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: { ok: { type: "boolean" }, note: { type: "string" } },
} as const;

export interface AutoDoctorWiringConfig {
  runDir: string;
  runSlug: string; // repo-branch slug for the branch name
  base?: string; // base branch for the self-improve PR (default "main")
  modelsFile?: string;
  enabled: boolean; // false ⇒ --no-doctor / CARE_DOCTOR=0
  dry?: boolean; // Phase-3 smoke: apply + verify, no branch/commit/PR
}

/** Read event names from the run journal (best-effort — a torn tail is fine, we only need names). */
function readJournalEvents(runDir: string): { event: string }[] {
  const path = join(runDir, "journal.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [{ event: (JSON.parse(line) as { event: string }).event }];
      } catch {
        return [];
      }
    });
}

/** Build the real seams + options and run the end-of-run doctor. The single entrypoint cli.ts calls. */
export async function runEndOfRunDoctor(
  cfg: AutoDoctorWiringConfig,
): Promise<AutoDoctorResult> {
  const models = loadModels(cfg.modelsFile);
  const provider = models.provider ?? "github-copilot";
  const model = models.reviewer ?? "claude-opus-4.8"; // opus judgment tier for the diagnosis
  const base = cfg.base ?? "main";
  const doctorLogDir = join(cfg.runDir, "doctor");

  const slug = skillsRepoSlug();
  const gh = slug ? new OctokitGitHub({ owner: slug.split("/")[0], name: slug.split("/")[1] }) : null;

  const j = new Journal(join(cfg.runDir, "journal.jsonl"), cfg.runSlug);

  const git = {
    checkoutNewBranch: (name: string) => {
      runHelper({ cmd: "git", args: ["-C", skillsRoot, "checkout", "-b", name], logPath: join(doctorLogDir, "git-branch.log") });
    },
    revertFile: (p: string) => {
      runHelper({ cmd: "git", args: ["-C", skillsRoot, "checkout", "--", p], logPath: join(doctorLogDir, "git-revert.log") });
    },
    changedFiles: (): string[] => {
      const r = runHelper({ cmd: "git", args: ["-C", skillsRoot, "status", "--porcelain"], logPath: join(doctorLogDir, "git-status.log") });
      return readFileSync(r.logPath, "utf8").split("\n").filter(Boolean).map((l) => l.slice(3));
    },
    commitAll: (message: string): string => {
      runHelper({ cmd: "git", args: ["-C", skillsRoot, "add", "-A"], logPath: join(doctorLogDir, "git-add.log") });
      runHelper({ cmd: "git", args: ["-C", skillsRoot, "commit", "-m", message], logPath: join(doctorLogDir, "git-commit.log") });
      const r = runHelper({ cmd: "git", args: ["-C", skillsRoot, "rev-parse", "HEAD"], logPath: join(doctorLogDir, "git-sha.log") });
      return r.summary.trim();
    },
  };

  const seams: AutoDoctorSeams = {
    git,
    append: (ev) => j.append(ev),
    now: () => new Date(),

    spawnDoctor: async ({ runDir, repoRoot }): Promise<DoctorOutput> => {
      const skill = doctorMethodology();
      const editSystem =
        `${skill}\n\n---\n\nYou are running in AUTONOMOUS END-OF-RUN MODE. The skills repo root is ` +
        `${repoRoot}. Read the loopd run at ${runDir}, then APPLY the eval-covered skill edits + write ` +
        `the diagnosis / IMPROVEMENTS / HARNESS-COVERAGE updates + any fixtures IN PLACE (edit the files). ` +
        `Do NOT run git, gh, npm, or the evals — the orchestrator does that. Propose-only items are text, not edits.`;
      const emitSystem =
        `Emit the DoctorOutput manifest describing EXACTLY what you just did, as JSON matching the schema. ` +
        `Do not explore or edit further.`;
      const out = await driveDoctorSpawn(
        {
          providerID: provider,
          modelID: model,
          editSystem,
          editInstruction: `Diagnose the run at ${runDir} and apply the covered-skill improvements now.`,
          emitSystem,
          emitInstruction: "Emit the DoctorOutput manifest for the changes you made.",
          timeoutMs: DOCTOR_SPAWN_TIMEOUT,
        },
        DOCTOR_OUTPUT_SCHEMA,
      );
      return out.data as DoctorOutput;
    },

    runTests: async () => {
      const r = runHelper({
        cmd: "npm",
        args: ["test"],
        cwd: ORCHESTRATOR_DIR,
        logPath: join(doctorLogDir, "npm-test.log"),
        summaryMatch: /# (pass|fail) \d+/,
        timeoutMs: HELPER_TIMEOUT,
      });
      return { ok: r.exit === 0, output: r.summary };
    },

    runEvals: async (prefixes: string[]) => {
      const tasks = tasksForPrefixes(prefixes);
      if (!tasks.length) return { ok: true, output: "no affected eval tasks" };
      // care-evals `--adapter opencode` talks to a warm serve at $OPENCODE_SERVER_URL — stand one up
      // (reusing the orchestrator's embedded-server infra) around the sweep, else every task returns
      // "connection refused" (smoke 2026-07-20 Bug C). Torn down in finally.
      const server = await startEvalServer();
      try {
        const r = runHelper({
          cmd: "python3",
          args: ["run_eval.py", tasks.join(","), "--adapter", "opencode", "--model", `${provider}/${model}`],
          cwd: EVALS_RUNNER_DIR,
          env: { ...process.env, OPENCODE_SERVER_URL: server.url },
          logPath: join(doctorLogDir, "evals.log"),
          summaryMatch: /Valid JobResults|PASS|FAIL/,
          timeoutMs: HELPER_TIMEOUT,
        });
        return { ok: r.exit === 0, output: r.summary };
      } finally {
        await server.close();
      }
    },

    coherenceCheck: async (skills: string[]) => {
      // Pre-read the edited skills (deterministic) and ask a read-only judgment spawn whether any edit
      // contradicts a sibling or a known sensor. Inlined (not agentic) so the format turn stays reliable.
      const bodies = skills
        .map((s) => {
          const p = resolve(skillsRoot, `${s}/SKILL.md`);
          return existsSync(p) ? `<skill name="${s}">\n${readFileSync(p, "utf8")}\n</skill>` : "";
        })
        .filter(Boolean)
        .join("\n\n");
      const res = await promptStructured(
        {
          role: "doctor-coherence",
          providerID: provider,
          modelID: model,
          system:
            "You check care-loop skill coherence. Given edited SKILL.md files, decide if any guidance " +
            "now CONTRADICTS a sibling skill or weakens a stated sensor/gate. Return {ok:false,note} on a " +
            "real contradiction, else {ok:true}.",
          task: bodies,
          round: 0,
          // The judgment default (240s) starved this on a large inlined skill (smoke 2026-07-20 timed
          // out here right after doctor.apply). It inlines the files (no exploration) but still reasons
          // over big prose — give it headroom.
          timeoutMs: DOCTOR_SPAWN_TIMEOUT,
        },
        COHERENCE_SCHEMA,
      );
      const data = res.data as { ok: boolean; note?: string };
      return { ok: data.ok, note: data.note };
    },

    gh: {
      createPr: async (o) => {
        if (!gh) throw new Error("auto-doctor: no skills-repo GitHub remote — cannot open PR");
        return gh.createPr({ head: o.branch, base, title: o.title, body: o.body, draft: o.draft });
      },
    },
  };

  return runAutoDoctor(
    {
      runDir: cfg.runDir,
      repoRoot: skillsRoot,
      runSlug: cfg.runSlug,
      enabled: cfg.enabled,
      dry: cfg.dry,
      journalEvents: readJournalEvents(cfg.runDir),
    },
    seams,
  );
}
