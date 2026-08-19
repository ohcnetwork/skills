// ci-round.ts — the Phase-4 CI round-trip driver (PLAN-orchestrator-architecture §10 phase 4):
// deterministic 5 → 5-await → 6a → 6b → 5 loop until the run converges (6a finds zero address
// items AND CI is green) or a cap/checkpoint fires. This is the IMP-5 kill-shot: the wait is a real
// blocking `pollPr` (no "status?" nudge), and every bot round is journaled.
//
// Side-effecting seams are INJECTED (same DI as pipeline.ts): the GitHubApi (poll + feedback), the
// 6a triager + 6b apply spawns, and the step-5 re-gate/push helpers. Tests drive the whole loop with
// fakes; the live wiring passes OctokitGitHub + opencode spawns + shell helpers.

import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openRun, resolveRequestedBy } from "./run-context.js";
import { projectAndWrite, type CareState, type Step } from "./state.js";
import { transition, type FsmConfig } from "./fsm.js";
import { renderLoopLog } from "./render.js";
import { collectFeedback } from "./feedback.js";
import { renderVerdicts } from "./verdicts.js";
import type { TriageItem, CiFailure, CiFixPayload } from "./skill-result.js";
import { pollPr, type Bot } from "./poll.js";
import type { CiConclusion, GitHubApi } from "./github.js";

/** 6a triager output — the verdict tallies the FSM branches on (never prose). */
export interface TriageResult {
  addressCount: number;
  declineCount: number;
  items?: TriageItem[]; // per-item verdict list → verdicts.md + dim-8 attribution; optional so fake-driven tests stay valid
}
export type TriageFn = (input: {
  pr: number;
  round: number;
  runDir: string;
  feedbackPath: string;
}) => Promise<TriageResult>;

/** 6b apply (bot-comment implementer track). findings = gate-error feedback for gate loopback. */
export type ApplyFn = (input: {
  round: number;
  runDir: string;
  findings?: string; // gate-error feedback for the gate-loopback re-apply (MED-B)
}) => Promise<{ terminalState: "done" | "failed" | "noop" }>;

/** CI-fixer track: invoked as the residual when bots are clean but CI is still red.
 *  Default (human-handoff) = no edits, outcome "handoff". Real skills (playwright/lint/…) drop in
 *  behind this seam without any orchestrator change. findings = gate-error feedback. */
export type CiFixFn = (input: {
  round: number;
  runDir: string;
  ciFailures: CiFailure[];
  findings?: string;
  failingSpecs?: string[]; // CI's authoritative failing-spec list (Playwright artifact) — the whole
  // red set the fixer must clear; also seeds the step-5 full-set re-gate.
}) => Promise<{
  outcome: "fixed" | "handoff" | "noop";
  filesChanged?: string[];
  timedOut?: boolean; // hit the wall-clock cap — a dirty spec-only timeout is salvaged, not discarded
}>;

/** Step-7 reply/resolve seam: post verdict replies into the triaged bot threads and resolve the ones
 *  policy says to. Optional — fake-driven tests and the no-reply legacy path leave it unset. Returns
 *  tallies for the journal; a throw is swallowed by the caller (a reply is cosmetic vs. the merge). */
export type ReplyFn = (input: {
  pr: number;
  round: number;
  runDir: string;
  items: TriageItem[];
}) => Promise<{ replied: number; resolved: number; skipped: number }>;

/** 4b test-grade guard for the CI-fix track: grade the fixer's SPEC edit against the plan criteria
 *  before it's pushed. `blocking` = the grader returned a `wrong` verdict (a green-but-wrong spec) →
 *  the loop must NOT ship it. Optional — unset skips the guard (the fixer's edit ships ungraded, the
 *  pre-guard behaviour). A throw is treated as non-blocking by the caller (a grader failure must not
 *  strand a mergeable fix; it's a best-effort belt over the prompt-level guardrail). */
export type TestGradeFn = (input: {
  round: number;
  runDir: string;
}) => Promise<{ blocking: boolean; summary?: string }>;

