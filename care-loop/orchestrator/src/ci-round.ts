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
import { Journal } from "./journal.js";
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

// ── Driver context ────────────────────────────────────────────────────────────────────────────────
// The loop's mutable state, in one place. Previously these were thirteen `let`s in a single 894-line
// function, which meant every branch could touch every flag and nothing said which step owned what.

interface Ctx {
  o: CiRoundsOptions;
  cfg: Required<CiRoundsConfig>;
  j: Journal;
  round: number;
  headSha: string;
  sinceIso: string;
  lastCi: CiConclusion;
  /** The verdict list from the round in flight: set at 6a, replied at step 5 once pushed. */
  pendingItems?: TriageItem[];
  /** Which resolve track 6b runs: true = bot-comment (implementer), false = ci-fix. Set at 6a so 6b
   *  need not re-derive it from items, which fake-driven tests may omit. */
  activeBotTrack: boolean;
  /** Retry budget for the current round's resolve track. Reset when a fresh round enters 6b. */
  applyAttempt: number;
  /** Gate-loopback budget for the current step-5 gate failure. Reset each time step 5 is entered. */
  gateAttempt: number;
  /** This round has BOTH bot comments and red CI, so the ci-fix track runs after the bot-fix and
   *  both ride out on one push, instead of burning a separate round. */
  batchedRound: boolean;
  /** A bot-track edit is in the tree, unpushed. The ci-fix terminal branches read it: a noop must
   *  still push the pending bot-fix rather than stranding it in a handoff. */
  pendingBotFix: boolean;
}

/** Where the driver goes next: another step, or a terminal outcome. */
type Next =
  | { kind: "go"; step: Step }
  | { kind: "end"; outcome: CiOutcome; step: Step; reason: string };

const go = (step: Step): Next => ({ kind: "go", step });
const finish = (outcome: CiOutcome, step: Step, reason: string): Next => ({
  kind: "end",
  outcome,
  step,
  reason,
});

// ── Journal helpers ───────────────────────────────────────────────────────────────────────────────

const enter = (c: Ctx, step: Step): void => {
  c.j.append({ event: "step.enter", step, round: c.round });
};

const exit = (c: Ctx, step: Step, reason: string): void => {
  c.j.append({ event: "step.exit", step, round: c.round, data: { reason_code: reason } });
};

const decide = (c: Ctx, from: string, to: string, signal: string): void => {
  c.j.append({ event: "decision", data: { from, to, signal } });
};

const checkpoint = (c: Ctx, reason: string, extra: Record<string, unknown> = {}): void => {
  c.j.append({ event: "checkpoint.written", data: { reason_code: reason, ...extra } });
};

const helper = (c: Ctx, step: Step, cmd: string, exitCode: number, summary: string): void => {
  c.j.append({ event: "helper.exec", step, data: { cmd, exit: exitCode, summary } });
};

const spawned = (c: Ctx, step: Step, role: string, verdict: string, reason: string): void => {
  c.j.append({ event: "spawn.result", step, data: { role, verdict, reason_code: reason } });
};

/** Exit the step, record the transition, and hand the driver its next step. */
const advance = (c: Ctx, from: Step, to: Step, reason: string, signal = "advance"): Next => {
  exit(c, from, reason);
  decide(c, from, to, signal);
  return go(to);
};

/**
 * Step 7 — reply to and resolve the triaged threads. Called once a round's fixes are pushed, so an
 * `address` thread resolves only when its fix is live, and on the converged exit for the final
 * `decline` threads. Idempotent via a signature scan, so re-entry never double-posts; a failure is
 * journaled and swallowed, because a reply must never abort an otherwise merge-ready run.
 */
async function replyToThreads(c: Ctx): Promise<void> {
  const items = c.pendingItems;
  if (!c.o.reply || !items?.length) return;
  enter(c, "5-replying");
  try {
    const r = await c.o.reply({ pr: c.o.pr, round: c.round, runDir: c.o.runDir, items });
    helper(c, "5-replying", "reply+resolve threads", 0,
      `replied ${r.replied}, resolved ${r.resolved}, skipped ${r.skipped}`);
  } catch (e) {
    helper(c, "5-replying", "reply+resolve threads", 1,
      `reply failed: ${(e as Error).message}`);
  }
}

/** Reply, then clear — the pair every terminal branch performs before handing off. */
async function flushReplies(c: Ctx): Promise<void> {
  await replyToThreads(c);
  c.pendingItems = undefined;
}

