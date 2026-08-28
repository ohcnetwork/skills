// front-terminal.ts — the terminal `PlanFront`: source the initial `PlanInput` and pair the readline
// `terminalGate`. Input sourcing is a DETERMINISTIC questionnaire: each required field is taken from a
// CLI flag if present, otherwise the human is prompted for it (with a validator). Flags therefore act
// as a non-interactive override — a bot/CI supplies them and is never prompted; a human runs bare and
// answers each question. The natural-language surface lives in ONE place downstream (the planner's
// interview), so the seed fields stay reproducible and validated at the input boundary. This is the
// input-source half of the "pluggable front"; a Jira/PR front would resolve input from a ticket/PR
// event instead. The derived `runDir` / `worktree` use the SAME (repo, branch) convention as `start`.

import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { stdin as processStdin, stdout as processStdout } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanFront, PlanInput } from "./plan-front.js";
import { terminalGate } from "./gate-terminal.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../.."); // care-loop/

type Flags = Record<string, string | true>;

/** One required seed field: prompted when its flag is absent, then normalized + validated. */
interface FieldSpec {
  key: string;
  prompt: string;
  normalize?: (v: string) => string;
  /** Return an error message when invalid, or null when the value is acceptable. */
  validate?: (v: string) => string | null;
}

const REQUIRED_FIELDS: FieldSpec[] = [
  { key: "task", prompt: "Task — what should change?", validate: (v) => (v ? null : "task cannot be empty") },
  {
    key: "ticket",
    prompt: "Engineering ticket (ENG-###)",
    normalize: (v) => v.toUpperCase(),
    validate: (v) => (/^ENG-\d+$/.test(v) ? null : "ticket must look like ENG-123 (it becomes the [ENG-###] PR title)"),
  },
  {
    key: "branch",
    prompt: "Branch name",
    validate: (v) => {
      if (!v) return "branch cannot be empty";
      if (/\s/.test(v)) return "branch cannot contain whitespace";
      if (v.startsWith("-") || v.startsWith("/") || v.endsWith("/")) return "branch cannot start with '-' or '/' or end with '/'";
      if (v.includes("..")) return "branch cannot contain '..'";
      if (!/^[A-Za-z0-9._/-]+$/.test(v)) return "branch may only contain letters, digits, and . _ / -";
      return null;
    },
  },
  { key: "summary", prompt: "One-line PR summary", validate: (v) => (v ? null : "summary cannot be empty") },
];

export interface DerivedPaths {
  repo: string; // owner/name
  mainRepoPath: string;
  worktree: string;
  runDir: string;
}

/** The (repo, main checkout, worktree, run dir) convention, derived from a branch + optional overrides.
 *  Shared by the terminal front (`plan`/`run`) and `cmdStart` so both stages resolve to the SAME run dir
 *  + worktree for a given branch — the single source of the convention, so it can't drift between them. */
export function derivePaths(branch: string, flags: Flags): DerivedPaths {
  const repo = typeof flags.repo === "string" ? flags.repo : "ohcnetwork/care_fe";
  const name = repo.split("/")[1];
  const slug = `${name}-${branch.replace(/\//g, "-")}`;
  const mainRepoPath = typeof flags.main === "string" ? flags.main : join(homedir(), "Desktop/care_fe");
  const worktree = typeof flags.worktree === "string" ? flags.worktree : join(homedir(), `Desktop/${slug}`);
  const runDir = typeof flags["run-dir"] === "string" ? flags["run-dir"] : join(SKILL_DIR, "runs", slug);
  return { repo, mainRepoPath, worktree, runDir };
}

/** Normalize then validate one seed field by key. Pure (no I/O) so the validators — which feed the
 *  hard `[ENG-###]` PR-title assert and `git worktree add` — are unit-testable in isolation. */
export function validateSeed(key: string, raw: string): { value: string } | { error: string } {
  const f = REQUIRED_FIELDS.find((x) => x.key === key);
  if (!f) return { error: `unknown field '${key}'` };
  const value = f.normalize ? f.normalize(raw.trim()) : raw.trim();
  const err = f.validate ? f.validate(value) : null;
  return err ? { error: err } : { value };
}

/** Resolve the four required seed fields: flag-if-present, else prompt (validated). A flag value is
 *  validated too, so a bad --ticket fails at input, not at the downstream createPr throw. In a non-TTY
 *  session a missing field is a hard error rather than a hang — the flag path is the machine contract. */
async function sourceRequiredFields(flags: Flags): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of REQUIRED_FIELDS) {
    if (typeof flags[f.key] !== "string") continue;
    const r = validateSeed(f.key, flags[f.key] as string);
    if ("error" in r) {
      console.error(`plan: --${f.key} is invalid: ${r.error}`);
      process.exit(2);
    }
    out[f.key] = r.value;
  }

  const missing = REQUIRED_FIELDS.filter((f) => out[f.key] === undefined);
  if (missing.length === 0) return out;

  if (!processStdin.isTTY) {
    for (const f of missing) console.error(`plan: --${f.key} <value> is required (non-interactive session — supply it as a flag)`);
    process.exit(2);
  }

  const rl = createInterface({ input: processStdin, output: processStdout, terminal: false });
  try {
    processStdout.write(`\n── care-loopd — new run ${"─".repeat(46)}\n`);
    for (const f of missing) {
      for (;;) {
        const r = validateSeed(f.key, await rl.question(`\n${f.prompt}\n> `));
        if ("value" in r) {
          out[f.key] = r.value;
          break;
        }
        processStdout.write(`  ✗ ${r.error}\n`);
      }
    }
  } finally {
    rl.close();
  }
  return out;
}

/** Build a terminal front from parsed CLI flags. `--task --ticket --branch --summary` are prompted for
 *  when absent (validated); `--repo --main --worktree --run-dir` mirror `start`'s defaults so the two
 *  stages share a run dir. */
export function terminalFront(flags: Flags): PlanFront {
  return {
    async resolve() {
      const { task, ticket, branch, summary } = await sourceRequiredFields(flags);
      const { repo, mainRepoPath, worktree, runDir } = derivePaths(branch, flags);

      const input: PlanInput = { task, ticket, branch, summary, repo, mainRepoPath, worktree, runDir };
      return { input, gate: terminalGate() };
    },
  };
}