/** Step-5 helpers for a re-round: re-gate (+commit) and push; push reports the new head SHA.
 *  The gate is static-only (tsc/lint/build/vitest) — Playwright specs are verified by CI, not
 *  locally (see PLAN-remove-local-e2e). */
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
  ciFix?: CiFixFn; // CI-fix track (optional; unset = no CI fixing, red CI defers with ci_red_human)
  testGrade?: TestGradeFn; // 4b guard over the CI-fixer's spec edits (optional; unset skips the guard)
  gate: GateFn;
  push: PushFn;
  reply?: ReplyFn; // Step 7 — reply to + resolve triaged threads (optional; unset = no thread I/O)
  cfg?: CiRoundsConfig;
  pollDeps?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
  startRound?: number;
}

// Loop terminal outcomes.
// `converged`  — bots clean AND CI green (the happy path).
// `capped`     — maxRounds or maxImplementRetries exhausted.
// `gate-blocked` — local gate (tsc/lint/build) failed after exhausting retries.
// `deferred`   — external stuck state the loop provably cannot resolve:
//   (a) poll_timeout: CI/bots never reached head within the budget;
//   (b) ci_red_human: CI is still red and the CiFixer couldn't fix it AND nothing is pending to push
//       (default = human-handoff). NOTE: in a batched round a ci-fix noop/handoff does NOT hand off —
//       a pending bot-fix is pushed first (re-triggering CI), and the handoff only fires a later
//       round once bots are clean and nothing is pending. Human or `resume` picks it up.
//   (c) ci_shard_infra: standalone residual round where CI is red but the Playwright artifact reports
//       ZERO genuine failed specs (shard/infra death). Nothing actionable for the fixer and nothing
//       pending to re-trigger with → defer. (An empty-commit re-trigger is a deferred enhancement.)
export type CiOutcome = "converged" | "capped" | "deferred" | "gate-blocked";
export interface CiRoundsResult {
  outcome: CiOutcome;
  rounds: number;
  state: CareState;
}

const FSM: FsmConfig = { reviewSteps: ["4a"], maxImplementRetries: 2 };

/** Post a human-readable PR comment when CI is red and the loop can't fix it. Best-effort — a
 *  throw here is swallowed; the checkpoint is already written so a human will see the outcome. */
async function postCiRedComment(
  gh: GitHubApi,
  pr: number,
  round: number,
  ciFailures: { name: string; summary?: string }[] = [],
): Promise<void> {
  const checkList = ciFailures.length
    ? ciFailures
        .map((c) => `- ${c.name}${c.summary ? `: ${c.summary}` : ""}`)
        .join("\n")
    : "(check the CI tab for details)";
  try {
    await gh.createComment(
      pr,
      `**care-loop: all bot feedback addressed — CI still red (round ${round})**\n\nThe following checks are failing:\n${checkList}\n\nLeaving this for a human to resolve. — care-loop 🤖`,
    );
  } catch {
    /* best-effort */
  }
}