/** The human-handoff ending: reply out, comment on the PR, checkpoint, defer. */
async function handoffCiRed(c: Ctx, ciFailures: CiFailure[]): Promise<Next> {
  await flushReplies(c);
  await postCiRedComment(c.o.gh, c.o.pr, c.round, ciFailures);
  checkpoint(c, "ci_red_human", { ci: c.lastCi });
  return finish("deferred", "6b", "ci_red_human");
}

// ── Step 5-await — block on CI and the bots reaching head ─────────────────────────────────────────

async function stepAwaitCi(c: Ctx): Promise<Next> {
  enter(c, "5-await");
  c.j.append({ event: "ci.wait", data: { sha: c.headSha } });
  const poll = await pollPr(
    c.o.gh,
    {
      pr: c.o.pr,
      sinceIso: c.sinceIso,
      sha: c.headSha,
      bots: c.o.bots,
      timeoutMs: c.cfg.pollTimeoutMs,
      intervalMs: c.cfg.pollIntervalMs,
      ciGraceMs: c.cfg.ciGraceMs,
    },
    c.o.pollDeps ?? {},
  );
  c.lastCi = poll.ci;
  c.j.append({
    event: "ci.done",
    data: { conclusion: poll.ci, converged: poll.converged, missing: poll.missing.join(",") },
  });

  if (!poll.converged) {
    exit(c, "5-await", "poll_timeout");
    // An external-stuck-state checkpoint, not a triage verdict: the safety valve against an
    // unbounded wait when CI or the bots never reach head within the budget.
    checkpoint(c, "ci_or_bots_timeout", { missing: poll.missing.join(",") });
    return finish("deferred", "5-await", "poll_timeout");
  }

  const tr = transition("5-await", "advance", { cfg: FSM });
  return advance(c, "5-await", tr.next, tr.reason);
}

// ── Step 6a — collect feedback, triage, choose a resolve track ────────────────────────────────────

/** collectFeedback overwrites the canonical feedback.md, because the triager must see CURRENT thread
 *  state rather than an accumulation. The round-suffixed copy is what lets the doctor diff
 *  round-over-round; without it only the final round's bot set survives on disk. */
function archiveFeedback(c: Ctx, markdown: string): void {
  writeFileSync(join(c.o.runDir, `feedback-r${c.round}.md`), markdown);
}

/** verdicts.md is overwritten each round because 6b applies from the current round only; the
 *  round-suffixed copy preserves the history the doctor mines for escape patterns. */
function persistVerdicts(c: Ctx, items: TriageItem[]): void {
  const md = renderVerdicts({ pr: c.o.pr, round: c.round, items });
  writeFileSync(join(c.o.runDir, "verdicts.md"), md);
  writeFileSync(join(c.o.runDir, `verdicts-r${c.round}.md`), md);
  helper(c, "6a", "write verdicts.md", 0, `${items.length} verdict(s)`);
}

/** Recorded at 6a so a resume annotates re-surfaced threads with the round that addressed them. */
function persistAddressedThreads(c: Ctx, items: TriageItem[]): void {
  const entries = items
    .filter((i) => i.verdict === "address")
    .flatMap((i) => (i.threads ?? []).map((threadId) => ({ threadId, round: c.round })));
  if (!entries.length) return;

  const path = join(c.o.runDir, "addressed-threads.json");
  let existing: { threadId: number; round: number }[] = [];
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* first write */
  }
  const firstSeen = new Map(existing.map((e) => [e.threadId, e.round]));
  for (const e of entries) if (!firstSeen.has(e.threadId)) firstSeen.set(e.threadId, e.round);
  writeFileSync(
    path,
    JSON.stringify([...firstSeen.entries()].map(([threadId, round]) => ({ threadId, round })), null, 2),
  );
}

