// plan.ts — the COMMON CORE of the interactive plan stage (Step 1), invariant across every workflow.
//
// It is deliberately transport-agnostic: it drives the planner skill + a `PlanGate` through the one
// sequence every workflow shares — recon/interview → draft → present the consolidated ask → LOOP on
// amendments until the human approves (or rejects) → persist the plan artifacts + a `plan.approved`
// journal event → hand off to the autonomous `start` loop. The pluggable `PlanFront` (plan-front.ts)
// supplies the {input, gate}; this file never knows whether that gate is a terminal, a Jira comment,
// or a PR thread. That is the whole point — a new workflow adds a front, never touches this core.
//
// Persistence rides the SAME hash-chained journal `start` continues (pipeline seeds run.start only when
// empty), so `plan` → `start` is one continuous run dir: run.start@1 → …plan.approved → decision 1→2.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JournalEvent } from "./journal.js";
import { withLock } from "./lock.js";
import { openRun, resolveRequestedBy } from "./run-context.js";
import { projectAndWrite, type CareState, type Tier } from "./state.js";
import type {
  PlanAnswer,
  PlanGate,
  PlanInput,
  Planner,
  PlannerPayload,
  PlanQuestion,
} from "./ports.js";
import {
  GateCancelledError,
  GateExpiredError,
  GateSuspendedError,
  type ApprovalDecision,
  type PlanRestore,
} from "./plan-gate.js";

export interface RunPlanOptions {
  input: PlanInput;
  planner: Planner; // typically withSkillLog-wrapped (default-wiring)
  gate: PlanGate; // supplied by the front (terminal / jira / pr)
  lockOpts?: { pid?: number; isAlive?: (pid: number) => boolean };
  /** Resume a stage that SUSPENDED at its gate ([[PLAN-loop-service]] §7) instead of re-running it.
   *  Plain data assembled by the caller, so this resume path costs the loop no dependency on whatever
   *  persisted it. */
  restore?: PlanRestore | null;
}

export interface PlanResult {
  /** `suspended` is not a failure: the plan is drafted and waiting on a human, and the caller should
   *  exit so the run stops holding a concurrency slot. It resumes when the gate is answered. */
  outcome: "approved" | "rejected" | "aborted" | "suspended";
  reasonCode: string;
  classification?: Tier;
  runDir: string;
}

/** True when the run dir's journal carries an approved plan — `start`'s guard reads this. */
export function hasApprovedPlan(events: JournalEvent[]): boolean {
  return events.some((e) => e.event === "plan.approved");
}

