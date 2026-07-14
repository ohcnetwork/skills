import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trimBody,
  renderFeedback,
  isBot,
  collectFeedback,
} from "../src/feedback.ts";
import type { PrComment } from "../src/github.ts";
import { makeFakeGitHub } from "./fake-github.ts";

const rc = (
  user: string,
  path: string,
  line: number,
  id: number,
  body: string,
): PrComment => ({
  user,
  path,
  line,
  id,
  body,
  createdAt: "",
  updatedAt: "",
});
const ic = (user: string, id: number, body: string): PrComment => ({
  user,
  id,
  body,
  createdAt: "",
  updatedAt: "",
});

test("isBot matches the bot logins, not humans", () => {
  assert.equal(isBot("coderabbitai[bot]"), true);
  assert.equal(isBot("greptile-apps[bot]"), true);
  assert.equal(isBot("Copilot"), true);
  assert.equal(isBot("chatgpt-codex-connector[bot]"), true);
  assert.equal(isBot("jacobjeevan"), false);
});

test("trimBody drops <details> blocks and the AI-agent prompt chrome", () => {
  const body = [
    "Real finding: this is wrong.",
    "<details>",
    "prompt for AI agents",
    "lots of collapsible chrome",
    "</details>",
    "Second real line.",
  ].join("\n");
  const out = trimBody(body);
  assert.match(out, /Real finding/);
  assert.match(out, /Second real line/);
  assert.doesNotMatch(out, /collapsible chrome/);
  assert.doesNotMatch(out, /prompt for AI agents/i);
});

test("trimBody strips HTML tags, comments, images, and table rules", () => {
  const body = [
    "<!-- hidden -->",
    "| --- | :--: |",
    "![img](http://x/y.png)",
    "<b>bold</b> text",
  ].join("\n");
  const out = trimBody(body);
  assert.equal(out.includes("<b>"), false);
  assert.equal(out.includes("hidden"), false);
  assert.equal(out.includes("---"), false);
  assert.equal(out.includes("http://x/y.png"), false);
  assert.match(out, /bold text/);
});

test("trimBody caps at 8 non-empty lines and 600 chars", () => {
  const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const out = trimBody(body);
  assert.ok(out.split("\n").filter((l) => l.trim()).length <= 8);
  assert.ok(out.length <= 600);
});

test("renderFeedback groups inline comments by path:line and tags resolved threads", () => {
  const reviewComments = [
    rc("coderabbitai[bot]", "src/a.ts", 10, 101, "issue A"),
    rc("greptile-apps[bot]", "src/a.ts", 10, 102, "issue A-2 co-located"),
    rc("Copilot", "src/b.ts", 5, 103, "issue B"),
    rc("jacobjeevan", "src/a.ts", 10, 999, "human comment — excluded"),
  ];
  const issueComments = [
    ic("greptile-apps[bot]", 200, "## Summary\nlooks fine"),
  ];
  const { markdown, count } = renderFeedback({
    pr: 42,
    reviewComments,
    issueComments,
    resolvedIds: [102],
  });

  assert.equal(count, 4); // 3 bot inline + 1 bot summary; human excluded
  assert.match(markdown, /- `src\/a\.ts:10`/);
  assert.match(markdown, /- `src\/b\.ts:5`/);
  assert.match(markdown, /\(thread 102\) \[resolved\]/); // greptile co-located tagged resolved
  assert.doesNotMatch(markdown, /human comment/);
  // co-located a.ts:10 header printed once, both bot threads under it
  assert.equal((markdown.match(/- `src\/a\.ts:10`/g) ?? []).length, 1);
  assert.match(markdown, /coderabbitai\[bot\]\*\* \(thread 101\)/);
});

test("collectFeedback fetches via the boundary and returns the digest", async () => {
  const gh = makeFakeGitHub({
    listReviewComments: async () => [
      rc("coderabbitai[bot]", "src/x.ts", 1, 1, "finding"),
    ],
    listIssueComments: async () => [ic("greptile-apps[bot]", 2, "summary")],
    listResolvedReviewCommentIds: async () => [],
  });
  const { markdown, count } = await collectFeedback(gh, { pr: 7 });
  assert.equal(count, 2);
  assert.match(markdown, /PR #7 — pre-digested bot feedback/);
  assert.match(markdown, /## Inline comments/);
  assert.match(markdown, /## Summary comments/);
});
