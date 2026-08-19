import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptPr, computeDivergence, type SalvageGate } from "../src/adopt.ts";
import { planResume } from "../src/resume.ts";
import { Journal } from "../src/journal.ts";
import { makeFakeGitHub } from "./fake-github.ts";
import { useRealStore } from "./_store.ts";
import type { PrInfo } from "../src/github.ts";

const runDir = () => {
  useRealStore();
  return mkdtempSync(join(tmpdir(), "careloopd-adopt-"));
};

const prInfo = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 16632,
  state: "open",
  headSha: "deadbeef",
  headRef: "salvage-branch",
  title: "Add E2E tests for appointment booking",
  body: "This PR adds Playwright specs for the appointment booking and detail flows.",
  baseRef: "develop",
  ...over,
});

const approveGate: SalvageGate = async (ask) => ({
  decision: "approve",
  criteria: ask.draftCriteria,
  nonGoals: ["do not refactor the booking API"],
});

const baseInput = (dir: string, over: Partial<Parameters<typeof adoptPr>[0]> = {}) => ({
  gh: makeFakeGitHub({ getPr: async () => prInfo() }),
  pr: 16632,
  repo: "ohcnetwork/care_fe",
  runDir: dir,
  worktree: "/tmp/wt",
  diffProvider: async () => "+++ b/tests/appt.spec.ts\n+// specs",
  reconstruct: async () => ({
    intent: "Adds Playwright specs covering appointment booking and the detail view.",
    criteria: ["booking flow is covered by an e2e spec", "detail view is covered"],
  }),
  gate: approveGate,
  now: () => "2026-08-16T00:00:00Z",
  ...over,
});

test("adoptPr synthesizes the plan artifacts a CI round reads", async () => {
  const dir = runDir();
  const res = await adoptPr(baseInput(dir));
  assert.equal(res.approved, true);
  for (const f of ["intent.md", "criteria.md", "baseline.md", "decisions.md", "journal.jsonl", "state.json"])
    assert.ok(existsSync(join(dir, f)), `${f} should exist`);
  assert.match(readFileSync(join(dir, "intent.md"), "utf8"), /Adds Playwright specs/);
  assert.match(readFileSync(join(dir, "baseline.md"), "utf8"), /implementation is DONE/);
  assert.match(readFileSync(join(dir, "decisions.md"), "utf8"), /do not refactor the booking API/);
});

test("adopted journal projects to the CI-round entry step, and planResume enters mode ci", async () => {
  const dir = runDir();
  const res = await adoptPr(baseInput(dir));
  assert.equal(res.state?.pr, 16632);
  assert.equal(res.state?.step, "5-await");

  const events = new Journal(join(dir, "journal.jsonl"), "x").readReplica().events;
  const plan = planResume(events);
  assert.equal(plan.resumable, true);
  assert.equal(plan.mode, "ci");
  // Round-1 poll baseline is backdated so the PR's EXISTING bot reviews count as "arrived"
  // (otherwise round 1 waits forever for re-reviews of an unchanged head).
  assert.equal(plan.sinceIso, new Date(0).toISOString());
});

test("criteria.md comes from the CONFIRMED gate criteria, never the PR description", async () => {
  const dir = runDir();
  // The gate REWRITES the criteria; the description mentions "detail flows" which must not leak in.
  const gate: SalvageGate = async () => ({
    decision: "approve",
    criteria: ["ONLY the booking happy-path is in scope"],
    nonGoals: [],
  });
  await adoptPr(baseInput(dir, { gate }));
  const criteria = readFileSync(join(dir, "criteria.md"), "utf8");
  assert.match(criteria, /ONLY the booking happy-path is in scope/);
  assert.doesNotMatch(criteria, /detail/i); // the description's claim did not seed criteria
});

test("the reconstruction seam is never handed the PR description (blindness is structural)", async () => {
  const dir = runDir();
  let sawDescription = false;
  const secret = "SECRET-DESCRIPTION-TOKEN";
  await adoptPr(
    baseInput(dir, {
      gh: makeFakeGitHub({ getPr: async () => prInfo({ body: secret }) }),
      reconstruct: async ({ diff }) => {
        if (diff.includes(secret)) sawDescription = true;
        return { intent: "x", criteria: ["c"] };
      },
      diffProvider: async () => "+++ b/a.ts\n+// no body here",
    }),
  );
  assert.equal(sawDescription, false);
});

test("a rejected salvage gate ends the run and does not enter mode ci", async () => {
  const dir = runDir();
  const gate: SalvageGate = async () => ({ decision: "reject" });
  const res = await adoptPr(baseInput(dir, { gate }));
  assert.equal(res.approved, false);
  assert.ok(!existsSync(join(dir, "criteria.md"))); // no criteria written on reject
  const events = new Journal(join(dir, "journal.jsonl"), "x").readReplica().events;
  assert.equal(planResume(events).mode, "build"); // no PR recorded → not a ci resume
});

test("computeDivergence flags a thin description and a low-overlap (stale) one", () => {
  assert.equal(computeDivergence("anything", "").risk, true);
  assert.equal(computeDivergence("anything", "tiny").risk, true);
  // stale: description talks about billing invoices; reconstruction about appointment specs
  const stale = computeDivergence(
    "Adds Playwright specs covering appointment booking and slot selection.",
    "Refactors the billing invoice discount calculator and its reconciliation ledger totals.",
  );
  assert.equal(stale.risk, true);
  assert.match(stale.note, /stale|overlap/i);
  // aligned: shared vocabulary
  const aligned = computeDivergence(
    "Adds Playwright specs covering appointment booking and the appointment detail view.",
    "This PR adds Playwright appointment booking and appointment detail specs.",
  );
  assert.equal(aligned.risk, false);
});

test("ui-surfaces.md is written only when the diff touches .tsx", async () => {
  const dir1 = runDir();
  await adoptPr(baseInput(dir1, { diffProvider: async () => "+++ b/src/x.ts\n+code" }));
  assert.ok(!existsSync(join(dir1, "ui-surfaces.md")));
  const dir2 = runDir();
  await adoptPr(baseInput(dir2, { diffProvider: async () => "+++ b/src/components/Card.tsx\n+jsx" }));
  assert.ok(existsSync(join(dir2, "ui-surfaces.md")));
});