export async function runCiRounds(o: CiRoundsOptions): Promise<CiRoundsResult> {
  const cfg = {
    maxRounds: 5,
    pollTimeoutMs: 30 * 60_000,
    pollIntervalMs: 60_000,
    ciGraceMs: 120_000,
    ...o.cfg,
  };
  const { journal: j, runId, isNew } = openRun(o.runDir);

  let round = o.startRound ?? 1;
  let headSha = o.headSha;
  let sinceIso = o.sinceIso;
  let lastCi: CiConclusion = "none";

  if (isNew) {
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
          run_id: runId,
          requested_by: resolveRequestedBy(),
          ticket: null,
          summary: null,
          started_at: new Date().toISOString(),
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

  // Step 7 — reply to + resolve the triaged threads. Called after a round's fixes are pushed (so
  // `address` threads are resolved only once their fix is live) and on the converged exit (final
  // `decline` threads). Idempotent (signature scan), so re-entry never double-posts. A reply
  // failure is journaled and swallowed — it must never abort a run that is otherwise merge-ready.
  const doReply = async (items: TriageItem[] | undefined): Promise<void> => {
    if (!o.reply || !items?.length) return;
    j.append({ event: "step.enter", step: "5-replying", round });
    try {
      const r = await o.reply({ pr: o.pr, round, runDir: o.runDir, items });
      j.append({
        event: "helper.exec",
        step: "5-replying",
        data: {
          cmd: "reply+resolve threads",
          exit: 0,
          summary: `replied ${r.replied}, resolved ${r.resolved}, skipped ${r.skipped}`,
        },
      });
    } catch (e) {
      j.append({
        event: "helper.exec",
        step: "5-replying",
        data: {
          cmd: "reply+resolve threads",
          exit: 1,
          summary: `reply failed: ${(e as Error).message}`,
        },
      });
    }
  };
  // The verdict list from the round currently in flight (set at 6a, replied at step 5 once pushed).
  let pendingItems: TriageItem[] | undefined;
  // Which resolve track is active this round: true = bot-comment (implementer), false = ci-fix.
  // Set in 6a alongside pendingItems so 6b doesn't have to re-derive it from items (which may be
  // absent in fake-driven tests that only supply addressCount/declineCount).
  let activeBotTrack = false;
  // Retry budget for the CURRENT round's active resolve track (bot apply or ci-fix).
  // Reset when a fresh round enters 6b.
  let applyAttempt = 1;
  // Gate-loopback budget for the current step-5 gate failure (MED-B).
  // Reset each time step-5 is entered for a new round.
  let gateAttempt = 0;
  // Gate-error findings to feed back to the re-apply on a gate-loopback.
  let gateFindingsForReapply: string | undefined;
  // ── Batched-round state (bot-fix + CI-fix in ONE round, single push). ──
  // batchedRound: this round has BOTH bot comments to address AND red CI, so after the bot-fix we run
  //   the CI-fix track before the single step-5 push (instead of pushing bots-only and burning a
  //   separate CI-fix round). Set in 6a, reset each 6a + step-5.
  // pendingBotFix: a real bot-track edit is in the tree, not yet pushed. The CI-fix track's terminal
  //   branches read it: a noop/handoff must still PUSH the pending bot-fix (and let CI re-trigger)
  //   rather than stranding it via an immediate human-handoff (only correct when nothing is pending).
  let batchedRound = false;
  let pendingBotFix = false;

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
        // `deferred` = external-stuck-state checkpoint (CI/bots never reached head in budget), NOT the
        // removed triage defer-to-human verdict. Safety valve against an unbounded wait — see CiOutcome.
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
      // Reset the active-track flag here (a fresh 6a starts a new prioritized-serial decision).
      // NOT at step-5 entry — the gate-loopback inside step-5 still needs the current round's track.
      activeBotTrack = false;
      batchedRound = false;
      pendingBotFix = false;
      j.append({ event: "step.enter", step, round });
      const fb = await collectFeedback(o.gh, { pr: o.pr, runDir: o.runDir });
      // Archive the round's feedback snapshot. collectFeedback overwrites the canonical feedback.md
      // (the triager reads it live and must see CURRENT thread state, not an accumulation) — so keep a
      // round-suffixed copy for forensics, mirroring how skills/*-r{N} preserve per-round I/O. Without
      // it only the final round's bot set survives on disk and the doctor can't diff round-over-round.
      writeFileSync(join(o.runDir, `feedback-r${round}.md`), fb.markdown);
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
          verdict: `address=${t.addressCount} decline=${t.declineCount}`,
          reason_code: "triaged",
        },
      });
      if (t.items && t.items.length) {
        // Persist the verdict list: 6b applies from it, and the doctor mines it across runs for the
        // class × missed_by escape pattern (rubric dim 8).
        const verdictsMd = renderVerdicts({ pr: o.pr, round, items: t.items });
        writeFileSync(join(o.runDir, "verdicts.md"), verdictsMd);
        // Round-suffixed archive (see the feedback-r{N} note above): verdicts.md is overwritten each
        // round because 6b applies from the CURRENT round only; the copy preserves per-round history.
        writeFileSync(join(o.runDir, `verdicts-r${round}.md`), verdictsMd);
        j.append({
          event: "helper.exec",
          step,
          data: {
            cmd: "write verdicts.md",
            exit: 0,
            summary: `${t.items.length} verdict(s)`,
          },
        });
        // Persist addressed thread IDs at 6a so resume annotates re-surfaced threads correctly.
        const addressEntries = t.items
          .filter((i) => i.verdict === "address")
          .flatMap((i) =>
            (i.threads ?? []).map((threadId) => ({ threadId, round })),
          );
        if (addressEntries.length) {
          const atPath = join(o.runDir, "addressed-threads.json");
          let existing: { threadId: number; round: number }[] = [];
          try {
            existing = JSON.parse(readFileSync(atPath, "utf8"));
          } catch {
            /* first write */
          }
          const seen = new Map(existing.map((e) => [e.threadId, e.round]));
          for (const e of addressEntries) {
            if (!seen.has(e.threadId)) seen.set(e.threadId, e.round);
          }
          writeFileSync(
            atPath,
            JSON.stringify(
              [...seen.entries()].map(([threadId, r]) => ({
                threadId,
                round: r,
              })),
              null,
              2,
            ),
          );
        }
      }

      // ── Resolve decision ───────────────────────────────────────────────────────────────────────
      // Bot-comment track has PRIORITY. When CI is ALSO red, this is a BATCHED round: the bot-fix
      // runs first, then (unless it already cleared CI — checked by a local mid-run) the CI-fix track
      // runs too, and BOTH ride out on a single step-5 push. Bots-first within the round preserves the
      // "a bot fix often clears CI" bet without burning a separate CI-fix round. When bots are clean
      // and only CI is red, the CI-fix track runs standalone (no pending bot-fix).
      const botAddress = t.addressCount > 0;
      const ciRed = lastCi === "fail";

      if (!botAddress && !ciRed) {
        // ── Converged: bots clean + CI green ──
        const tr = transition("6a", "converged", { cfg: FSM });
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: tr.reason },
        });
        await doReply(t.items);
        j.append({
          event: "decision",
          data: { from: step, to: tr.next, signal: "converged" },
        });
        end("converged", "7", "clean");
        step = tr.next;
        break;
      }

      if (botAddress) {
        // ── Bot-comment track (priority) ──
        // Stash verdicts; 6b applies them. If CI is ALSO red this is a batched round: 6b chains the
        // CI-fix track after the bot-fix (the fixer re-verifies against the bot-fixed tree and no-ops
        // if already clear) so both push together.
        pendingItems = t.items;
        activeBotTrack = true;
        batchedRound = ciRed;
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

      // !botAddress && ciRed — CI-fix residual track
      // Stash decline items for step-7 reply regardless of what the CiFixer does.
      pendingItems = t.items;
      activeBotTrack = false;
      j.append({
        event: "step.exit",
        step,
        round,
        data: { reason_code: "ci_red_residual" },
      });
      j.append({
        event: "decision",
        data: { from: step, to: "6b", signal: "advance" },
      });
      step = "6b";
      projectAndWrite(o.runDir, j.read().events);
      continue;
    }

    if (step === "6b") {
      j.append({ event: "step.enter", step, round });

      // Determine which track is active this round — set by 6a, not re-derived from items
      // (items may be absent in fake-driven tests that only supply addressCount).
      const botActive = activeBotTrack;

      if (botActive) {
        // ── Bot-comment track ──
        const a = await o.apply({ round, runDir: o.runDir });
        j.append({
          event: "spawn.result",
          step,
          data: {
            role: "implementer",
            verdict: a.terminalState,
            reason_code: "applied",
          },
        });

        if (a.terminalState === "noop") {
          // Maker ran clean but produced no diff: the flagged items are already fixed.
          // This is NOT a failure — don't burn a retry.
          if (batchedRound) {
            // Bot items already fixed but CI is still red → fall through to the CI-fix track. No bot
            // edit was produced, so nothing is pending to push (pendingBotFix stays false); the
            // CI-fix track behaves as the standalone residual. pendingItems carried for the reply.
            activeBotTrack = false;
            j.append({
              event: "step.exit",
              step,
              round,
              data: { reason_code: "bot_noop_to_cifix" },
            });
            projectAndWrite(o.runDir, j.read().events);
            continue;
          }
          // Re-check CI status to decide terminal.
          j.append({
            event: "step.exit",
            step,
            round,
            data: { reason_code: "apply_noop" },
          });
          await doReply(pendingItems);
          pendingItems = undefined;
          if (lastCi === "pass") {
            end("converged", "7", "noop_clean");
          } else {
            // CI still red; items were already fixed so bot track is done. Hand off to a human.
            let noopCiFailures: import("./skill-result.js").CiFailure[] = [];
            try {
              noopCiFailures = await o.gh.listFailingChecks(headSha);
            } catch {
              /* best-effort */
            }
            await postCiRedComment(o.gh, o.pr, round, noopCiFailures);
            j.append({
              event: "checkpoint.written",
              data: { reason_code: "ci_red_human", ci: lastCi },
            });
            end("deferred", "6b", "ci_red_human");
          }
          break;
        }

        if (a.terminalState === "done") {
          if (batchedRound) {
            // Batched round: the bot-fix is in the tree — DON'T push yet. Switch to the CI-fix track
            // (same 6b step), which runs the mid-run first and pushes both fixes together at step 5.
            pendingBotFix = true;
            activeBotTrack = false;
            j.append({
              event: "step.exit",
              step,
              round,
              data: { reason_code: "bot_fixed_batched" },
            });
            projectAndWrite(o.runDir, j.read().events);
            continue;
          }
          const tr = transition("6b", "advance", {
            attempt: applyAttempt,
            cfg: FSM,
          });
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
          step = tr.next; // 5
          projectAndWrite(o.runDir, j.read().events);
          continue;
        }

        // failed — genuine error; retry up to maxImplementRetries
        const tr = transition("6b", "retry", {
          attempt: applyAttempt,
          cfg: FSM,
        });
        applyAttempt++;
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: tr.reason },
        });
        j.append({
          event: "decision",
          data: { from: step, to: tr.next, signal: "retry" },
        });
        if (tr.next === "aborted") {
          end("capped", "aborted", tr.reason);
          break;
        }
        step = tr.next; // 6b (retry)
        projectAndWrite(o.runDir, j.read().events);
        continue;
      }

      // ── CI-fix track (standalone residual, OR batched after a bot-fix) ──
      // No local spec pre-check. In a batched round we always run the ci-fixer with the bot-fix
      // context (below): it re-verifies each CI failure against the current tree and no-ops when the
      // bot-fix already cleared them, so the bot-fix pushes alone. CI — not a local spec run — is the
      // arbiter of "still red" (PLAN-remove-local-e2e §2A).

      // Standalone residual (no pending bot-fix): read CI's authoritative failing-spec list from the
      // Playwright artifact and hand the fixer the WHOLE red set (C1), so it can spot one changed value
      // driving locators across many specs. The fix is verified by CI after push, not a local re-gate.
      let failingSpecs: string[] = [];
      if (!pendingBotFix) {
        try {
          const failing = await o.gh.getFailingSpecs(headSha);
          failingSpecs = failing.specPaths;
          j.append({
            event: "helper.exec",
            step,
            data: {
              cmd: "getFailingSpecs",
              exit: 0,
              summary: `${failingSpecs.length} failing spec(s)${failing.shardOnlyFailure ? " (shard-only)" : ""}`,
            },
          });
          if (failing.shardOnlyFailure && failingSpecs.length === 0) {
            // Red CI with zero genuine failed specs = infra/shard death. Nothing actionable for the
            // fixer and (standalone) nothing pending to re-trigger with → defer for a human. An
            // empty-commit re-trigger is a deferred enhancement (see PLAN-ci-fix-standalone-verify).
            j.append({
              event: "step.exit",
              step,
              round,
              data: { reason_code: "ci_shard_infra" },
            });
            await doReply(pendingItems);
            pendingItems = undefined;
            j.append({
              event: "checkpoint.written",
              data: { reason_code: "ci_shard_infra", ci: lastCi },
            });
            end("deferred", "6b", "ci_shard_infra");
            break;
          }
        } catch {
          /* best-effort — no artifact / read failed → fall through with annotations only */
        }
      }

      // Fetch failing checks WITH annotations (file:line:message) upfront — the CiFixer needs them
      // to read the exact failing assertion; the human PR comment ignores the extra field. Superset
      // of listFailingChecks, so one call feeds both. Best-effort ([] on error).
      let ciFailures: import("./skill-result.js").CiFailure[] = [];
      try {
        ciFailures = await o.gh.getCheckFailureContext(headSha);
      } catch {
        /* best-effort */
      }

      if (!o.ciFix) {
        if (pendingBotFix) {
          // No CI-fixer, but a bot-fix is pending — push it (it addresses real bot comments) and let
          // CI re-run. The residual red is re-evaluated next round (bots now clean → the standalone
          // no-ciFix handoff below fires with nothing stranded).
          j.append({
            event: "step.exit",
            step,
            round,
            data: { reason_code: "cifix_none_push_botfix" },
          });
          j.append({
            event: "decision",
            data: { from: step, to: "5", signal: "advance" },
          });
          step = "5";
          projectAndWrite(o.runDir, j.read().events);
          continue;
        }
        // No CiFixer injected — treat as immediate handoff.
        j.append({
          event: "spawn.result",
          step,
          data: {
            role: "ci-fixer",
            verdict: "handoff",
            reason_code: "no_ci_fixer",
          },
        });
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: "no_ci_fixer" },
        });
        await doReply(pendingItems);
        pendingItems = undefined;
        await postCiRedComment(o.gh, o.pr, round, ciFailures);
        j.append({
          event: "checkpoint.written",
          data: { reason_code: "ci_red_human", ci: lastCi },
        });
        end("deferred", "6b", "ci_red_human");
        break;
      }

      // In a batched round the tree already carries the bot-fix; tell the fixer so it re-verifies the
      // (pre-bot-fix) CI failures against the CURRENT tree rather than a stale snapshot.
      const botFixContext = pendingBotFix
        ? "A bot-comment fix was just applied to this worktree (uncommitted). The CI failures below " +
          "were reported on the commit BEFORE it — re-verify each against the CURRENT tree before " +
          "changing anything; some may already be resolved."
        : undefined;
      const cf = await o.ciFix({
        round,
        runDir: o.runDir,
        ciFailures,
        failingSpecs,
        findings: botFixContext,
      });
      j.append({
        event: "spawn.result",
        step,
        data: {
          role: "ci-fixer",
          verdict: cf.outcome,
          reason_code: cf.outcome,
        },
      });

      // ── Salvage a clean timeout ──
      // A `handoff` caused purely by the wall-clock cap (exit 124) that left a dirty, spec-ONLY tree
      // is a completed-but-unverified fix, not a failure: opencode edits are atomic per-hunk, so the
      // applied edits are whole — the fixer just didn't get to self-check. Rather than discard that
      // work (the eng-747 defer), promote it to the `fixed` path so the static gate (tsc/lint/build)
      // green-lights the push and CI becomes the arbiter of the spec itself: CI-green → converged;
      // CI-red → next round re-enters 6b. The 4b test-grader still guards green-but-wrong pre-push.
      // Narrow by design: only a timeout (not a crash), only a dirty tree, only spec/test files (a
      // half-timed-out source edit stays a handoff — we don't want to auto-commit source on a timeout).
      const salvageable =
        cf.outcome === "handoff" &&
        cf.timedOut === true &&
        (cf.filesChanged?.length ?? 0) > 0 &&
        cf.filesChanged!.every((f) => /\.spec\.tsx?$|\.test\.tsx?$/.test(f));
      if (salvageable) {
        j.append({
          event: "helper.exec",
          step,
          data: {
            cmd: "ci-fix salvage-timeout",
            exit: 0,
            summary: `fixer timed out (exit 124) with ${cf.filesChanged!.length} spec edit(s) — gating instead of discarding`,
          },
        });
      }
      const effectiveOutcome: CiFixPayload["outcome"] = salvageable
        ? "fixed"
        : cf.outcome;

      if (effectiveOutcome === "fixed") {
        // ── §3 guard: 4b over the fixer's SPEC edit before it's pushed ──
        // A test-stale fix edits a spec's assertion. That's exactly the "green but wrong" risk the
        // test-grader guards: the fixer could match the assertion to the (wrong) current output or
        // weaken it. So when the fix touched a spec, grade it against the plan criteria first; a
        // `blocking` (wrong) verdict means we must NOT push a green-but-wrong test — hand off instead.
        // Skipped when no spec was touched (a source fix is the bot maker's domain, already gated) or
        // no grader is injected. A grader throw is non-blocking (best-effort belt).
        const touchedSpec = (cf.filesChanged ?? []).some((f) =>
          /\.spec\.tsx?$|\.test\.tsx?$/.test(f),
        );
        if (touchedSpec && o.testGrade) {
          let graded: { blocking: boolean; summary?: string } = {
            blocking: false,
          };
          try {
            graded = await o.testGrade({ round, runDir: o.runDir });
          } catch (e) {
            j.append({
              event: "helper.exec",
              step,
              data: {
                cmd: "ci-fix spec 4b-guard",
                exit: 0,
                summary: `grader threw (non-blocking): ${(e as Error).message}`,
              },
            });
          }
          j.append({
            event: "spawn.result",
            step,
            data: {
              role: "care-test-grader",
              verdict: graded.blocking ? "wrong" : "ok",
              reason_code: "ci_fix_spec_guard",
            },
          });
          if (graded.blocking) {
            // Green-but-wrong spec edit — do NOT push it. Hand off with the grader's reason.
            j.append({
              event: "step.exit",
              step,
              round,
              data: { reason_code: "ci_fix_spec_wrong" },
            });
            await doReply(pendingItems);
            pendingItems = undefined;
            try {
              await o.gh.createComment(
                o.pr,
                `**care-loop: CI-fix edited a test, but the test-grader flagged it as wrong (round ${round})**\n\n` +
                  `The CI-fixer changed a spec to clear a red check, but 4b judged the edit does not match the ` +
                  `plan's acceptance criteria — shipping it would be "green but wrong". Leaving this for a human.` +
                  (graded.summary ? `\n\n${graded.summary}` : "") +
                  `\n\n— care-loop 🤖`,
              );
            } catch {
              /* best-effort */
            }
            j.append({
              event: "checkpoint.written",
              data: { reason_code: "ci_fix_spec_wrong", ci: lastCi },
            });
            end("deferred", "6b", "ci_fix_spec_wrong");
            break;
          }
        }
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: "ci_fixed" },
        });
        j.append({
          event: "decision",
          data: { from: step, to: "5", signal: "advance" },
        });
        step = "5";
        projectAndWrite(o.runDir, j.read().events);
        continue;
      }

      // handoff or noop — the ci-fixer couldn't fix CI this round.
      if (pendingBotFix) {
        // A bot-fix is pending. Don't strand it in a human-handoff: PUSH it (it addresses real bot
        // comments) and let CI re-run — a flaky red often clears on the fresh run. The residual red is
        // re-evaluated next round with bots now clean, which takes the standalone CI-fix path below
        // and hands off then if it's a genuine, unfixable failure. So the flake gets exactly one
        // re-trigger (this push) before handoff — the round cap bounds it either way.
        j.append({
          event: "step.exit",
          step,
          round,
          data: { reason_code: "cifix_noop_push_botfix" },
        });
        j.append({
          event: "decision",
          data: { from: step, to: "5", signal: "advance" },
        });
        step = "5";
        projectAndWrite(o.runDir, j.read().events);
        continue;
      }
      // Nothing pending — can't fix CI; hand to a human.
      j.append({
        event: "step.exit",
        step,
        round,
        data: { reason_code: "ci_red_human" },
      });
      await doReply(pendingItems);
      pendingItems = undefined;
      await postCiRedComment(o.gh, o.pr, round, ciFailures);
      j.append({
        event: "checkpoint.written",
        data: { reason_code: "ci_red_human", ci: lastCi },
      });
      end("deferred", "6b", "ci_red_human");
      break;
    }

    if (step === "5") {
      round++;
      applyAttempt = 1; // fresh round → reset the resolve-track retry budget
      gateAttempt = 0; // fresh round → reset the gate-loopback budget
      gateFindingsForReapply = undefined;
      if (round > cfg.maxRounds) {
        j.append({
          event: "budget.stop",
          data: { reason_code: "max_rounds", round },
        });
        end("capped", "5", "max_rounds");
        break;
      }
      j.append({ event: "step.enter", step, round });
      // Static gate only (tsc/lint/build/vitest) — Playwright specs are verified by CI post-push
      // (PLAN-remove-local-e2e). So gate-red here means a genuine code/type/lint/build failure.
      const g = o.gate({ round, runDir: o.runDir });
      j.append({
        event: "helper.exec",
        step,
        data: { cmd: "run_gate.sh", exit: g.exit, summary: g.summary },
      });
      if (g.exit !== 0) {
        // MED-B: gate-loopback. Feed gate errors back to the same track that dirtied the tree
        // and re-try, up to maxImplementRetries. Only after exhaustion → gate-blocked.
        gateAttempt++;
        if (gateAttempt <= FSM.maxImplementRetries) {
          j.append({
            event: "step.exit",
            step,
            round,
            data: { reason_code: `gate_red_loopback_${gateAttempt}` },
          });
          gateFindingsForReapply = `Your previous change did not pass the local gate — fix these errors, change only what's needed:\n${g.summary}`;
          // Re-run the active track (6b) with gate errors as findings.
          j.append({ event: "step.enter", step: "6b", round });
          const botActive = activeBotTrack;
          let reapplyResult: { terminalState: "done" | "failed" | "noop" };
          if (botActive) {
            reapplyResult = await o.apply({
              round,
              runDir: o.runDir,
              findings: gateFindingsForReapply,
            });
          } else if (o.ciFix) {
            let ciFailures: import("./skill-result.js").CiFailure[] = [];
            try {
              ciFailures = await o.gh.getCheckFailureContext(headSha);
            } catch {
              /* best-effort */
            }
            const cf2 = await o.ciFix({
              round,
              runDir: o.runDir,
              ciFailures,
              findings: gateFindingsForReapply,
            });
            reapplyResult = {
              terminalState: cf2.outcome === "fixed" ? "done" : "failed",
            };
          } else {
            reapplyResult = { terminalState: "failed" };
          }
          j.append({
            event: "spawn.result",
            step: "6b",
            data: {
              role: botActive ? "implementer" : "ci-fixer",
              verdict: reapplyResult.terminalState,
              reason_code: "gate_reapply",
            },
          });
          if (reapplyResult.terminalState === "done") {
            // Re-try the gate with the new changes.
            const g2 = o.gate({ round, runDir: o.runDir });
            j.append({
              event: "helper.exec",
              step,
              data: {
                cmd: "run_gate.sh (retry)",
                exit: g2.exit,
                summary: g2.summary,
              },
            });
            if (g2.exit === 0) {
              // Gate now passes — fall through to push.
              const p = o.push({ round, runDir: o.runDir });
              headSha = p.headSha ?? headSha;
              sinceIso = new Date().toISOString();
              j.append({
                event: "push",
                data: {
                  exit: p.exit,
                  head_sha: headSha,
                  state: { head_sha: headSha },
                },
              });
              await doReply(pendingItems);
              pendingItems = undefined;
              const tr2 = transition("5", "gate-ok", { cfg: FSM });
              j.append({
                event: "step.exit",
                step,
                round,
                data: { reason_code: tr2.reason },
              });
              j.append({
                event: "decision",
                data: { from: step, to: tr2.next, signal: "gate-ok" },
              });
              step = tr2.next; // 5-await
              projectAndWrite(o.runDir, j.read().events);
              continue;
            }
            // Second gate still red — fall through to gate-blocked check below.
            j.append({
              event: "step.exit",
              step,
              round,
              data: { reason_code: "gate_red_after_reapply" },
            });
          }
          // Reapply failed or gate still red → gate-blocked.
        }
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
      // Step 7 — with the round's fixes now pushed, reply to + resolve the threads it addressed.
      await doReply(pendingItems);
      pendingItems = undefined;
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
