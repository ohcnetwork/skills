// ci-round.ts — the Phase-4 CI round-trip driver (PLAN-orchestrator-architecture §10 phase 4):
// deterministic 5 → 5-await → 6a → 6b → 5 loop until the run converges (6a finds zero address
// items AND CI is green) or a cap/checkpoint fires. This is the IMP-5 kill-shot: the wait is a real
// blocking `pollPr` (no "status?" nudge), and every bot round is journaled.
//
// Side-effecting seams are INJECTED (same DI as pipeline.ts): the GitHubApi (poll + feedback), the
// 6a triager + 6b apply spawns, and the step-5 re-gate/push helpers. Tests drive the whole loop with
// fakes; the live wiring passes OctokitGitHub + opencode spawns + shell helpers.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "./journal.js";
import { projectAndWrite, type CareState, type Step } from "./state.js";
import { transition, type FsmConfig } from "./fsm.js";
import { renderLoopLog } from "./render.js";
import { collectFeedback } from "./feedback.js";
import { renderVerdicts } from "./verdicts.js";
import type { TriageItem } from "./skill-result.js";
import { pollPr, type Bot } from "./poll.js";
import type { CiConclusion, GitHubApi } from "./github.js";

/** 6a triager output — the verdict tallies the FSM branches on (never prose). */
export interface TriageResult {
  addressCount: number;
  declineCount: number;
  deferCount: number;
  items?: TriageItem[]; // per-item verdict list → verdicts.md + dim-8 attribution; optional so fake-driven tests stay valid
}
export type TriageFn = (input: {
  pr: number;
  round: number;
  runDir: string;
  feedbackPath: string;
}) => Promise<TriageResult>;

/** 6b apply (implementer). */
export type ApplyFn = (input: {
  round: number;
  runDir: string;
}) => Promise<{ terminalState: "done" | "failed" }>;

/** Step-5 helpers for a re-round: re-gate (+commit) and push; push reports the new head SHA. */
export type GateFn = (input: { round: number; runDir: string }) => {
  exit: number;
  summary: string;
};
export type PushFn = (input: { round: number; runDir: string }) => {
  exit: number;
  summary: string;
  headSha?: string;
};

export interface CiRoundsConfig {
  maxRounds?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  ciGraceMs?: number;
}

export interface CiRoundsOptions {
  gh: GitHubApi;
  runDir: string;
  repo: string;
  branch: string;
  pr: number;
  headSha: string;
  sinceIso: string;
  bots: Bot[];
  triage: TriageFn;
  apply: ApplyFn;
  gate: GateFn;
  push: PushFn;
  cfg?: CiRoundsConfig;
  pollDeps?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
  startRound?: number;
}

export type CiOutcome = "converged" | "capped" | "deferred" | "gate-blocked";
export interface CiRoundsResult {
  outcome: CiOutcome;
  rounds: number;
  state: CareState;
}

const FSM: FsmConfig = { reviewSteps: ["4a"], maxImplementRetries: 2 };