async function stepTriage(c: Ctx): Promise<Next> {
  // Reset here rather than at step 5, because the gate-loopback inside step 5 still needs the
  // current round's track.
  c.activeBotTrack = false;
  c.batchedRound = false;
  c.pendingBotFix = false;
  enter(c, "6a");

  const fb = await collectFeedback(c.o.gh, { pr: c.o.pr, runDir: c.o.runDir });
  archiveFeedback(c, fb.markdown);
  helper(c, "6a", "collect-feedback", 0, `${fb.count} bot item(s)`);

  const t = await c.o.triage({
    pr: c.o.pr,
    round: c.round,
    runDir: c.o.runDir,
    feedbackPath: join(c.o.runDir, "feedback.md"),
  });
  spawned(c, "6a", "care-triager",
    `address=${t.addressCount} decline=${t.declineCount}`, "triaged");

  if (t.items?.length) {
    persistVerdicts(c, t.items);
    persistAddressedThreads(c, t.items);
  }

  const botAddress = t.addressCount > 0;
  const ciRed = c.lastCi === "fail";

  if (!botAddress && !ciRed) {
    const tr = transition("6a", "converged", { cfg: FSM });
    exit(c, "6a", tr.reason);
    c.pendingItems = t.items;
    await flushReplies(c);
    decide(c, "6a", tr.next, "converged");
    return finish("converged", "7", "clean");
  }

  // The bot-comment track has priority. When CI is also red this is a BATCHED round: the bot-fix
  // runs first, then the ci-fix track re-verifies against the bot-fixed tree, and both ride out on a
  // single push — preserving the "a bot fix often clears CI" bet without burning a separate round.
  c.pendingItems = t.items;
  if (botAddress) {
    c.activeBotTrack = true;
    c.batchedRound = ciRed;
    const tr = transition("6a", "advance", { cfg: FSM });
    return advance(c, "6a", tr.next, tr.reason);
  }

  // Bots clean, CI red — the ci-fix residual track, with decline items carried for step 7.
  c.activeBotTrack = false;
  return advance(c, "6a", "6b", "ci_red_residual");
}

// ── Step 6b, bot-comment track ────────────────────────────────────────────────────────────────────

async function runBotTrack(c: Ctx): Promise<Next> {
  const a = await c.o.apply({ round: c.round, runDir: c.o.runDir });
  spawned(c, "6b", "implementer", a.terminalState, "applied");

  if (a.terminalState === "noop") {
    // The maker ran clean but produced no diff: the flagged items were already fixed. Not a failure,
    // so it must not burn a retry.
    if (c.batchedRound) {
      // No bot edit was produced, so nothing is pending to push and the ci-fix track behaves as the
      // standalone residual. pendingItems is carried for the reply.
      c.activeBotTrack = false;
      exit(c, "6b", "bot_noop_to_cifix");
      return go("6b");
    }
    exit(c, "6b", "apply_noop");
    await flushReplies(c);
    if (c.lastCi === "pass") return finish("converged", "7", "noop_clean");

    let ciFailures: CiFailure[] = [];
    try {
      ciFailures = await c.o.gh.listFailingChecks(c.headSha);
    } catch {
      /* best-effort */
    }
    await postCiRedComment(c.o.gh, c.o.pr, c.round, ciFailures);
    checkpoint(c, "ci_red_human", { ci: c.lastCi });
    return finish("deferred", "6b", "ci_red_human");
  }

  if (a.terminalState === "done") {
    if (c.batchedRound) {
      // The bot-fix is in the tree — don't push yet. Switch to the ci-fix track within this same 6b,
      // so both fixes push together at step 5.
      c.pendingBotFix = true;
      c.activeBotTrack = false;
      exit(c, "6b", "bot_fixed_batched");
      return go("6b");
    }
    const tr = transition("6b", "advance", { attempt: c.applyAttempt, cfg: FSM });
    return advance(c, "6b", tr.next, tr.reason);
  }

  // failed — a genuine error; retry up to maxImplementRetries.
  const tr = transition("6b", "retry", { attempt: c.applyAttempt, cfg: FSM });
  c.applyAttempt++;
  exit(c, "6b", tr.reason);
  decide(c, "6b", tr.next, "retry");
  if (tr.next === "aborted") return finish("capped", "aborted", tr.reason);
  return go(tr.next);
}

// ── Step 6b, ci-fix track ─────────────────────────────────────────────────────────────────────────

const isSpecFile = (f: string): boolean => /\.spec\.tsx?$|\.test\.tsx?$/.test(f);

/**
 * CI's authoritative failing-spec list, read only for a standalone residual. Handing the fixer the
 * WHOLE red set lets it spot one changed value driving locators across many specs.
 *
 * Returns null when red CI reports zero genuine failed specs — shard or infra death, with nothing
 * actionable for the fixer and (standalone) nothing pending to re-trigger with.
 */
