// pipeline.ts — the Phase-3 half-pipe driver (PLAN-orchestrator-architecture §10 phase 3):
// deterministic control flow over mixed agent/helper inputs for steps 2→3→4a→5 on a scratch
// branch (no PR). It wires the pure FSM (fsm.ts) to the journal (journal.ts) + state projection
// (state.ts) and delegates the two side-effecting seams — agent spawns and bash helpers — through
// INJECTED functions, so the exact same control flow can be exercised with fakes (deterministic
// test) or with the real opencode runner + shell (a live scratch run). No LLM in the loop itself.

import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Journal } from "./journal.js";
import { projectAndWrite, type CareState, type Step } from "./state.js";
import { transition, type FsmConfig } from "./fsm.js";
import {
  classifyJob,
  roleForStep,
  type Role,
  type Signal,
  type TerminalState,
} from "./roles.js";
import { renderLoopLog } from "./render.js";

/** What an injected agent spawn must return (a JobResult digest — §3). */
export interface SpawnResult {
  terminal_state: TerminalState;
  verdict: string;
  reason_code: string;
  model_used?: string;
  head_sha?: string; // implementer/commit may report the new head
  timedOut?: boolean; // maker only: the spawn hit its wall-clock cap (transient — own retry budget)
  /** Judgment roles only: a compact text digest of the blocking findings, fed back to the maker as
   *  re-implement context on a loopback so the fix is targeted, not blind (matches the inner-gate
   *  `lastImplementContext` mechanism). Empty/absent for a pass. */
  findingsDigest?: string;
}
export type SpawnFn = (input: {
  role: Role;
  step: Step;
  round: number;
  runDir: string;
  context?: string;
}) => Promise<SpawnResult>;

/** What an injected helper must return (an exit code + parsed summary — §3). */
export interface HelperOutcome {
  exit: number;
  summary: string;
  logPath: string;
  head_sha?: string;
}
export type HelperFn = (input: {
  name: string;
  step: Step;
  runDir: string;
  worktree: string;
}) => HelperOutcome;

export interface HalfPipeOptions {
  runDir: string;
  worktree: string;
  task: string;
  repo: string; // owner/name
  branch: string;
  spawn: SpawnFn;
  helper: HelperFn;
  cfg?: FsmConfig;
  /** Stop once this step completes successfully (half-pipe target). Default "5". */
  stopAfter?: Step;
  /** When false, skip the run.end on success so a composing orchestrator can continue the same
   *  journal into later phases (CI rounds). Default true (standalone half-pipe finalizes). */
  finalize?: boolean;
}

export interface HalfPipeResult {
  state: CareState;
  visited: Step[];
  outcome: "complete" | "aborted";
}

const MAX_STEPS = 50; // hard loop guard — an unbounded pipe is a bug, not a wait.

