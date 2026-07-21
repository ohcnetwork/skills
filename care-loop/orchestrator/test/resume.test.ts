import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePr, planResume } from "../src/resume.ts";
import { Journal } from "../src/journal.ts";
import type { PrReview } from "../src/github.ts";
import { makeFakeGitHub } from "./fake-github.ts";

const review = (user: string, commitId: string): PrReview => ({
  user,
  commitId,
  submittedAt: "2026-07-13T10:00:00Z",
  state: "COMMENTED",
});

test("probePr reports the PR head, CI conclusion, and reviewers up-to-date at local head", async () => {
  const localHead = "abc123";
  const gh = makeFakeGitHub({
    getPr: async () => ({
      number: 9,
      state: "open",
      headSha: "abc123",
      headRef: "b",
      title: "[ENG-9] x",
    }),
    listReviews: async () => [
      review("greptile-apps[bot]", "abc123"), // at head → up to date
      review("coderabbitai[bot]", "old999"), // stale review
      review("Copilot", "abc123"),
    ],
    getChecks: async () => ({
      total: 5,
      pending: 0,
      failing: 0,
      conclusion: "pass",
    }),
  });

  const probe = await probePr(gh, 9, localHead);
  assert.equal(probe.prHead, "abc123");
  assert.equal(probe.state, "open");
  assert.equal(probe.ci, "pass");
  assert.deepEqual(probe.botsAtHead, ["Copilot", "greptile-apps[bot]"]); // sorted, stale coderabbit excluded
});

test("probePr: no reviews at head → empty botsAtHead (nobody re-reviewed the new push)", async () => {
  const gh = makeFakeGitHub({
    getPr: async () => ({
      number: 1,
      state: "open",
      headSha: "newsha",
      headRef: "b",
      title: "t",
    }),
    listReviews: async () => [review("greptile-apps[bot]", "oldsha")],
    getChecks: async () => ({
      total: 1,
      pending: 1,
      failing: 0,
      conclusion: "pending",
    }),
  });
  const probe = await probePr(gh, 1, "newsha");
  assert.deepEqual(probe.botsAtHead, []);
  assert.equal(probe.ci, "pending");
});

// ── planResume: the pure "can this run dir re-enter the CI loop?" decision ────────────────────────

const BASE_STATE = {
  task: "Enhance patient age (ENG-747)",
  repo: "ohcnetwork/care_fe",
  branch: "enhance-patient-age",
  worktree: "/tmp/wt",
  tier: "standard" as const,
  pr: null as number | null,
  round: 1,
  step: "1" as const,
  head_sha: "seed",
  last_reviewed_sha: "",
};

function journalWith(events: (j: Journal) => void): Journal {
  const dir = mkdtempSync(join(tmpdir(), "careloopd-resume-"));
  const j = new Journal(join(dir, "journal.jsonl"), "run-747");
  j.append({
    event: "run.start",
    step: "1",
    round: 1,
    data: { state: BASE_STATE },
  });
  events(j);
  return j;
}

test("planResume: a run with an open PR mid-CI is resumable at its head round", () => {
  const j = journalWith((j) => {
    j.append({
      event: "push",
      data: {
        state: { head_sha: "ea1ad6b8a", step: "5-pushing" },
        head_sha: "ea1ad6b8a",
      },
    });
    j.append({
      event: "decision",
      data: {
        note: "pr-opened",
        pr: 16571,
        state: { pr: 16571, step: "5-await" },
      },
    });
    j.append({ event: "step.enter", step: "6a", round: 2 });
  });
  const plan = planResume(j.read().events);
  assert.equal(plan.resumable, true);
  assert.equal(plan.pr, 16571);
  assert.equal(plan.headSha, "ea1ad6b8a");
  assert.equal(plan.round, 2);
});

test("planResume: sinceIso is the CURRENT head's push time, not resume-time (else the poll waits forever for already-arrived bots)", () => {
  let pushTs = "";
  const j = journalWith((j) => {
    j.append({
      event: "push",
      data: {
        state: { head_sha: "headA", step: "5-pushing" },
        head_sha: "headA",
      },
    });
    pushTs = j.read().events.at(-1)!.ts;
    j.append({
      event: "decision",
      data: {
        note: "pr-opened",
        pr: 16571,
        state: { pr: 16571, step: "5-await" },
      },
    });
    j.append({ event: "step.enter", step: "6a", round: 2 });
  });
  const plan = planResume(j.read().events);
  assert.equal(
    plan.sinceIso,
    pushTs,
    "sinceIso must be the head's push timestamp",
  );
});

test("planResume: no PR opened yet → NOT resumable (CI-stage only), with a clear reason", () => {
  const j = journalWith((j) => {
    j.append({ event: "step.enter", step: "3", round: 1 });
  });
  const plan = planResume(j.read().events);
  assert.equal(plan.resumable, false);
  assert.match(plan.reason, /no PR opened yet/);
  assert.equal(plan.pr, undefined);
});

