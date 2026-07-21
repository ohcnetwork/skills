import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAutoDoctor,
  guardReason,
  hasEvalCoverage,
  renderPrBody,
  type AutoDoctorSeams,
  type AutoDoctorOptions,
  type DoctorOutput,
} from "../src/auto-doctor.ts";
import type { NewEvent } from "../src/journal.ts";
import { parseRemoteSlug } from "../src/auto-doctor-wiring.ts";

// ── wiring: remote-slug parsing (the self-improve PR targets the skills repo) ─────────────────────

test("parseRemoteSlug: ssh and https forms → owner/name", () => {
  assert.equal(parseRemoteSlug("git@github.com:ohcnetwork/skills.git"), "ohcnetwork/skills");
  assert.equal(parseRemoteSlug("https://github.com/ohcnetwork/skills.git"), "ohcnetwork/skills");
  assert.equal(parseRemoteSlug("https://github.com/ohcnetwork/skills"), "ohcnetwork/skills");
  assert.equal(parseRemoteSlug("not-a-remote"), null);
});

// ── Fakes ─────────────────────────────────────────────────────────────────────────────────────────

function baseOutput(over: Partial<DoctorOutput> = {}): DoctorOutput {
  return {
    findings: [],
    skillEdits: [],
    proposeOnly: [],
    fixtures: [],
    coverageDelta: { green: 0, yellow: 0, red: 0 },
    reportBody: "diagnosis body",
    ...over,
  };
}

interface Harness {
  seams: AutoDoctorSeams;
  events: NewEvent[];
  reverted: string[];
  commits: string[];
  createdPr: { branch: string; draft: boolean; title: string } | null;
  branchedTo: string | null;
  ranTests: boolean;
  ranEvalsWith: string[] | null;
}

function harness(
  out: DoctorOutput,
  over: {
    tests?: boolean;
    evals?: boolean;
    coherence?: { ok: boolean; note?: string };
    spawnThrows?: boolean;
    changed?: string[]; // git changedFiles() — defaults to "honest doctor" (disk matches manifest)
  } = {},
): Harness {
  // Default: the doctor actually wrote what it claimed — every declared skill-edit file + a path per
  // fixture shows as changed on disk. Tests override `changed` to simulate a phantom (claimed-not-written).
  const defaultChanged = [
    ...out.skillEdits.flatMap((e) => e.files),
    ...out.fixtures.map((f) => `care-evals/tasks/${f.name}/task.md`),
  ];
  const events: NewEvent[] = [];
  const reverted: string[] = [];
  const commits: string[] = [];
  const h: Harness = {
    events,
    reverted,
    commits,
    createdPr: null,
    branchedTo: null,
    ranTests: false,
    ranEvalsWith: null,
    seams: undefined as unknown as AutoDoctorSeams,
  };
  h.seams = {
    spawnDoctor: async () => {
      if (over.spawnThrows) throw new Error("boom");
      return out;
    },
    git: {
      checkoutNewBranch: (name) => {
        h.branchedTo = name;
      },
      revertFile: (p) => reverted.push(p),
      changedFiles: () => over.changed ?? defaultChanged,
      commitAll: (msg) => {
        commits.push(msg);
        return "sha123";
      },
    },
    runTests: async () => {
      h.ranTests = true;
      return { ok: over.tests ?? true, output: "" };
    },
    runEvals: async (prefixes) => {
      h.ranEvalsWith = prefixes;
      return { ok: over.evals ?? true, output: "" };
    },
    coherenceCheck: async () => over.coherence ?? { ok: true },
    gh: {
      createPr: async (o) => {
        h.createdPr = { branch: o.branch, draft: o.draft, title: o.title };
        return 42;
      },
    },
    append: (ev) => events.push(ev as NewEvent),
    now: () => new Date("2026-07-20T00:00:00Z"),
  };
  return h;
}