export async function runPlan(o: RunPlanOptions): Promise<PlanResult> {
  const { input } = o;
  mkdirSync(input.runDir, { recursive: true });

  return withLock(
    input.runDir,
    async (): Promise<PlanResult> => {
      const { journal: j, runId, isNew } = openRun(input.runDir);

      // Seed the shared journal at step 1 ONLY when empty — `start` continues this same journal.
      if (isNew) {
        const seed: CareState = {
          task: input.task,
          repo: input.repo,
          branch: input.branch,
          worktree: input.worktree,
          tier: "standard",
          pr: null,
          round: 1,
          step: "1",
          head_sha: "scratch",
          last_reviewed_sha: "",
          updated_at: new Date().toISOString(),
          run_id: runId,
          requested_by: resolveRequestedBy(),
          // ticket/summary are known at the plan stage (PlanInput always carries them) — promoted
          // into CareState (PLAN-sqlite-run-store.md §6) instead of being event-only.
          ticket: input.ticket,
          summary: input.summary,
          started_at: new Date().toISOString(),
        };
        j.append({
          event: "run.start",
          step: "1",
          round: 1,
          data: { state: seed },
        });
      }
      j.append({ event: "step.enter", step: "1", round: 1 });

      let spawn = 1; // monotonic spawn counter → distinct logging sidecars (interview=1, drafts=2..)

      /** Record the approval and advance the journal to step 2. Shared by the normal path and by a
       *  gate RESUME, which reaches this having called no planner at all — `plannedBy` and
       *  `classification` are the only two fields it needs, and both are in the ask the human saw. */
      const finishApproved = (plannedBy: string | undefined, classification: string): PlanResult => {
        const tier = (classification ?? "standard") as Tier;
        j.append({
          event: "plan.approved",
          step: "1",
          round: 1,
          data: {
            planned_by: plannedBy,
            classification: tier,
            push_authorized: true,
            // ticket/summary are persisted here so a build-stage RESUME (a crash after approval but
            // before the PR is opened) can reopen the PR from the journal alone — no re-supplied flags.
            ticket: input.ticket,
            summary: input.summary,
            state: { tier },
          },
        });
        j.append({ event: "step.exit", step: "1", round: 1, data: { reason_code: "plan_ready" } });
        j.append({
          event: "decision",
          step: "1",
          round: 1,
          data: { from: "1", to: "2", signal: "advance" },
        });
        projectAndWrite(input.runDir, j.read().events);
        return { outcome: "approved", reasonCode: "plan_ready", classification: tier, runDir: input.runDir };
      };

      /** End the stage the way a non-answer requires. Returns null for anything that is not a gate
       *  outcome, so a real error still propagates. */
      const endAtGate = (err: unknown): PlanResult | null => {
        if (err instanceof GateSuspendedError) {
          // NOT a failure. The plan is drafted, the artifacts are on disk, the ask is open — the run
          // is simply not worth a concurrency slot while it waits on a person.
          j.append({ event: "gate.suspended", step: "1", round: 1, data: { ask_id: err.askId } });
          projectAndWrite(input.runDir, j.read().events);
          return { outcome: "suspended", reasonCode: "gate_unanswered", runDir: input.runDir };
        }
        const reason =
          err instanceof GateCancelledError
            ? "cancelled"
            : err instanceof GateExpiredError
              ? "gate_timeout"
              : null;
        if (reason === null) return null;
        // Reached by unwinding, not by a signal — so the lock is released and the journal gets its
        // terminal event, where a SIGTERM would have left both hanging.
        j.append({
          event: "run.end",
          step: "1",
          data: { outcome: "aborted", reason_code: reason, state: { step: "aborted" } },
        });
        projectAndWrite(input.runDir, j.read().events);
        return { outcome: "aborted", reasonCode: reason, runDir: input.runDir };
      };

      // ── Resume a stage that suspended at its approval gate (§7) ────────────────────────────────
      // Everything the approval path needs was already durable: the artifacts are on disk from
      // before the ask, and `plannedBy`/`classification` are in the ask itself. So approve and
      // reject resume having called NO model; only amend re-invokes the planner, which is precisely
      // the work the human just asked for.
      const restored = o.restore ?? null;
      if (restored?.kind === "approve" && restored.answer && restored.ask) {
        const d = restored.answer;
        if (d.decision === "approve")
          return finishApproved(restored.ask.plannedBy, restored.ask.classification);
        if (d.decision === "reject") {
          j.append({
            event: "run.end",
            step: "1",
            data: { outcome: "aborted", reason_code: "plan_rejected", state: { step: "aborted" } },
          });
          projectAndWrite(input.runDir, j.read().events);
          return { outcome: "rejected", reasonCode: "plan_rejected", runDir: input.runDir };
        }
      }

      // ── Phase 1+2 — recon + interview ──────────────────────────────────────────────────────────
      // A restore already has both, so it skips this planner call as well: re-running recon to
      // rediscover questions a human has already answered is the most expensive way to learn nothing.
      let questions: PlanQuestion[];
      let answers: PlanAnswer[] = [];
      if (restored) {
        questions = restored.questions;
        answers = restored.answers;
      } else {
        const iv = await o.planner({
          task: input.task,
          ticket: input.ticket,
          mainRepoPath: input.mainRepoPath,
          runDir: input.runDir,
          phase: "interview",
          attachments: input.attachments,
          round: spawn++,
          step: "1",
        });
        questions = iv.payload.questions ?? [];
        if (questions.length > 0) {
          j.append({
            event: "gate.asked",
            step: "1",
            round: 1,
            data: { count: questions.length },
          });
          try {
            answers = await o.gate.interview(questions);
          } catch (err) {
            const end = endAtGate(err);
            if (end) return end;
            throw err;
          }
          j.append({
            event: "gate.answered",
            step: "1",
            round: 1,
            data: { count: answers.length },
          });
        }
      }

      // ── Phase 3+4 — draft, then the consolidated gate; amend re-drafts UNBOUNDED ───────────────
      let amendment: string | undefined;
      let draft = await o.planner({
        task: input.task,
        ticket: input.ticket,
        mainRepoPath: input.mainRepoPath,
        runDir: input.runDir,
        phase: "plan",
        questions,
        answers,
        amendment,
        attachments: input.attachments,
        round: spawn++,
        step: "1",
      });

      for (;;) {
        // Model-pin enforcement: abort if opencode reports the planner ran on the wrong engine.
        // Checked against modelPinSatisfied (opencode's own report: modelReported.includes(configuredModel))
        // rather than the /opus/i self-report heuristic. `=== false` is intentional — undefined means the
        // model was unverifiable (e.g. a fake in tests), which is not a failure. This unblocks local judgment
        // models (configured in models.json) while still catching a genuine wrong-tier run.
        if (draft.payload.modelPinSatisfied === false) {
          const plannedBy = draft.payload.plannedBy ?? "unknown";
          j.append({
            event: "run.end",
            step: "1",
            data: {
              outcome: "aborted",
              reason_code: "plan_wrong_tier",
              planned_by: plannedBy,
              state: { step: "aborted" },
            },
          });
          projectAndWrite(input.runDir, j.read().events);
          return {
            outcome: "aborted",
            reasonCode: "plan_wrong_tier",
            runDir: input.runDir,
          };
        }

        writeArtifacts(input, draft.payload, questions, answers);

        let decision: ApprovalDecision;
        try {
          decision = await o.gate.approve(consolidatedAsk(input, draft.payload));
        } catch (err) {
          const end = endAtGate(err);
          if (end) return end;
          throw err;
        }
        if (decision.decision === "approve") break;
        if (decision.decision === "reject") {
          j.append({
            event: "run.end",
            step: "1",
            data: {
              outcome: "aborted",
              reason_code: "plan_rejected",
              state: { step: "aborted" },
            },
          });
          projectAndWrite(input.runDir, j.read().events);
          return {
            outcome: "rejected",
            reasonCode: "plan_rejected",
            runDir: input.runDir,
          };
        }
        // amend → fold the free-text into a fresh draft, rewrite the artifacts, ask again
        amendment = decision.amendment;
        j.append({
          event: "decision",
          step: "1",
          round: 1,
          data: { note: "amend" },
        });
        draft = await o.planner({
          task: input.task,
          ticket: input.ticket,
          mainRepoPath: input.mainRepoPath,
          runDir: input.runDir,
          phase: "plan",
          questions,
          answers,
          amendment,
          attachments: input.attachments,
          round: spawn++,
          step: "1",
        });
      }

      // ── Approved — record it + authorize push, advance the shared journal to step 2 ────────────
      return finishApproved(
        draft.payload.plannedBy,
        draft.payload.classification ?? "standard",
      );
    },
    o.lockOpts,
  );
}

