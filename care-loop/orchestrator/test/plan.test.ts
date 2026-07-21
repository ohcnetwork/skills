import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlan, hasApprovedPlan } from "../src/plan.ts";
import { Journal } from "../src/journal.ts";
import type { Planner, PlanGate, PlanInput } from "../src/ports.ts";
import type { PlannerPayload } from "../src/skill-result.ts";
import type {
  ApprovalDecision,
  PlanAnswer,
  PlanQuestion,
} from "../src/plan-gate.ts";

const rd = () => mkdtempSync(join(tmpdir(), "careloopd-plan-"));

function makeInput(runDir: string): PlanInput {
  return {
    task: "Add expiry date column",
    ticket: "ENG-613",
    branch: "eng-613/expiry",
    summary: "add expiry date",
    repo: "ohcnetwork/care_fe",
    mainRepoPath: "/tmp/care_fe",
    worktree: join(runDir, "wt"),
    runDir,
  };
}

const env = (
  payload: PlannerPayload,
  verdict: string,
  reasonCode: string,
  round: number,
) => ({
  schema: "care-loop/skill-result@1" as const,
  skill: "care-planner",
  round,
  terminalState: "done" as const,
  verdict,
  reasonCode,
  payload,
  modelUsed: payload.plannedBy ?? "opus",
});

/** Fake planner: interview returns the given questions; plan returns a fixed draft (tunable). */
function fakePlanner(
  opts: {
    questions?: PlanQuestion[];
    plannedBy?: string;
    modelPinSatisfied?: boolean;
    classification?: PlannerPayload["classification"];
    uiSurfaces?: string;
    onCall?: (phase: string) => void;
  } = {},
): Planner {
  return async ({ phase, round }) => {
    opts.onCall?.(phase);
    if (phase === "interview")
      return env(
        { phase: "interview", questions: opts.questions ?? [] },
        "questions",
        "interview",
        round,
      );
    return env(
      {
        phase: "plan",
        scope: "expiry column",
        files: ["src/SupplyDeliveryTable.tsx"],
        approach: "add a column",
        criteria: ["renders expiry at 375px"],
        nonGoals: ["no backend change"],
        testSurface: "route /supply",
        uiSurfaces: opts.uiSurfaces,
        classification: opts.classification ?? "standard",
        plannedBy: opts.plannedBy ?? "Opus 4.8",
        modelPinSatisfied: opts.modelPinSatisfied,
      },
      "planned",
      opts.classification ?? "standard",
      round,
    );
  };
}

/** Fake gate: scripted answers + a queue of approval decisions. */
function fakeGate(
  decisions: ApprovalDecision[],
  answers?: PlanAnswer[],
): PlanGate {
  let i = 0;
  return {
    async interview(qs: PlanQuestion[]) {
      return answers ?? qs.map((q) => ({ id: q.id, answer: `answer-${q.id}` }));
    },
    async approve() {
      return decisions[i++] ?? { decision: "approve" };
    },
  };
}

const lockOpts = { pid: process.pid, isAlive: () => true };
const events = (runDir: string) =>
  new Journal(join(runDir, "journal.jsonl"), "r").read().events;

test("happy path: interview → draft → approve writes artifacts + plan.approved", async () => {
  const runDir = rd();
  const input = makeInput(runDir);
  const planner = fakePlanner({
    questions: [{ id: "q1", prompt: "empty state?" }],
  });
  const res = await runPlan({
    input,
    planner,
    gate: fakeGate([{ decision: "approve" }]),
    lockOpts,
  });

  assert.equal(res.outcome, "approved");
  assert.equal(res.classification, "standard");
  // artifacts persisted
  assert.ok(existsSync(join(runDir, "criteria.md")), "criteria.md written");
  assert.ok(existsSync(join(runDir, "baseline.md")), "baseline.md written");
  assert.ok(existsSync(join(runDir, "decisions.md")), "decisions.md written");
  assert.match(
    readFileSync(join(runDir, "criteria.md"), "utf8"),
    /renders expiry at 375px/,
  );
  assert.match(
    readFileSync(join(runDir, "baseline.md"), "utf8"),
    /planned-by: Opus 4\.8/,
  );
  assert.match(
    readFileSync(join(runDir, "baseline.md"), "utf8"),
    /Test-surface contract/,
  );
  assert.match(readFileSync(join(runDir, "decisions.md"), "utf8"), /answer-q1/);
  // journal carries the approval + advances to step 2
  const evs = events(runDir);
  assert.ok(hasApprovedPlan(evs), "plan.approved recorded");
  assert.equal(evs[0].event, "run.start");
  assert.ok(
    evs.some((e) => e.event === "decision" && (e.data as any)?.to === "2"),
    "advanced 1→2",
  );
});