test("planResume: a build-stage crash AFTER plan approval (no PR) IS resumable at the interrupted step", () => {
  const j = journalWith((j) => {
    j.append({
      event: "plan.approved",
      step: "1",
      round: 1,
      data: {
        classification: "standard",
        ticket: "ENG-747",
        summary: "Enhance patient age display",
        state: { tier: "standard" },
      },
    });
    j.append({ event: "step.enter", step: "2", round: 1 });
    j.append({ event: "step.enter", step: "3", round: 1 });
    j.append({ event: "step.enter", step: "4a", round: 1 }); // crashed mid-review (no step.exit)
  });
  const plan = planResume(j.read().events);
  assert.equal(plan.resumable, true);
  assert.equal(plan.mode, "build");
  assert.equal(plan.resumeStep, "4a"); // last step entered but not exited
  assert.equal(plan.ticket, "ENG-747"); // read from plan.approved
  assert.equal(plan.summary, "Enhance patient age display");
  assert.equal(plan.pr, undefined); // no CI-stage fields
});

test("planResume: a build-stage crash WITHOUT plan approval is NOT resumable (interview isn't re-entrant)", () => {
  const j = journalWith((j) => {
    j.append({ event: "step.enter", step: "1", round: 1 }); // died during the plan interview
  });
  const plan = planResume(j.read().events);
  assert.equal(plan.resumable, false);
  assert.equal(plan.mode, "build");
  assert.match(plan.reason, /never approved|re-run from the start/);
});

test("planResume: an ABORTED build (terminal run.end, no PR) is NOT resumable", () => {
  const j = journalWith((j) => {
    j.append({
      event: "plan.approved",
      step: "1",
      round: 1,
      data: { classification: "standard", state: { tier: "standard" } },
    });
    j.append({ event: "step.enter", step: "3", round: 1 });
    j.append({
      event: "run.end",
      data: {
        outcome: "aborted",
        reason_code: "implement_exhausted",
        state: { step: "aborted" },
      },
    });
  });
  const plan = planResume(j.read().events);
  assert.equal(plan.resumable, false);
  assert.match(plan.reason, /ended before opening a PR/);
});

test("planResume: an already-ended run is NOT resumable (nothing to converge)", () => {
  const j = journalWith((j) => {
    j.append({
      event: "decision",
      data: {
        note: "pr-opened",
        pr: 16571,
        state: { pr: 16571, step: "5-await" },
      },
    });
    j.append({
      event: "run.end",
      data: {
        outcome: "converged",
        reason_code: "ci_clean",
        state: { step: "merged" },
      },
    });
  });
  const plan = planResume(j.read().events);
  assert.equal(plan.resumable, false);
  assert.match(plan.reason, /already ended/);
});

test("planResume: a DEFERRED run IS resumable (ci_red_human is a checkpoint, not terminal)", () => {
  const j = journalWith((j) => {
    j.append({
      event: "push",
      data: {
        state: { head_sha: "d6626ef9", step: "5-pushing" },
        head_sha: "d6626ef9",
      },
    });
    j.append({
      event: "decision",
      data: {
        note: "pr-opened",
        pr: 16571,
        state: { pr: 16571, step: "5-await" },
      },
    });
    j.append({ event: "step.enter", step: "6a", round: 3 });
    j.append({
      event: "run.end",
      data: {
        outcome: "deferred",
        reason_code: "ci_red_human",
        state: { step: "6b", round: 3 },
      },
    });
  });
  const plan = planResume(j.read().events);
  assert.equal(
    plan.resumable,
    true,
    "a deferred checkpoint re-enters the CI loop (→ re-poll → triage → ci-fix)",
  );
  assert.equal(plan.pr, 16571);
  assert.equal(plan.headSha, "d6626ef9");
});

test("planResume: a CAPPED run IS resumable (round budget ran out — raise --max-rounds and continue)", () => {
  const j = journalWith((j) => {
    j.append({
      event: "push",
      data: {
        state: { head_sha: "d6626ef9", step: "5-pushing" },
        head_sha: "d6626ef9",
      },
    });
    j.append({
      event: "decision",
      data: {
        note: "pr-opened",
        pr: 16571,
        state: { pr: 16571, step: "5-await" },
      },
    });
    j.append({ event: "step.enter", step: "5", round: 6 });
    j.append({
      event: "run.end",
      data: {
        outcome: "capped",
        reason_code: "max_rounds",
        state: { step: "5", round: 6 },
      },
    });
  });
  const plan = planResume(j.read().events);
  assert.equal(
    plan.resumable,
    true,
    "a capped run continues the SAME PR from its head round once the cap is raised",
  );
  assert.equal(plan.pr, 16571);
  assert.equal(plan.round, 6);
});
