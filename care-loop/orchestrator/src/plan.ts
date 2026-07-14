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
import { Journal, type JournalEvent } from "./journal.js";
import { withLock } from "./lock.js";
import { projectAndWrite, type CareState, type Tier } from "./state.js";
import type { PlanAnswer, PlanGate, PlanInput, Planner, PlannerPayload, PlanQuestion } from "./ports.js";

export interface RunPlanOptions {
  input: PlanInput;
  planner: Planner; // typically withSkillLog-wrapped (default-wiring)
  gate: PlanGate; // supplied by the front (terminal / jira / pr)
  lockOpts?: { pid?: number; isAlive?: (pid: number) => boolean };
}

export interface PlanResult {
  outcome: "approved" | "rejected" | "aborted";
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
  const runId = `${input.repo.replace("/", "-")}-${input.branch}`;
  mkdirSync(input.runDir, { recursive: true });

  return withLock(
    input.runDir,
    async (): Promise<PlanResult> => {
      const j = new Journal(join(input.runDir, "journal.jsonl"), runId);

      // Seed the shared journal at step 1 ONLY when empty — `start` continues this same journal.
      if (j.read().events.length === 0) {
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
        };
        j.append({ event: "run.start", step: "1", round: 1, data: { state: seed } });
      }
      j.append({ event: "step.enter", step: "1", round: 1 });

      let spawn = 1; // monotonic spawn counter → distinct logging sidecars (interview=1, drafts=2..)

      // ── Phase 1+2 — recon + interview ──────────────────────────────────────────────────────────
      const iv = await o.planner({ task: input.task, ticket: input.ticket, mainRepoPath: input.mainRepoPath, runDir: input.runDir, phase: "interview", round: spawn++ });
      const questions: PlanQuestion[] = iv.payload.questions ?? [];
      let answers: PlanAnswer[] = [];
      if (questions.length > 0) {
        j.append({ event: "gate.asked", step: "1", round: 1, data: { count: questions.length } });
        answers = await o.gate.interview(questions);
        j.append({ event: "gate.answered", step: "1", round: 1, data: { count: answers.length } });
      }

      // ── Phase 3+4 — draft, then the consolidated gate; amend re-drafts UNBOUNDED ───────────────
      let amendment: string | undefined;
      let draft = await o.planner({ task: input.task, ticket: input.ticket, mainRepoPath: input.mainRepoPath, runDir: input.runDir, phase: "plan", questions, answers, amendment, round: spawn++ });

      for (;;) {
        // Model-pin enforcement: abort if opencode reports the planner ran on the wrong engine.
        // Checked against modelPinSatisfied (opencode's own report: modelReported.includes(configuredModel))
        // rather than the /opus/i self-report heuristic. `=== false` is intentional — undefined means the
        // model was unverifiable (e.g. a fake in tests), which is not a failure. This unblocks local judgment
        // models (configured in models.json) while still catching a genuine wrong-tier run.
        if (draft.payload.modelPinSatisfied === false) {
          const plannedBy = draft.payload.plannedBy ?? "unknown";
          j.append({ event: "run.end", step: "1", data: { outcome: "aborted", reason_code: "plan_wrong_tier", planned_by: plannedBy, state: { step: "aborted" } } });
          projectAndWrite(input.runDir, j.read().events);
          return { outcome: "aborted", reasonCode: "plan_wrong_tier", runDir: input.runDir };
        }

        writeArtifacts(input, draft.payload, questions, answers);

        const decision = await o.gate.approve(consolidatedAsk(input, draft.payload));
        if (decision.decision === "approve") break;
        if (decision.decision === "reject") {
          j.append({ event: "run.end", step: "1", data: { outcome: "aborted", reason_code: "plan_rejected", state: { step: "aborted" } } });
          projectAndWrite(input.runDir, j.read().events);
          return { outcome: "rejected", reasonCode: "plan_rejected", runDir: input.runDir };
        }
        // amend → fold the free-text into a fresh draft, rewrite the artifacts, ask again
        amendment = decision.amendment;
        j.append({ event: "decision", step: "1", round: 1, data: { note: "amend" } });
        draft = await o.planner({ task: input.task, ticket: input.ticket, mainRepoPath: input.mainRepoPath, runDir: input.runDir, phase: "plan", questions, answers, amendment, round: spawn++ });
      }

      // ── Approved — record it + authorize push, advance the shared journal to step 2 ────────────
      const tier = (draft.payload.classification ?? "standard") as Tier;
      j.append({ event: "plan.approved", step: "1", round: 1, data: { planned_by: draft.payload.plannedBy, classification: tier, push_authorized: true, state: { tier } } });
      j.append({ event: "step.exit", step: "1", round: 1, data: { reason_code: "plan_ready" } });
      j.append({ event: "decision", step: "1", round: 1, data: { from: "1", to: "2", signal: "advance" } });
      projectAndWrite(input.runDir, j.read().events);
      return { outcome: "approved", reasonCode: "plan_ready", classification: tier, runDir: input.runDir };
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
    testPlan: p.testSurface ?? (p.classification === "trivial" ? "skip — trivial change" : "(no test surface stated)"),
    pushAuthNote: `Approval authorizes the loop to push commits and open/update a PR on origin (${input.repo}).`,
  };
}

/** Persist the plan artifacts the downstream runners consume (guides/01-plan.md "Persist to the run
 *  dir"): criteria.md (Step-4b grader + Step-3), baseline.md (Scope Governor + test-surface for the
 *  e2e author), decisions.md (6a triage citation-declines), ui-surfaces.md (Step-4c, only when .tsx). */
function writeArtifacts(input: PlanInput, p: PlannerPayload, questions: PlanQuestion[], answers: PlanAnswer[]): void {
  const write = (name: string, body: string) => writeFileSync(join(input.runDir, name), body.endsWith("\n") ? body : body + "\n");

  const criteria = (p.criteria ?? []).map((c) => `- ${c}`).join("\n") || "- (none stated)";
  write("criteria.md", `# Acceptance criteria — ${input.ticket}\n\n${criteria}\n`);

  const files = (p.files ?? []).map((f) => `- ${f}`).join("\n") || "- (none stated)";
  const testSurface = p.testSurface ? `\n## Test-surface contract (seams the e2e author needs)\n\n${p.testSurface}\n` : "";
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
      ? questions.map((q) => `- **${q.prompt}**\n  ${answers.find((a) => a.id === q.id)?.answer ?? "(no answer)"}`).join("\n")
      : "- (no interview questions)";
  const nonGoals = (p.nonGoals ?? []).map((n) => `- ${n}`).join("\n") || "- (none stated)";
  write("decisions.md", `# Decisions — ${input.ticket}\n\n## Interview\n\n${qa}\n\n## Non-goals\n\n${nonGoals}\n`);

  if (p.uiSurfaces) write("ui-surfaces.md", p.uiSurfaces);
}