export async function runCiRounds(o: CiRoundsOptions): Promise<CiRoundsResult> {
  const cfg = {
    maxRounds: 5,
    pollTimeoutMs: 30 * 60_000,
    pollIntervalMs: 60_000,
    ciGraceMs: 120_000,
    ...o.cfg,
  };
  const runId = `${o.repo.replace("/", "-")}-${o.branch}`;
  const j = new Journal(join(o.runDir, "journal.jsonl"), runId);

  let round = o.startRound ?? 1;
  let headSha = o.headSha;
  let sinceIso = o.sinceIso;
  let lastCi: CiConclusion = "none";

  if (j.read().events.length === 0) {
    j.append({
      event: "run.start",
      step: "5-await",
      round,
      data: {
        state: {
          task: `CI rounds PR#${o.pr}`,
          repo: o.repo,
          branch: o.branch,
          worktree: o.runDir,
          tier: "standard",
          pr: o.pr,
          round,
          step: "5-await",
          head_sha: headSha,
          last_reviewed_sha: "",
          updated_at: new Date().toISOString(),
        },
      },
    });
  }

  let step: Step = "5-await";
  let outcome: CiOutcome = "capped";
  const end = (o: CiOutcome, stepPatch: Step, reason: string) => {
    j.append({
      event: "run.end",
      data: {
        outcome: o,
        reason_code: reason,
        state: { step: stepPatch, round },
      },
    });
    outcome = o;
  };

  const GUARD = cfg.maxRounds * 6 + 6;
  for (let i = 0; i < GUARD; i++) {
    if (step === "5-await") {
      j.append({ event: "step.enter", step, round });
      j.append({ event: "ci.wait", data: { sha: headSha } });
      const poll = await pollPr(
        o.gh,
        {
          pr: o.pr,
          sinceIso,
          sha: headSha,
          bots: o.bots,
          timeoutMs: cfg.pollTimeoutMs,
          intervalMs: cfg.pollIntervalMs,
          ciGraceMs: cfg.ciGraceMs,
        },
        o.pollDeps ?? {},
      );
      lastCi = poll.ci;
      j.append({
        event: "ci.done",
        data: {
          conclusion: poll.ci,
          converged: poll.converged,
          missing: poll.missing.join(","),
        },
      });
      if (!poll.converged) {
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: "poll_timeout" },
        });
        j.append({
          event: "checkpoint.written",
          data: {
            reason_code: "ci_or_bots_timeout",
            missing: poll.missing.join(","),
          },
        });
        end("deferred", "5-await", "poll_timeout");
        break;
      }
      const tr = transition("5-await", "advance", { cfg: FSM });
      j.append({
        event: "step.exit",
        step,
        round,
        data: { reason_code: tr.reason },
      });
      j.append({
        event: "decision",
        data: { from: step, to: tr.next, signal: "advance" },
      });
      step = tr.next; // 6a
      projectAndWrite(o.runDir, j.read().events);
      continue;
    }

    if (step === "6a") {
      j.append({ event: "step.enter", step, round });
      const fb = await collectFeedback(o.gh, { pr: o.pr, runDir: o.runDir });
      j.append({
        event: "helper.exec",
        step,
        data: {
          cmd: "collect-feedback",
          exit: 0,
          summary: `${fb.count} bot item(s)`,
        },
      });
      const t = await o.triage({
        pr: o.pr,
        round,
        runDir: o.runDir,
        feedbackPath: join(o.runDir, "feedback.md"),
      });
      j.append({
        event: "spawn.result",
        step,
        data: {
          role: "care-triager",
          verdict: `address=${t.addressCount} decline=${t.declineCount} defer=${t.deferCount}`,
          reason_code: "triaged",
        },
      });
      if (t.items && t.items.length) {
        // Persist the verdict list: 6b applies from it, and the doctor mines it across runs for the
        // class × missed_by escape pattern (rubric dim 8). Fixes the previously-dangling verdicts.md read.
        writeFileSync(
          join(o.runDir, "verdicts.md"),
          renderVerdicts({ pr: o.pr, round, items: t.items }),
        );
        j.append({
          event: "helper.exec",
          step,
          data: {
            cmd: "write verdicts.md",
            exit: 0,
            summary: `${t.items.length} verdict(s)`,
          },
        });
      }

      if (t.deferCount > 0) {
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: "defer_to_human" },
        });
        j.append({
          event: "checkpoint.written",
          data: { reason_code: "defer_to_human" },
        });
        end("deferred", "6a", "defer_to_human");
        break;
      }
      if (t.addressCount === 0) {
        if (lastCi === "pass") {
          const tr = transition("6a", "converged", { cfg: FSM });
          j.append({
            event: "step.exit",
            step,
            round,
            data: { reason_code: tr.reason },
          });
          j.append({
            event: "decision",
            data: { from: step, to: tr.next, signal: "converged" },
          });
          end("converged", "7", "clean");
          step = tr.next;
          break;
        }
        // Nothing to auto-apply but CI isn't green — hand to a human rather than loop uselessly.
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: "ci_red_no_verdicts" },
        });
        j.append({
          event: "checkpoint.written",
          data: { reason_code: "ci_red_no_verdicts", ci: lastCi },
        });
        end("deferred", "6a", "ci_red_no_verdicts");
        break;
      }
      const tr = transition("6a", "advance", { cfg: FSM });
      j.append({
        event: "step.exit",
        step,
        round,
        data: { reason_code: tr.reason },
      });
      j.append({
        event: "decision",
        data: { from: step, to: tr.next, signal: "advance" },
      });
      step = tr.next; // 6b
      projectAndWrite(o.runDir, j.read().events);
      continue;
    }

    if (step === "6b") {
      j.append({ event: "step.enter", step, round });
      const a = await o.apply({ round, runDir: o.runDir });
      const sig = a.terminalState === "done" ? "advance" : "retry";
      j.append({
        event: "spawn.result",
        step,
        data: {
          role: "implementer",
          verdict: a.terminalState,
          reason_code: "applied",
        },
      });
      const tr = transition("6b", sig, { attempt: 1, cfg: FSM });
      j.append({
        event: "step.exit",
        step,
        round,
        data: { reason_code: tr.reason },
      });
      j.append({
        event: "decision",
        data: { from: step, to: tr.next, signal: sig },
      });
      if (tr.next === "aborted") {
        end("capped", "aborted", tr.reason);
        break;
      }
      step = tr.next; // 5
      projectAndWrite(o.runDir, j.read().events);
      continue;
    }

    if (step === "5") {
      round++;
      if (round > cfg.maxRounds) {
        j.append({
          event: "budget.stop",
          data: { reason_code: "max_rounds", round },
        });
        end("capped", "5", "max_rounds");
        break;
      }
      j.append({ event: "step.enter", step, round });
      const g = o.gate({ round, runDir: o.runDir });
      j.append({
        event: "helper.exec",
        step,
        data: { cmd: "run_gate.sh", exit: g.exit, summary: g.summary },
      });
      if (g.exit !== 0) {
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: "gate_red" },
        });
        end("gate-blocked", "3", "gate_red");
        break;
      }
      const p = o.push({ round, runDir: o.runDir });
      headSha = p.headSha ?? headSha;
      sinceIso = new Date().toISOString();
      j.append({
        event: "push",
        data: { exit: p.exit, head_sha: headSha, state: { head_sha: headSha } },
      });
      const tr = transition("5", "gate-ok", { cfg: FSM });
      j.append({
        event: "step.exit",
        step,
        round,
        data: { reason_code: tr.reason },
      });
      j.append({
        event: "decision",
        data: { from: step, to: tr.next, signal: "gate-ok" },
      });
      step = tr.next; // 5-await
      projectAndWrite(o.runDir, j.read().events);
      continue;
    }

    break; // reached a terminal step
  }

  const events = j.read().events;
  writeFileSync(join(o.runDir, "loop.log"), renderLoopLog(events));
  const state = projectAndWrite(o.runDir, events);
  return { outcome, rounds: round, state };
}