const opts = (over: Partial<AutoDoctorOptions> = {}): AutoDoctorOptions => ({
  runDir: "/tmp/run",
  repoRoot: "/repo",
  runSlug: "care_fe-eng-729",
  enabled: true,
  journalEvents: [{ event: "run.start" }, { event: "run.end" }],
  ...over,
});

const evNames = (h: Harness) => h.events.map((e) => e.event);

// ── guard ───────────────────────────────────────────────────────────────────────────────────────

test("guard: disabled skips with a reason", () => {
  assert.match(guardReason(opts({ enabled: false }))!, /disabled/);
});

test("guard: no run.start skips", () => {
  assert.match(guardReason(opts({ journalEvents: [] }))!, /no run.start/);
});

test("guard: a real terminated run proceeds", () => {
  assert.equal(guardReason(opts()), null);
});

test("disabled run journals doctor.skip and does not branch", async () => {
  const h = harness(baseOutput());
  const r = await runAutoDoctor(opts({ enabled: false }), h.seams);
  assert.equal(r.ran, false);
  assert.match(r.skipped!, /disabled/);
  assert.equal(h.branchedTo, null);
  assert.deepEqual(evNames(h), ["doctor.skip"]);
});

// ── coverage table ────────────────────────────────────────────────────────────────────────────────

test("hasEvalCoverage: covered skills vs the planner", () => {
  assert.ok(hasEvalCoverage("care-ux-review"));
  assert.ok(hasEvalCoverage("care-test-grade"));
  assert.ok(hasEvalCoverage("care-diff-review")); // lens → cr
  assert.equal(hasEvalCoverage("care-planner"), false); // not diff-graded (BS-3)
});

// ── happy path: covered skill, green verify, coherent ⇒ real PR ────────────────────────────────────

test("covered skill edit + green verify + coherent ⇒ real (non-draft) PR", async () => {
  const out = baseOutput({
    skillEdits: [
      { skill: "care-ux-review", files: ["care-ux-review/SKILL.md"], note: "add 320px check" },
    ],
    findings: [
      {
        imp: "IMP-16",
        dimension: 8,
        sensorType: "inferential",
        summary: "ux missed a tablet overflow",
        reObserved: false,
        seen: 1,
        regression: false,
      },
    ],
  });
  const h = harness(out);
  const r = await runAutoDoctor(opts(), h.seams);
  assert.equal(r.ran, true);
  assert.deepEqual(r.applied, ["care-ux-review"]);
  assert.equal(r.draft, false);
  assert.equal(r.pr, 42);
  assert.equal(h.createdPr!.draft, false);
  assert.deepEqual(h.ranEvalsWith, ["ux"]); // affected-only eval selection
  assert.equal(h.ranTests, true);
  assert.ok(evNames(h).includes("doctor.apply"));
  assert.ok(evNames(h).includes("doctor.verify"));
  assert.ok(evNames(h).includes("doctor.pr"));
  assert.match(h.branchedTo!, /^care-loop\/self-improve\/2026-07-20-care_fe-eng-729$/);
});

// ── authority tiering: uncovered skill is reverted + demoted + forces draft ───────────────────────

test("uncovered skill edit (planner) is reverted, demoted, and forces a draft PR", async () => {
  const out = baseOutput({
    skillEdits: [
      { skill: "care-planner", files: ["care-planner/SKILL.md"], note: "tune recon" },
    ],
  });
  const h = harness(out);
  const r = await runAutoDoctor(opts(), h.seams);
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.demoted, ["care-planner"]);
  assert.deepEqual(h.reverted, ["care-planner/SKILL.md"]);
  assert.equal(r.proposeOnly, 1);
  assert.equal(r.draft, true);
  assert.equal(h.createdPr!.draft, true);
  // nothing verifiable was applied ⇒ no test/eval run
  assert.equal(h.ranTests, false);
  assert.equal(r.verify, undefined);
});

// ── verify gating ─────────────────────────────────────────────────────────────────────────────────