test("no interview questions → gate.interview is skipped, still approves", async () => {
  const runDir = rd();
  const res = await runPlan({
    input: makeInput(runDir),
    planner: fakePlanner({ questions: [] }),
    gate: fakeGate([{ decision: "approve" }]),
    lockOpts,
  });
  assert.equal(res.outcome, "approved");
  const evs = events(runDir);
  assert.ok(
    !evs.some((e) => e.event === "gate.asked"),
    "no gate.asked when no questions",
  );
});

test("amend re-drafts (unbounded) then approves", async () => {
  const runDir = rd();
  const phases: string[] = [];
  const planner = fakePlanner({ onCall: (p) => phases.push(p) });
  const res = await runPlan({
    input: makeInput(runDir),
    planner,
    gate: fakeGate([
      { decision: "amend", amendment: "use a tooltip" },
      { decision: "amend", amendment: "and a badge" },
      { decision: "approve" },
    ]),
    lockOpts,
  });

  assert.equal(res.outcome, "approved");
  // interview once, then draft three times (initial + 2 amends)
  assert.deepEqual(phases, ["interview", "plan", "plan", "plan"]);
  assert.ok(
    events(runDir).filter(
      (e) => e.event === "decision" && (e.data as any)?.note === "amend",
    ).length === 2,
  );
});

test("reject → aborted, run.end recorded, no approval", async () => {
  const runDir = rd();
  const res = await runPlan({
    input: makeInput(runDir),
    planner: fakePlanner(),
    gate: fakeGate([{ decision: "reject" }]),
    lockOpts,
  });
  assert.equal(res.outcome, "rejected");
  assert.equal(res.reasonCode, "plan_rejected");
  const evs = events(runDir);
  assert.ok(!hasApprovedPlan(evs));
  assert.ok(
    evs.some(
      (e) =>
        e.event === "run.end" &&
        (e.data as any)?.reason_code === "plan_rejected",
    ),
  );
});

test("wrong-tier plannedBy (not Opus) → aborted before the gate", async () => {
  const runDir = rd();
  let approveCalled = false;
  const gate: PlanGate = {
    async interview() {
      return [];
    },
    async approve() {
      approveCalled = true;
      return { decision: "approve" };
    },
  };
  const res = await runPlan({
    input: makeInput(runDir),
    planner: fakePlanner({ plannedBy: "Sonnet 4.6", modelPinSatisfied: false }),
    gate,
    lockOpts,
  });

  assert.equal(res.outcome, "aborted");
  assert.equal(res.reasonCode, "plan_wrong_tier");
  assert.equal(approveCalled, false, "gate never reached on a wrong-tier plan");
  assert.ok(
    events(runDir).some(
      (e) =>
        e.event === "run.end" &&
        (e.data as any)?.reason_code === "plan_wrong_tier",
    ),
  );
});

test("ui-surfaces.md written only when the plan carries uiSurfaces", async () => {
  const withUi = rd();
  await runPlan({
    input: makeInput(withUi),
    planner: fakePlanner({
      uiSurfaces: "## Changed surfaces\n- route: /supply",
    }),
    gate: fakeGate([{ decision: "approve" }]),
    lockOpts,
  });
  assert.ok(
    existsSync(join(withUi, "ui-surfaces.md")),
    "ui-surfaces.md present when .tsx surfaces given",
  );

  const noUi = rd();
  await runPlan({
    input: makeInput(noUi),
    planner: fakePlanner(),
    gate: fakeGate([{ decision: "approve" }]),
    lockOpts,
  });
  assert.ok(
    !existsSync(join(noUi, "ui-surfaces.md")),
    "ui-surfaces.md omitted when none",
  );
});

test("trivial classification flows through as the tier", async () => {
  const runDir = rd();
  const res = await runPlan({
    input: makeInput(runDir),
    planner: fakePlanner({ classification: "trivial" }),
    gate: fakeGate([{ decision: "approve" }]),
    lockOpts,
  });
  assert.equal(res.classification, "trivial");
  const approved = events(runDir).find((e) => e.event === "plan.approved")!;
  assert.equal((approved.data as any).classification, "trivial");
});