export async function runHalfPipe(o: HalfPipeOptions): Promise<HalfPipeResult> {
  const cfg = o.cfg ?? { reviewSteps: ["4a"], maxImplementRetries: 2 };
  const maxTimeouts = cfg.maxImplementTimeouts ?? 2;
  const stopAfter = o.stopAfter ?? "5";
  const runId = `${o.repo.replace("/", "-")}-${o.branch}`;
  const j = new Journal(join(o.runDir, "journal.jsonl"), runId);

  const seed: CareState = {
    task: o.task,
    repo: o.repo,
    branch: o.branch,
    worktree: o.worktree,
    tier: "standard",
    pr: null,
    round: 1,
    step: "2", // half-pipe starts at setup (post plan-gate)
    head_sha: "scratch",
    last_reviewed_sha: "",
    updated_at: new Date().toISOString(), // projection refreshes this from each event ts
  };
  // Seed run.start ONLY when the journal is empty. When `plan` (plan.ts) already ran, it seeded
  // run.start@step1 + plan.approved into this same journal; re-seeding would fork the projection.
  // A standalone/`--skip-plan` run has an empty journal here and seeds as before.
  if (j.read().events.length === 0) {
    j.append({
      event: "run.start",
      step: "2",
      round: 1,
      data: { state: seed },
    });
  }

  let step: Step = "2";
  const round = 1;
  const visited: Step[] = [];
  let implementAttempt = 0; // genuine implement attempts (a broken change); NOT bumped by timeouts
  let timeoutRetries = 0; // maker wall-clock timeouts — their own budget
  let lastImplementContext: string | undefined; // gate errors fed back to the re-implement
  let outcome: "complete" | "aborted" = "aborted";

  for (let guard = 0; guard < MAX_STEPS; guard++) {
    visited.push(step);
    j.append({ event: "step.enter", step, round });
    let signal: Signal;

    if (step === "2") {
      const h = o.helper({
        name: "setup-worktree",
        step,
        runDir: o.runDir,
        worktree: o.worktree,
      });
      j.append({
        event: "helper.exec",
        step,
        data: {
          cmd: "git worktree add",
          exit: h.exit,
          summary: h.summary,
          log: h.logPath,
        },
      });
      signal = h.exit === 0 ? "helper-ok" : "helper-fail";
    } else if (step === "3") {
      const jr = await o.spawn({
        role: "implementer",
        step,
        round,
        runDir: o.runDir,
        context: lastImplementContext,
      });
      j.append({
        event: "spawn.result",
        step,
        data: {
          role: "implementer",
          verdict: jr.verdict,
          reason_code: jr.reason_code,
          terminal_state: jr.terminal_state,
          model: jr.model_used,
        },
      });
      if (jr.terminal_state === "done") {
        // inner gate (type/lint only, -n) gates the maker's output before review
        const g = o.helper({
          name: "gate-inner",
          step,
          runDir: o.runDir,
          worktree: o.worktree,
        });
        j.append({
          event: "helper.exec",
          step,
          data: {
            cmd: "run_gate.sh -n",
            exit: g.exit,
            summary: g.summary,
            log: g.logPath,
          },
        });
        if (g.exit === 0) {
          signal = "advance";
        } else {
          // a broken change consumes a genuine retry AND feeds the gate error back to the re-implement
          implementAttempt++;
          lastImplementContext = `Your previous change did not pass the gate — fix these errors, change only what's needed:\n${g.summary}`;
          signal = "retry";
        }
      } else if (jr.timedOut) {
        // a maker TIMEOUT is transient — it gets its own budget and never burns a genuine retry
        timeoutRetries++;
        signal = timeoutRetries <= maxTimeouts ? "retry" : "escalate";
        j.append({
          event: "spawn.retry",
          step,
          data: {
            role: "implementer",
            reason_code: "timeout",
            attempt: timeoutRetries,
          },
        });
      } else {
        implementAttempt++;
        signal = classifyJob("implementer", jr.terminal_state, jr.verdict);
      }
    } else if (step === "4a" || step === "4b" || step === "4c") {
      const role = roleForStep(step)!;
      const jr = await o.spawn({ role, step, round, runDir: o.runDir });
      j.append({
        event: "spawn.result",
        step,
        data: {
          role,
          verdict: jr.verdict,
          reason_code: jr.reason_code,
          terminal_state: jr.terminal_state,
          model: jr.model_used,
        },
      });
      signal = classifyJob(role, jr.terminal_state, jr.verdict);
      if (step === "4a" && signal === "advance") {
        j.append({
          event: "decision",
          step,
          data: {
            note: "reviewed",
            state: { last_reviewed_sha: jr.head_sha ?? "scratch" },
          },
        });
      }
      // On a review/grade loopback, carry the judge's findings back to the re-implement so the maker
      // fixes the named defect rather than re-implementing blind (else it re-produces the same output
      // and burns the retry budget → abort). Mirrors the inner-gate feedback above.
      if (signal === "loopback" && jr.findingsDigest) {
        lastImplementContext = `Your previous change was sent back by ${role}. Address these findings, changing only what's needed:\n${jr.findingsDigest}`;
      }
    } else if (step === "5") {
      const g = o.helper({
        name: "gate-full",
        step,
        runDir: o.runDir,
        worktree: o.worktree,
      });
      j.append({
        event: "helper.exec",
        step,
        data: {
          cmd: "run_gate.sh",
          exit: g.exit,
          summary: g.summary,
          log: g.logPath,
        },
      });
      signal = g.exit === 0 ? "gate-ok" : "gate-fail";
      if (g.exit === 0) {
        const c = o.helper({
          name: "commit",
          step,
          runDir: o.runDir,
          worktree: o.worktree,
        });
        j.append({
          event: "helper.exec",
          step,
          data: {
            cmd: "git commit",
            exit: c.exit,
            summary: c.summary,
            log: c.logPath,
            state: c.head_sha ? { head_sha: c.head_sha } : undefined,
          },
        });
      }
    } else {
      break; // reached a step outside the half-pipe (5-await, 6a, …)
    }

    const tr = transition(step, signal, { attempt: implementAttempt, cfg });
    j.append({
      event: "step.exit",
      step,
      round,
      data: { reason_code: tr.reason },
    });
    j.append({ event: "decision", data: { from: step, to: tr.next, signal } });
    projectAndWrite(o.runDir, j.read().events);

    // Half-pipe target reached: step 5 gate passed + committed → done (no push, no PR).
    if (step === stopAfter && (signal === "gate-ok" || signal === "advance")) {
      if (o.finalize !== false) {
        j.append({
          event: "run.end",
          data: {
            outcome: "half-pipe-complete",
            reason_code: "scratch_committed",
          },
        });
      }
      outcome = "complete";
      break;
    }
    if (tr.next === "aborted") {
      j.append({
        event: "run.end",
        data: {
          outcome: "aborted",
          reason_code: tr.reason,
          state: { step: "aborted" },
        },
      });
      outcome = "aborted";
      break;
    }
    step = tr.next;
  }

  const events = j.read().events;
  writeFileSync(join(o.runDir, "loop.log"), renderLoopLog(events));
  const state = projectAndWrite(o.runDir, events);
  return { state, visited, outcome };
}
