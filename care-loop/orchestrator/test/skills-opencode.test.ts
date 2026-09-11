import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  testSurfaceOwed,
  opencodeTestGrader,
  opencodeImplementer,
  setCliRunner,
} from "../src/skills-opencode.ts";
import type { TestGradePayload } from "../src/skill-result.ts";

const rd = () => mkdtempSync(join(tmpdir(), "careloopd-tg-"));
const withBaseline = (body: string): string => {
  const dir = rd();
  writeFileSync(
    join(dir, "baseline.md"),
    `# Baseline\nplanned-by: test\n\n## Test-surface contract (seams the e2e author needs)\n\n${body}\n\n## Non-goals\n- none\n`,
  );
  return dir;
};

// ── testSurfaceOwed: did the plan owe tests? (COLLATION §E.2) ──────────────────────────────────────

test("testSurfaceOwed: no baseline.md ⇒ nothing owed", () => {
  assert.equal(testSurfaceOwed(rd()), false);
});

test("testSurfaceOwed: contract naming a spec file ⇒ owed", () => {
  const dir = withBaseline(
    "Pure util function; no routes, data-testids, or ARIA. E2e/unit author target: new unit spec at src/Utils/utils.test.ts exercising formatPatientAge.",
  );
  assert.equal(testSurfaceOwed(dir), true); // "no ... data-testids" disclaimer does NOT win over a named spec
});

test("testSurfaceOwed: contract naming testids/roles ⇒ owed", () => {
  const dir = withBaseline(
    'Radio group: role="radiogroup"; add data-testid="healthcare-service-radio" per item. Assert selected state.',
  );
  assert.equal(testSurfaceOwed(dir), true);
});

test("testSurfaceOwed: explicit no-test disclaimer, no spec named ⇒ not owed", () => {
  const dir = withBaseline(
    "Config-only change (feature flag default). No e2e or unit spec is needed for this change.",
  );
  assert.equal(testSurfaceOwed(dir), false);
});

test("testSurfaceOwed: empty contract section ⇒ not owed", () => {
  const dir = withBaseline("");
  assert.equal(testSurfaceOwed(dir), false);
});

// ── opencodeTestGrader no-specs branch: pass vs specs_owed advisory (no model spawn) ───────────────

const gradeNoSpecs = (runDir: string) =>
  opencodeTestGrader({}, "/tmp/wt")({ diff: "", runDir, round: 1 });

test("no specs + owed contract ⇒ specs_owed advisory listing the unasserted criteria", async () => {
  const dir = withBaseline("New spec: tests/facility/users/userDepartmentsTab.spec.ts covering search + pagination.");
  writeFileSync(
    join(dir, "criteria.md"),
    "# Acceptance criteria\n\n- User can search departments by name.\n- Pagination appears when count exceeds the page size.\n",
  );
  const r = await gradeNoSpecs(dir);
  assert.equal(r.verdict, "advisory");
  assert.equal(r.reasonCode, "specs_owed");
  const p = r.payload as TestGradePayload;
  assert.equal(p.hasSpecs, false);
  assert.equal(p.specsOwed, true);
  assert.equal(p.criteriaGrades.length, 2);
  assert.equal(p.criteriaGrades[0].verdict, "Missing");
  assert.match(p.criteriaGrades[0].criterion, /search departments/);
});

test("no specs + no test owed ⇒ silent no_specs pass (unchanged behavior)", async () => {
  const dir = withBaseline("Config-only change. No e2e or unit spec is needed.");
  const r = await gradeNoSpecs(dir);
  assert.equal(r.verdict, "pass");
  assert.equal(r.reasonCode, "no_specs");
  const p = r.payload as TestGradePayload;
  assert.equal(p.specsOwed, false);
  assert.equal(p.criteriaGrades.length, 0);
});

test("no specs + no baseline at all ⇒ no_specs pass (--skip-plan run)", async () => {
  const r = await gradeNoSpecs(rd());
  assert.equal(r.verdict, "pass");
  assert.equal(r.reasonCode, "no_specs");
  assert.equal((r.payload as TestGradePayload).specsOwed, false);
});

// ── implementer: git's stderr is not a changed file ───────────────────────────────────────────────

test("implementer: a git warning on stderr is not read as a changed file", async () => {
  // `git status` warns about an unreadable directory on stderr and still exits 0. With stderr merged
  // into its output, a maker run that changed nothing was reported as implemented, the warning as a file.
  const root = rd();
  const wt = join(root, "wt");
  const runDir = join(root, "run");
  mkdirSync(runDir);
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
  execFileSync("git", ["init", "-q", wt]);
  writeFileSync(join(wt, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const locked = join(wt, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  // The maker exits 0 without touching the tree.
  setCliRunner((o) => ({ cmd: o.cmd, args: o.args ?? [], exit: 0, summary: "ok", logPath: o.logPath }));
  try {
    const r = await opencodeImplementer({})({ task: "t", worktree: wt, runDir, round: 1 });
    assert.equal(r.reasonCode, "exit_0_no_change");
    assert.deepEqual((r.payload as { filesChanged: string[] }).filesChanged, []);
  } finally {
    chmodSync(locked, 0o755);
    setCliRunner();
  }
});
