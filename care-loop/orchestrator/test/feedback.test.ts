import { test } from "node:test";
import assert from "node:assert/strict";
import {
  trimBody,
  renderFeedback,
  isBot,
  collectFeedback,
  parseFeedbackClusters,
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

test("renderFeedback tags [addressed round N] for prior-round fixed threads", () => {
  const reviewComments = [
    rc("coderabbitai[bot]", "src/a.ts", 10, 101, "issue A"),
    rc("Copilot", "src/b.ts", 5, 103, "issue B (not yet addressed)"),
  ];
  const { markdown } = renderFeedback({
    pr: 42,
    reviewComments,
    issueComments: [],
    resolvedIds: [],
    addressedThreads: [{ threadId: 101, round: 2 }],
  });
  assert.match(markdown, /\(thread 101\) \[addressed round 2\]/);
  assert.doesNotMatch(markdown, /\(thread 103\).*\[addressed/);
  // resolved takes priority — a simultaneously resolved + addressed thread should read [resolved]
  const { markdown: m2 } = renderFeedback({
    pr: 42,
    reviewComments: [rc("coderabbitai[bot]", "src/a.ts", 10, 101, "issue A")],
    issueComments: [],
    resolvedIds: [101],
    addressedThreads: [{ threadId: 101, round: 2 }],
  });
  assert.match(m2, /\(thread 101\) \[resolved\]/);
  assert.doesNotMatch(m2, /\[addressed/);
});

test("parseFeedbackClusters groups the digest by file + splits the summary", () => {
  const { markdown } = renderFeedback({
    pr: 42,
    reviewComments: [
      rc("coderabbitai[bot]", "src/a.ts", 10, 101, "issue A"),
      rc("greptile-apps[bot]", "src/a.ts", 22, 102, "issue A-2 other line"),
      rc("Copilot", "src/b.ts", 5, 103, "issue B"),
    ],
    issueComments: [ic("greptile-apps[bot]", 200, "overall the PR reads fine")],
    resolvedIds: [],
  });

  const { clusters, summary } = parseFeedbackClusters(markdown);
  assert.deepEqual(clusters.map((c) => c.file).sort(), [
    "src/a.ts",
    "src/b.ts",
  ]); // two files, a.ts's two lines collapse into one cluster
  const a = clusters.find((c) => c.file === "src/a.ts")!;
  assert.match(a.text, /src\/a\.ts:10/);
  assert.match(a.text, /src\/a\.ts:22/); // both of a.ts's locations in its one cluster
  assert.doesNotMatch(a.text, /src\/b\.ts/); // not another file's
  assert.match(summary, /overall the PR reads fine/); // summary section carried separately, not a cluster
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

// ── PLAN-pr-salvage §6: opt-in digest extensions ──────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  selectReviewBodies,
  parseUnanchoredFindings,
  type FeedbackOptions,
} from "../src/feedback.ts";
import type { PrReview } from "../src/github.ts";

const rv = (
  id: number,
  user: string,
  body: string,
  commitId = "sha0",
  submittedAt = "2026-08-13T10:00:00Z",
): PrReview => ({ id, user, body, commitId, submittedAt, state: "COMMENTED" });

test("byte-identity: reviews + options-off render identically to no reviews / no options (§3.0)", () => {
  const reviewComments = [
    rc("coderabbitai[bot]", "src/a.ts", 10, 101, "issue A"),
    rc("Copilot", "src/b.ts", 5, 103, "issue B"),
  ];
  const issueComments = [ic("greptile-apps[bot]", 200, "## Summary\nfine")];
  const base = renderFeedback({
    pr: 42,
    reviewComments,
    issueComments,
    resolvedIds: [],
    now: "2026-08-13T10:00:00Z",
  });
  const withReviewsOff = renderFeedback({
    pr: 42,
    reviewComments,
    issueComments,
    resolvedIds: [],
    reviews: [rv(1, "github-actions[bot]", "> Generated by [CARE PR Reviewer](x)")],
    // options undefined ⇒ every extension inert
    now: "2026-08-13T10:00:00Z",
  });
  assert.equal(withReviewsOff.markdown, base.markdown); // reviews are inert when options are off
  assert.doesNotMatch(withReviewsOff.markdown, /Review summaries/);
  assert.doesNotMatch(withReviewsOff.markdown, /CARE PR Reviewer/);
});

test("attributeSources: our reviewer is named (not the github-actions login); GA noise excluded", () => {
  const opts: FeedbackOptions = { attributeSources: true };
  const reviews = [rv(500, "github-actions[bot]", "> Generated by [CARE PR Reviewer](x)")];
  const { markdown } = renderFeedback({
    pr: 42,
    reviewComments: [
      // CARE inline comment: GA login, joins to review 500 → attributed to CARE
      { ...rc("github-actions[bot]", "src/a.ts", 10, 101, "real finding"), reviewId: 500 },
    ],
    issueComments: [
      // Playwright results: GA login, no marker, no review → excluded
      ic("github-actions[bot]", 900, "## 🎭 Playwright Test Results\nPassed"),
    ],
    resolvedIds: [],
    reviews,
    options: opts,
    now: "n",
  });
  assert.match(markdown, /\*\*CARE PR Reviewer\*\* \(thread 101\)/);
  assert.doesNotMatch(markdown, /github-actions\[bot\]/); // login never shown when attributed
  assert.doesNotMatch(markdown, /Playwright Test Results/); // GA-no-marker issue comment dropped
});

test("trim budget: a trusted reviewer keeps a fenced code block the untrusted budget would cut", () => {
  const long =
    "This selector is fragile because the button name changed.\n".repeat(10) +
    "```ts\nawait expect(page.getByRole('button', { name: 'Book' })).toBeVisible();\n```";
  const mk = (user: string, reviews: PrReview[], reviewId?: number) =>
    renderFeedback({
      pr: 1,
      reviewComments: [{ ...rc(user, "src/a.ts", 1, 1, long), reviewId }],
      issueComments: [],
      resolvedIds: [],
      reviews,
      options: { attributeSources: true },
      now: "n",
    }).markdown;

  const trusted = mk("github-actions[bot]", [rv(7, "github-actions[bot]", "Generated by [CARE PR Reviewer](x)")], 7);
  const untrusted = mk("coderabbitai[bot]", []);
  assert.match(trusted, /await expect\(page\.getByRole/); // survives unbounded
  assert.doesNotMatch(untrusted, /await expect\(page\.getByRole/); // cut by 600/8
});

test("reviewBodies: latest 2 bodies per source, newest first, SHA-labeled", () => {
  const reviews = [
    rv(1, "github-actions[bot]", "Generated by [CARE PR Reviewer](x)\nround1", "aaaaaaa1", "2026-08-13T10:00:00Z"),
    rv(2, "github-actions[bot]", "Generated by [CARE PR Reviewer](x)\nround2", "bbbbbbb2", "2026-08-13T11:00:00Z"),
    rv(3, "github-actions[bot]", "Generated by [CARE PR Reviewer](x)\nround3", "ccccccc3", "2026-08-13T12:00:00Z"),
  ];
  const { markdown } = renderFeedback({
    pr: 1,
    reviewComments: [],
    issueComments: [],
    resolvedIds: [],
    reviews,
    options: { reviewBodies: true },
    now: "n",
  });
  assert.match(markdown, /## Review summaries/);
  assert.match(markdown, /round3/); // newest kept
  assert.match(markdown, /round2/); // second-newest kept
  assert.doesNotMatch(markdown, /round1/); // oldest dropped (latest-2)
  assert.match(markdown, /ccccccc3/); // SHA label present
  // newest appears before second-newest
  assert.ok(markdown.indexOf("round3") < markdown.indexOf("round2"));
});

test("selectReviewBodies: drops empty bodies and unresolved sources", () => {
  const kept = selectReviewBodies([
    rv(1, "github-actions[bot]", "Generated by [CARE PR Reviewer](x)\nreal", "s1"),
    rv(2, "github-actions[bot]", "", "s2"), // empty body → drop
    rv(3, "github-actions[bot]", "no marker deploy status", "s3"), // GA no marker → drop
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].source, "CARE PR Reviewer");
});

test("parseUnanchoredFindings: real #16632 Grumpy review body", () => {
  const body = readFileSync(
    join(import.meta.dirname, "fixtures/pr16632-grumpy-unanchored.txt"),
    "utf8",
  );
  const findings = parseUnanchoredFindings([
    rv(4934745525, "github-actions[bot]", body, "172b944"),
  ]);
  assert.ok(findings.length >= 1);
  const first = findings.find((f) =>
    f.path.endsWith("appointmentBooking.spec.ts"),
  );
  assert.ok(first, "should find the appointmentBooking finding");
  assert.equal(first!.line, 222);
  assert.equal(first!.source, "Grumpy PR Reviewer");
  assert.match(first!.body, /cannot fail|no available slots|empty state/i); // prose captured, not just loc
  // dedup: same path:line from same source once
  const keys = findings.map((f) => `${f.path}:${f.line}`);
  assert.equal(keys.length, new Set(keys).size);
});

test("unanchored findings render into the digest under attributeSources+unanchored", () => {
  const body = readFileSync(
    join(import.meta.dirname, "fixtures/pr16632-grumpy-unanchored.txt"),
    "utf8",
  );
  const { markdown } = renderFeedback({
    pr: 16632,
    reviewComments: [],
    issueComments: [],
    resolvedIds: [],
    reviews: [rv(1, "github-actions[bot]", body, "172b944")],
    options: { unanchored: true },
    now: "n",
  });
  assert.match(markdown, /## Unanchored findings/);
  assert.match(markdown, /appointmentBooking\.spec\.ts:222/);
});