async function readFailingSpecs(c: Ctx): Promise<string[] | null> {
  try {
    const failing = await c.o.gh.getFailingSpecs(c.headSha);
    helper(c, "6b", "getFailingSpecs", 0,
      `${failing.specPaths.length} failing spec(s)${failing.shardOnlyFailure ? " (shard-only)" : ""}`);
    if (failing.shardOnlyFailure && failing.specPaths.length === 0) return null;
    return failing.specPaths;
  } catch {
    // No artifact or an unreadable one — fall through with annotations only.
    return [];
  }
}

/**
 * A `handoff` caused purely by the wall-clock cap that left a dirty, spec-only tree is a
 * completed-but-unverified fix rather than a failure: opencode's edits are atomic per hunk, so what
 * landed is whole and the fixer merely never self-checked. Promoting it to `fixed` lets the static
 * gate green-light the push and makes CI the arbiter of the spec itself.
 *
 * Narrow by design — only a timeout, only a dirty tree, only spec files. A half-timed-out source
 * edit stays a handoff, because auto-committing source on a timeout is a different risk.
 */
function isSalvageableTimeout(cf: { outcome: string; timedOut?: boolean; filesChanged?: string[] }): boolean {
  return (
    cf.outcome === "handoff" &&
    cf.timedOut === true &&
    (cf.filesChanged?.length ?? 0) > 0 &&
    cf.filesChanged!.every(isSpecFile)
  );
}

/**
 * The 4b guard over a fixer's spec edit, before it is pushed. A test-stale fix edits an assertion,
 * which is exactly the "green but wrong" risk the test-grader exists for: the fixer could match the
 * assertion to the wrong current output, or weaken it.
 *
 * Returns the handoff when the grader blocks, or null to proceed. Skipped when no spec was touched
 * or no grader is injected; a grader throw is non-blocking, since a grader failure must not strand a
 * mergeable fix.
 */
async function gradeSpecEdit(c: Ctx, filesChanged: string[]): Promise<Next | null> {
  if (!filesChanged.some(isSpecFile) || !c.o.testGrade) return null;

  let graded: { blocking: boolean; summary?: string } = { blocking: false };
  try {
    graded = await c.o.testGrade({ round: c.round, runDir: c.o.runDir });
  } catch (e) {
    helper(c, "6b", "ci-fix spec 4b-guard", 0,
      `grader threw (non-blocking): ${(e as Error).message}`);
  }
  spawned(c, "6b", "care-test-grader", graded.blocking ? "wrong" : "ok", "ci_fix_spec_guard");
  if (!graded.blocking) return null;

  exit(c, "6b", "ci_fix_spec_wrong");
  await flushReplies(c);
  try {
    await c.o.gh.createComment(
      c.o.pr,
      `**care-loop: CI-fix edited a test, but the test-grader flagged it as wrong (round ${c.round})**\n\n` +
        `The CI-fixer changed a spec to clear a red check, but 4b judged the edit does not match the ` +
        `plan's acceptance criteria — shipping it would be "green but wrong". Leaving this for a human.` +
        (graded.summary ? `\n\n${graded.summary}` : "") +
        `\n\n— care-loop 🤖`,
    );
  } catch {
    /* best-effort */
  }
  checkpoint(c, "ci_fix_spec_wrong", { ci: c.lastCi });
  return finish("deferred", "6b", "ci_fix_spec_wrong");
}

