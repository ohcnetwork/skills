// shell.ts — the bash-helper subprocess seam (PLAN-orchestrator-architecture §9, "shell.py"
// equivalent). Every care-loop helper (run_gate.sh, git worktree, …) is invoked here:
// run one command, tee combined output to a log, and hand back ONE compact summary line + the exit
// code. The FSM never sees raw output — only (exit, summary), the §3 "helper exit + parsed summary"
// input class. Reused verbatim from the existing skill (the guides call these unchanged).

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HelperResult {
  cmd: string;
  args: string[];
  exit: number;
  summary: string; // one line — a matched signal line, else the last non-empty line
  logPath: string; // full combined output for the doctor / debugging
}

export interface HelperOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  logPath: string;
  env?: NodeJS.ProcessEnv;
  /** Prefer the last line matching this pattern as the summary (e.g. /ALL PASSED|FAIL/). */
  summaryMatch?: RegExp;
  /** Hard wall-clock cap for the helper (ms). */
  timeoutMs?: number;
}

const HOMEBREW_PATH = "/opt/homebrew/bin:/usr/local/bin";

export function runHelper(opts: HelperOptions): HelperResult {
  const args = opts.args ?? [];
  const env = {
    ...(opts.env ?? process.env),
    // Copilot's integrated terminal lacks brew on PATH (hosts.md); the bundled scripts prepend it
    // themselves, but a bare `git`/`gh` invoked here needs it too.
    PATH: `${HOMEBREW_PATH}:${(opts.env ?? process.env).PATH ?? ""}`,
  };

  const r = spawnSync(opts.cmd, args, {
    cwd: opts.cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: opts.timeoutMs,
  });

  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  mkdirSync(dirname(opts.logPath), { recursive: true });
  writeFileSync(opts.logPath, out);

  // spawnSync: status null + error set (spawn failure) → 127; status null + signal (timeout) → 124.
  let exit: number;
  if (typeof r.status === "number") exit = r.status;
  else if (r.signal) exit = 124;
  else exit = r.error ? 127 : 0;

  const lines = out
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  let summary = lines.length ? lines[lines.length - 1] : "";
  if (opts.summaryMatch) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (opts.summaryMatch.test(lines[i])) {
        summary = lines[i];
        break;
      }
    }
  }

  return { cmd: opts.cmd, args, exit, summary, logPath: opts.logPath };
}
