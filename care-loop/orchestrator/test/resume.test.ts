import { test } from "node:test";
import assert from "node:assert/strict";
import { probePr } from "../src/resume.ts";
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