async function runCiFixTrack(c: Ctx): Promise<Next> {
  // No local spec pre-check: in a batched round the fixer re-verifies each CI failure against the
  // current tree and no-ops when the bot-fix already cleared them. CI, not a local run, is the
  // arbiter of "still red".
  let failingSpecs: string[] = [];
  if (!c.pendingBotFix) {
    const specs = await readFailingSpecs(c);
    if (specs === null) {
      exit(c, "6b", "ci_shard_infra");
      await flushReplies(c);
      checkpoint(c, "ci_shard_infra", { ci: c.lastCi });
      return finish("deferred", "6b", "ci_shard_infra");
    }
    failingSpecs = specs;
  }

  // Annotations (file:line:message) let the fixer read the exact failing assertion. A superset of
  // listFailingChecks, so one call feeds both this and the human PR comment.
  let ciFailures: CiFailure[] = [];
  try {
    ciFailures = await c.o.gh.getCheckFailureContext(c.headSha);
  } catch {
    /* best-effort */
  }

  if (!c.o.ciFix) {
    if (c.pendingBotFix) {
      // No fixer, but a bot-fix is pending: push it and let CI re-run. The residual red is
      // re-evaluated next round, when bots are clean and nothing would be stranded by a handoff.
      exit(c, "6b", "cifix_none_push_botfix");
      decide(c, "6b", "5", "advance");
      return go("5");
    }
    spawned(c, "6b", "ci-fixer", "handoff", "no_ci_fixer");
    exit(c, "6b", "no_ci_fixer");
    return handoffCiRed(c, ciFailures);
  }

  const cf = await c.o.ciFix({
    round: c.round,
    runDir: c.o.runDir,
    ciFailures,
    failingSpecs,
    // In a batched round the tree already carries the bot-fix, so the fixer must re-verify the
    // pre-bot-fix failures against the CURRENT tree rather than a stale snapshot.
    findings: c.pendingBotFix
      ? "A bot-comment fix was just applied to this worktree (uncommitted). The CI failures below " +
        "were reported on the commit BEFORE it — re-verify each against the CURRENT tree before " +
        "changing anything; some may already be resolved."
      : undefined,
  });
  spawned(c, "6b", "ci-fixer", cf.outcome, cf.outcome);

  const salvaged = isSalvageableTimeout(cf);
  if (salvaged) {
    helper(c, "6b", "ci-fix salvage-timeout", 0,
      `fixer timed out (exit 124) with ${cf.filesChanged!.length} spec edit(s) — gating instead of discarding`);
  }

  if (salvaged || cf.outcome === "fixed") {
    const blocked = await gradeSpecEdit(c, cf.filesChanged ?? []);
    if (blocked) return blocked;
    exit(c, "6b", "ci_fixed");
    decide(c, "6b", "5", "advance");
    return go("5");
  }

  // handoff or noop — the fixer could not clear CI this round.
  if (c.pendingBotFix) {
    // Don't strand the pending bot-fix in a handoff: push it and let CI re-run, since a flaky red
    // often clears on a fresh run. Bots are clean next round, which takes the standalone path and
    // hands off then if the failure is genuine — so a flake gets exactly one re-trigger.
    exit(c, "6b", "cifix_noop_push_botfix");
    decide(c, "6b", "5", "advance");
    return go("5");
  }
  exit(c, "6b", "ci_red_human");
  return handoffCiRed(c, ciFailures);
}

async function stepResolve(c: Ctx): Promise<Next> {
  enter(c, "6b");
  return c.activeBotTrack ? runBotTrack(c) : runCiFixTrack(c);
}

// ── Step 5 — gate, then push ──────────────────────────────────────────────────────────────────────

/** Push, reply out the round's threads now that its fixes are live, and go back to waiting. */
async function pushAndAwait(c: Ctx): Promise<Next> {
  const p = c.o.push({ round: c.round, runDir: c.o.runDir });
  c.headSha = p.headSha ?? c.headSha;
  c.sinceIso = new Date().toISOString();
  c.j.append({
    event: "push",
    data: { exit: p.exit, head_sha: c.headSha, state: { head_sha: c.headSha } },
  });
  await flushReplies(c);
  const tr = transition("5", "gate-ok", { cfg: FSM });
  return advance(c, "5", tr.next, tr.reason, "gate-ok");
}

/**
 * Feed the gate's errors back to whichever track dirtied the tree and re-try, up to
 * maxImplementRetries. Returns the next step when the loopback resolves it, or null to fall through
 * to gate-blocked.
 */
async function gateLoopback(c: Ctx, gateSummary: string): Promise<Next | null> {
  c.gateAttempt++;
  if (c.gateAttempt > FSM.maxImplementRetries) return null;

  exit(c, "5", `gate_red_loopback_${c.gateAttempt}`);
  const findings =
    `Your previous change did not pass the local gate — fix these errors, change only what's needed:\n${gateSummary}`;

  enter(c, "6b");
  const botActive = c.activeBotTrack;
  let reapplied: { terminalState: "done" | "failed" | "noop" };
  if (botActive) {
    reapplied = await c.o.apply({ round: c.round, runDir: c.o.runDir, findings });
  } else if (c.o.ciFix) {
    let ciFailures: CiFailure[] = [];
    try {
      ciFailures = await c.o.gh.getCheckFailureContext(c.headSha);
    } catch {
      /* best-effort */
    }
    const cf = await c.o.ciFix({ round: c.round, runDir: c.o.runDir, ciFailures, findings });
    reapplied = { terminalState: cf.outcome === "fixed" ? "done" : "failed" };
  } else {
    reapplied = { terminalState: "failed" };
  }
  spawned(c, "6b", botActive ? "implementer" : "ci-fixer", reapplied.terminalState, "gate_reapply");

  if (reapplied.terminalState !== "done") return null;

  const retry = c.o.gate({ round: c.round, runDir: c.o.runDir });
  helper(c, "5", "run_gate.sh (retry)", retry.exit, retry.summary);
  if (retry.exit === 0) return pushAndAwait(c);

  exit(c, "5", "gate_red_after_reapply");
  return null;
}