test("red evals ⇒ draft PR", async () => {
  const out = baseOutput({
    skillEdits: [{ skill: "care-review", files: ["care-review/SKILL.md"], note: "x" }],
  });
  const h = harness(out, { evals: false });
  const r = await runAutoDoctor(opts(), h.seams);
  assert.deepEqual(r.verify, { tests: true, evals: false });
  assert.equal(r.draft, true);
});

test("red tests ⇒ draft PR", async () => {
  const out = baseOutput({
    skillEdits: [{ skill: "care-review", files: ["care-review/SKILL.md"], note: "x" }],
  });
  const h = harness(out, { tests: false });
  const r = await runAutoDoctor(opts(), h.seams);
  assert.deepEqual(r.verify, { tests: false, evals: true });
  assert.equal(r.draft, true);
});

// ── coherence gate ────────────────────────────────────────────────────────────────────────────────

test("coherence failure ⇒ draft PR even when verify is green", async () => {
  const out = baseOutput({
    skillEdits: [{ skill: "care-test-grade", files: ["care-test-grade/SKILL.md"], note: "x" }],
  });
  const h = harness(out, { coherence: { ok: false, note: "contradicts care-review" } });
  const r = await runAutoDoctor(opts(), h.seams);
  assert.equal(r.coherenceOk, false);
  assert.equal(r.draft, true);
  const coh = h.events.find((e) => e.event === "doctor.coherence");
  assert.equal((coh!.data as { ok: boolean }).ok, false);
});

// ── recurrence gate on fixtures ───────────────────────────────────────────────────────────────────

test("recurrence gate: verbatim commits, unrecurred class-sibling is proposed only", async () => {
  const out = baseOutput({
    skillEdits: [{ skill: "care-ux-review", files: ["care-ux-review/SKILL.md"], note: "x" }],
    fixtures: [
      { name: "ux-11-verbatim", skill: "care-ux-review", kind: "verbatim", recurred: false },
      { name: "ux-12-sibling", skill: "care-ux-review", kind: "class-sibling", recurred: false },
      { name: "ux-13-sibling", skill: "care-ux-review", kind: "class-sibling", recurred: true },
    ],
  });
  const h = harness(out);
  const r = await runAutoDoctor(opts(), h.seams);
  assert.deepEqual(r.fixtures.committed, ["ux-11-verbatim", "ux-13-sibling"]);
  assert.deepEqual(r.fixtures.proposed, ["ux-12-sibling"]);
  // an unrecurred sibling is an unverified item ⇒ draft
  assert.equal(r.draft, true);
});

// ── report-only path ──────────────────────────────────────────────────────────────────────────────

test("no edits at all ⇒ report-only commit, no PR", async () => {
  const h = harness(baseOutput());
  const r = await runAutoDoctor(opts(), h.seams);
  assert.equal(r.ran, true);
  assert.equal(r.pr, undefined);
  assert.equal(h.createdPr, null);
  assert.equal(h.commits.length, 1);
  assert.match(h.commits[0], /report-only/);
  const pr = h.events.find((e) => e.event === "doctor.pr");
  assert.equal((pr!.data as { reason?: string }).reason, "report-only");
});

// ── manifest reconciliation: trust the LLM's claims only where disk agrees ────────────────────────

test("phantom skill edit (claimed but file not changed on disk) is dropped, not applied", async () => {
  const out = baseOutput({
    skillEdits: [
      { skill: "care-ux-review", files: ["care-ux-review/SKILL.md"], note: "real" },
      { skill: "care-review", files: ["care-review/SKILL.md"], note: "phantom" },
    ],
  });
  // only the ux file actually changed on disk; the care-review edit is a phantom claim
  const h = harness(out, { changed: ["care-ux-review/SKILL.md"] });
  const r = await runAutoDoctor(opts(), h.seams);
  assert.deepEqual(r.applied, ["care-ux-review"]); // phantom care-review NOT applied
  assert.deepEqual(h.ranEvalsWith, ["ux"]); // only the real edit's evals run
  const phantom = h.events.find(
    (e) => e.event === "doctor.apply" && (e.data as { phantom?: unknown }).phantom,
  );
  assert.deepEqual((phantom!.data as { phantom: { skills: string[] } }).phantom.skills, ["care-review"]);
});

