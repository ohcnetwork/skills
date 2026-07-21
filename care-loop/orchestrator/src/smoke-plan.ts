// smoke-plan.ts — prove the STEP-1 plan stage works STANDALONE against a real care_fe checkout: the
// real opencode Opus planner (both structured phases — interview then draft) driven through the
// invariant runPlan core with a SCRIPTED auto-approve gate (no human needed). A PASS proves the two
// planner schemas return valid structured output on the free-port transport and that runPlan persists
// the artifacts + plan.approved — the analog of smoke-reviewer for the 4th skill. Standing rule: never
// run the interactive `plan` for real until this proves the planner alone works.
//
// Run:  cd care-loop/orchestrator && npm run smoke:plan
// Needs: opencode authed to GitHub Copilot; a care_fe checkout at ~/Desktop/care_fe (override CARE_FE).

import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlan } from "./plan.js";
import { defaultPlanSeams } from "./default-wiring.js";
import type { PlanGate, PlanInput } from "./ports.js";

const REPO = process.env.CARE_FE ?? join(process.env.HOME ?? "", "Desktop/care_fe");
const TASK = process.env.SMOKE_TASK ?? "Add an expiry-date column to the supply delivery table";

/** Auto gate: answer every interview question with a canned line, then approve on the first ask. */
const autoGate: PlanGate = {
  async interview(questions) {
    console.log(`  interview: ${questions.length} question(s)`);
    for (const q of questions) console.log(`    • ${q.prompt}`);
    return questions.map((q) => ({ id: q.id, answer: "Use the existing table conventions; no backend change; keep it responsive." }));
  },
  async approve(ask) {
    console.log(`  gate: Planned by: ${ask.plannedBy}  tier=${ask.classification}  criteria=${ask.criteria.length}`);
    return { decision: "approve" };
  },
};

async function main(): Promise<void> {
  const runDir = mkdtempSync(join(tmpdir(), "careloopd-smoke-plan-"));
  const input: PlanInput = {
    task: TASK,
    ticket: "ENG-613",
    branch: "smoke/plan",
    summary: "smoke plan",
    repo: "ohcnetwork/care_fe",
    mainRepoPath: REPO,
    worktree: join(runDir, "wt"),
    runDir,
  };
  const { planner } = defaultPlanSeams({ repo: input.repo, branch: input.branch, runDir });

  const t0 = Date.now();
  const res = await runPlan({ input, planner, gate: autoGate });
  const s = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n  outcome=${res.outcome} reason=${res.reasonCode} tier=${res.classification ?? "-"}  (${s}s)`);
  const files = ["criteria.md", "baseline.md", "decisions.md", "ui-surfaces.md"].filter((f) => existsSync(join(runDir, f)));
  console.log(`  artifacts: ${files.join(", ")}`);
  if (existsSync(join(runDir, "criteria.md"))) {
    console.log(`  criteria.md:\n${readFileSync(join(runDir, "criteria.md"), "utf8").split("\n").map((l) => "    " + l).join("\n")}`);
  }
  const ok = res.outcome === "approved" && existsSync(join(runDir, "criteria.md")) && existsSync(join(runDir, "baseline.md"));
  console.log(ok ? "\n✅ plan smoke PASSED" : "\n❌ plan smoke FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("plan smoke error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