async function stepGateAndPush(c: Ctx): Promise<Next> {
  c.round++;
  c.applyAttempt = 1;
  c.gateAttempt = 0;
  if (c.round > c.cfg.maxRounds) {
    c.j.append({ event: "budget.stop", data: { reason_code: "max_rounds", round: c.round } });
    return finish("capped", "5", "max_rounds");
  }

  enter(c, "5");
  // Static gate only (tsc/lint/build/vitest) — Playwright specs are verified by CI post-push — so a
  // red gate here is a genuine code, type, lint, or build failure.
  const g = c.o.gate({ round: c.round, runDir: c.o.runDir });
  helper(c, "5", "run_gate.sh", g.exit, g.summary);

  if (g.exit !== 0) {
    const resolved = await gateLoopback(c, g.summary);
    if (resolved) return resolved;
    exit(c, "5", "gate_red");
    return finish("gate-blocked", "3", "gate_red");
  }
  return pushAndAwait(c);
}

// ── Driver ────────────────────────────────────────────────────────────────────────────────────────

type StepFn = (c: Ctx) => Promise<Next>;

const STEPS: Record<string, StepFn> = {
  "5-await": stepAwaitCi,
  "6a": stepTriage,
  "6b": stepResolve,
  "5": stepGateAndPush,
};

function seedJournal(c: Ctx): void {
  if (c.j.read().events.length > 0) return;
  c.j.append({
    event: "run.start",
    step: "5-await",
    round: c.round,
    data: {
      state: {
        task: `CI rounds PR#${c.o.pr}`,
        repo: c.o.repo,
        branch: c.o.branch,
        worktree: c.o.runDir,
        tier: "standard",
        pr: c.o.pr,
        round: c.round,
        step: "5-await",
        head_sha: c.headSha,
        last_reviewed_sha: "",
        updated_at: new Date().toISOString(),
      },
    },
  });
}

export async function runCiRounds(o: CiRoundsOptions): Promise<CiRoundsResult> {
  const cfg = {
    maxRounds: 5,
    pollTimeoutMs: 30 * 60_000,
    pollIntervalMs: 60_000,
    ciGraceMs: 120_000,
    ...o.cfg,
  };
  const runId = `${o.repo.replace("/", "-")}-${o.branch}`;
  const c: Ctx = {
    o,
    cfg,
    j: new Journal(join(o.runDir, "journal.jsonl"), runId),
    round: o.startRound ?? 1,
    headSha: o.headSha,
    sinceIso: o.sinceIso,
    lastCi: "none",
    activeBotTrack: false,
    applyAttempt: 1,
    gateAttempt: 0,
    batchedRound: false,
    pendingBotFix: false,
  };
  seedJournal(c);

  let step: Step = "5-await";
  let outcome: CiOutcome = "capped";

  // Bounded independently of the FSM: six transitions per round plus slack, so a step function that
  // never reaches a terminal cannot spin forever.
  const guard = cfg.maxRounds * 6 + 6;
  for (let i = 0; i < guard; i++) {
    const runStep: StepFn | undefined = STEPS[step];
    if (!runStep) break; // terminal step
    const next: Next = await runStep(c);
    if (next.kind === "end") {
      c.j.append({
        event: "run.end",
        data: {
          outcome: next.outcome,
          reason_code: next.reason,
          state: { step: next.step, round: c.round },
        },
      });
      outcome = next.outcome;
      break;
    }
    step = next.step;
    projectAndWrite(o.runDir, c.j.read().events);
  }

  const events = c.j.read().events;
  writeFileSync(join(o.runDir, "loop.log"), renderLoopLog(events));
  const state = projectAndWrite(o.runDir, events);
  return { outcome, rounds: c.round, state };
}