test("phantom fixture (claimed but never written) is dropped from committed set", async () => {
  const out = baseOutput({
    skillEdits: [{ skill: "care-ux-review", files: ["care-ux-review/SKILL.md"], note: "x" }],
    fixtures: [
      { name: "ux-11-real", skill: "care-ux-review", kind: "verbatim", recurred: false },
      { name: "ux-12-phantom", skill: "care-ux-review", kind: "verbatim", recurred: false },
    ],
  });
  // ux-11 written, ux-12 claimed-not-written
  const h = harness(out, {
    changed: ["care-ux-review/SKILL.md", "care-evals/tasks/ux-11-real/task.md"],
  });
  const r = await runAutoDoctor(opts(), h.seams);
  assert.deepEqual(r.fixtures.committed, ["ux-11-real"]);
  assert.equal(r.fixtures.proposed.length, 0);
  const phantom = h.events.find(
    (e) => e.event === "doctor.apply" && (e.data as { phantom?: unknown }).phantom,
  );
  assert.deepEqual(
    (phantom!.data as { phantom: { fixtures: string[] } }).phantom.fixtures,
    ["ux-12-phantom"],
  );
});

// ── dry run: apply + verify, but no branch/commit/PR ──────────────────────────────────────────────

test("dry run applies + verifies but makes no branch/commit/PR", async () => {
  const out = baseOutput({
    skillEdits: [{ skill: "care-ux-review", files: ["care-ux-review/SKILL.md"], note: "x" }],
  });
  const h = harness(out);
  const r = await runAutoDoctor(opts({ dry: true }), h.seams);
  assert.equal(r.ran, true);
  assert.equal(r.dry, true);
  assert.equal(h.branchedTo, null); // no branch
  assert.equal(h.commits.length, 0); // no commit
  assert.equal(h.createdPr, null); // no PR
  // but it DID do the real work: applied + verified
  assert.deepEqual(r.applied, ["care-ux-review"]);
  assert.deepEqual(r.verify, { tests: true, evals: true });
  assert.equal(r.draft, false); // would-be verdict still computed
  const pr = h.events.find((e) => e.event === "doctor.pr");
  assert.equal((pr!.data as { dry?: boolean }).dry, true);
});

// ── best-effort: a throwing spawn never propagates ────────────────────────────────────────────────

test("spawnDoctor throwing ⇒ ran:false, doctor.error journaled, no PR", async () => {
  const h = harness(baseOutput(), { spawnThrows: true });
  const r = await runAutoDoctor(opts(), h.seams);
  assert.equal(r.ran, false);
  assert.match(r.skipped!, /error: boom/);
  assert.equal(h.createdPr, null);
  assert.ok(evNames(h).includes("doctor.error"));
});

// ── PR body rendering ─────────────────────────────────────────────────────────────────────────────

test("renderPrBody surfaces regression flags, seen counts, and coverage delta", () => {
  const out = baseOutput({
    coverageDelta: { green: 1, yellow: -1, red: 0 },
    findings: [
      {
        imp: "IMP-3",
        dimension: 5,
        sensorType: "computational",
        summary: "state drift",
        reObserved: true,
        seen: 6,
        regression: true,
      },
    ],
  });
  const body = renderPrBody(out, {
    applied: ["care-review"],
    demoted: [],
    proposeOnly: [],
    committedFixtures: [],
    proposedFixtures: [],
    verify: { tests: true, evals: true },
    coherence: { ok: true },
    draft: false,
  });
  assert.match(body, /REGRESSION/);
  assert.match(body, /seen: 6/);
  assert.match(body, /🟢 \+1/);
  assert.match(body, /🟡 -1/);
});