/** Build the single consolidated gate ask from the drafted plan + the run input. */
function consolidatedAsk(input: PlanInput, p: PlannerPayload) {
  return {
    plannedBy: p.plannedBy ?? "(unstated)",
    summary: p.scope ?? input.task,
    criteria: p.criteria ?? [],
    classification: p.classification ?? "standard",
    testPlan:
      p.testSurface ??
      (p.classification === "trivial"
        ? "skip — trivial change"
        : "(no test surface stated)"),
    pushAuthNote: `Approval authorizes the loop to push commits and open/update a PR on origin (${input.repo}).`,
  };
}

/** Persist the plan artifacts the downstream runners consume (the `care-planner` skill, "Persist to the run
 *  dir"): criteria.md (Step-4b grader + Step-3), baseline.md (Scope Governor + test-surface for the
 *  e2e author), decisions.md (6a triage citation-declines), ui-surfaces.md (Step-4c, only when .tsx). */
function writeArtifacts(
  input: PlanInput,
  p: PlannerPayload,
  questions: PlanQuestion[],
  answers: PlanAnswer[],
): void {
  const write = (name: string, body: string) =>
    writeFileSync(
      join(input.runDir, name),
      body.endsWith("\n") ? body : body + "\n",
    );

  const criteria =
    (p.criteria ?? []).map((c) => `- ${c}`).join("\n") || "- (none stated)";
  write(
    "criteria.md",
    `# Acceptance criteria — ${input.ticket}\n\n${criteria}\n`,
  );

  const files =
    (p.files ?? []).map((f) => `- ${f}`).join("\n") || "- (none stated)";
  const testSurface = p.testSurface
    ? `\n## Test-surface contract (seams the e2e author needs)\n\n${p.testSurface}\n`
    : "";
  write(
    "baseline.md",
    `# Scope baseline — ${input.ticket}\n\n` +
      `planned-by: ${p.plannedBy ?? "(unstated)"}\n` +
      `request: ${input.task}\n` +
      `branch: ${input.branch}\n` +
      `owner-boundary: ${input.repo}\n` +
      `classification: ${p.classification ?? "standard"}\n\n` +
      `## Approach\n\n${p.approach ?? "(none stated)"}\n\n` +
      `## Planned files\n\n${files}\n${testSurface}`,
  );

  const qa =
    questions.length > 0
      ? questions
          .map(
            (q) =>
              `- **${q.prompt}**\n  ${answers.find((a) => a.id === q.id)?.answer ?? "(no answer)"}`,
          )
          .join("\n")
      : "- (no interview questions)";
  const nonGoals =
    (p.nonGoals ?? []).map((n) => `- ${n}`).join("\n") || "- (none stated)";
  write(
    "decisions.md",
    `# Decisions — ${input.ticket}\n\n## Interview\n\n${qa}\n\n## Non-goals\n\n${nonGoals}\n`,
  );

  if (p.uiSurfaces) write("ui-surfaces.md", p.uiSurfaces);
}
