// Phase-2 spike — prove opencode + GitHub Copilot drives a pinned judgment role headlessly and
// returns a schema-valid JobResult (PLAN-orchestrator-architecture §10 phase 2, the build's own
// abort criterion). NOT the FSM, NOT grading — just: does the runner boundary work end-to-end,
// off the VS Code chat turn, on the Copilot subscription?
//
// Target diff: the care-evals cr-01 fixture (a real seeded-defect diff with 3 planted issues), so a
// PASS also gives an eyeball signal that the reviewer actually reasoned about the code.
//
// Run:  cd care-loop/orchestrator && npm install && OC_MODEL=claude-opus-4.8 npm run spike:reviewer
// Needs: opencode authed to GitHub Copilot (`opencode auth login` → GitHub Copilot).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runJudgmentSpawn } from "./opencode-runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../../.."); // care-loop/orchestrator/src → skills/
const FIXTURE = resolve(REPO, "care-evals/tasks/cr-01-invoice-discount-bug");
const OUT_DIR = resolve(__dirname, "../.spike");

const PROVIDER = process.env.OC_PROVIDER ?? "github-copilot";
const MODEL = process.env.OC_MODEL ?? "claude-opus-4.8";

// Reviewer role prompt (the essence of care-reviewer/care-technical-review, purpose-built for the
// spike; production swaps in the opencode reviewer skill from skills-opencode.ts). The model MUST
// end by emitting a JobResult — opencode's structured-output layer enforces the shape.
const SYSTEM = `You are the care-loop code reviewer (judgment tier). Review the supplied unified
diff for "worth deciding" issues only — real problems a maintainer would want to decide on before
merge. Judge three lenses:
- correctness: logic/behaviour bugs (wrong math, off-by-one, nullish, money errors).
- overengineering: needless abstraction/indirection disproportionate to the problem.
- legibility: misleading names, code that hides its intent.
Do not invent style nits. For each real issue, add one finding with its class, the file, a short
line_hint copied from the diff, and a one-sentence note. Set verdict="findings" if you found any,
else "pass". Fill model_used with the model you are running as. Respond ONLY as the required
JobResult object.`;

function buildTask(): string {
  const taskMd = readFileSync(resolve(FIXTURE, "task.md"), "utf8");
  const diff = readFileSync(resolve(FIXTURE, "fixture.patch"), "utf8");
  // Strip the task.md frontmatter/ground-truth hints so we don't hand the reviewer the answers —
  // it must find the defects from the diff alone. Keep only the one-line framing.
  return [
    "Review this diff. It adds a small billing feature. Find the worth-deciding issues.",
    "",
    "=== DIFF ===",
    diff,
    "=== END DIFF ===",
  ].join("\n");
}

async function main() {
  console.log(
    `▶ spike: care-reviewer on ${PROVIDER}/${MODEL} (opencode + Copilot, headless)`,
  );
  console.log(`  target: cr-01 fixture (3 seeded defects)\n`);

  const started = Date.now();
  const outcome = await runJudgmentSpawn({
    role: "care-reviewer",
    providerID: PROVIDER,
    modelID: MODEL,
    system: SYSTEM,
    task: buildTask(),
    runId: "spike-cr-01",
    round: 1,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const jr = outcome.jobResult;
  mkdirSync(OUT_DIR, { recursive: true });
  const artifact = resolve(OUT_DIR, "care-reviewer-r1.result.json");
  writeFileSync(artifact, JSON.stringify(jr, null, 2) + "\n", "utf8");

  // Abort-criterion result: a valid JobResult came back. Everything below is bonus signal.
  console.log(`✔ VALID JobResult returned in ${elapsed}s`);
  console.log(
    `  verdict=${jr.verdict}  reason=${jr.reason_code}  findings=${jr.findings.length}`,
  );
  console.log(`  model_used(self-report)=${jr.model_used}`);
  console.log(
    `  model pin cross-check: ${outcome.modelPinSatisfied ? "OK" : "MISMATCH"} (opencode reported: ${outcome.modelReported ?? "n/a"})`,
  );
  console.log(`  artifact → ${artifact}\n`);

  for (const f of jr.findings) {
    console.log(`  • [${f.class}] ${f.line_hint} — ${f.note}`);
  }

  // Eyeball signal only (NOT the abort criterion): did it catch the non-negotiable money bug?
  const caughtMathBug = jr.findings.some(
    (f) =>
      f.class === "correctness" &&
      /rate|100|percent|discount/i.test(`${f.line_hint} ${f.note}`),
  );
  console.log(
    `\n  [signal] caught the percentage money bug: ${caughtMathBug ? "yes" : "no"} (not part of pass/fail)`,
  );

  console.log(
    `\n✅ PHASE-2 ABORT CRITERION: opencode + Copilot produced a schema-valid JobResult.`,
  );
}

main().catch((err) => {
  console.error(
    `\n❌ spike FAILED: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
