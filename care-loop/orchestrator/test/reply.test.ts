import { test } from "node:test";
import assert from "node:assert/strict";
import { replyAndResolve, renderReplyBody, CARE_SIGNATURE, type Verdict } from "../src/reply.ts";
import type { ReviewThread } from "../src/github.ts";
import { makeFakeGitHub } from "./fake-github.ts";
import type { TriageItem } from "../src/skill-result.ts";

const resolveSet: ReadonlySet<Verdict> = new Set(["address", "decline"]);

/** A gh fake over a fixed set of threads, recording every reply + resolve. */
function ghOver(threads: ReviewThread[]) {
  const replies: { commentId: number; body: string }[] = [];
  const resolved: string[] = [];
  const gh = makeFakeGitHub({
    listReviewThreads: async () => threads,
    replyToReviewComment: async (_pr, commentId, body) => {
      replies.push({ commentId, body });
    },
    resolveReviewThread: async (threadId) => {
      resolved.push(threadId);
    },
  });
  return { gh, replies, resolved };
}

const thread = (over: Partial<ReviewThread> & { threadId: string }): ReviewThread => ({
  isResolved: false,
  commentDbIds: [],
  bodies: [],
  ...over,
});

test("renderReplyBody carries the verdict label, reason, and signature", () => {
  const body = renderReplyBody({ verdict: "address", reason: "fixed the off-by-one" });
  assert.match(body, /care-loop: addressed/);
  assert.match(body, /fixed the off-by-one/);
  assert.ok(body.includes(CARE_SIGNATURE));
});

test("replies to every triaged thread and resolves both verdicts (address + decline)", async () => {
  const threads = [
    thread({ threadId: "T_addr", commentDbIds: [101] }),
    thread({ threadId: "T_decl", commentDbIds: [102] }),
  ];
  const { gh, replies, resolved } = ghOver(threads);
  const items: TriageItem[] = [
    { verdict: "address", reason: "fix", threads: [101] },
    { verdict: "decline", reason: "out of scope", threads: [102] },
  ];
  const r = await replyAndResolve({ gh, pr: 7, items, resolve: resolveSet });

  assert.equal(r.replied, 2, "every triaged thread gets a reply");
  assert.deepEqual(
    replies.map((x) => x.commentId).sort(),
    [101, 102],
  );
  assert.equal(r.resolved, 2); // nothing left open for a human
  assert.deepEqual(resolved.sort(), ["T_addr", "T_decl"]);
});

test("idempotent: a thread already carrying our signature is skipped", async () => {
  const threads = [
    thread({ threadId: "T1", commentDbIds: [201], bodies: [`old note ${CARE_SIGNATURE}`] }),
  ];
  const { gh, replies, resolved } = ghOver(threads);
  const items: TriageItem[] = [{ verdict: "address", reason: "fix", threads: [201] }];
  const r = await replyAndResolve({ gh, pr: 7, items, resolve: resolveSet });

  assert.equal(r.replied, 0);
  assert.equal(r.resolved, 0);
  assert.equal(r.skipped, 1);
  assert.equal(replies.length, 0);
  assert.equal(resolved.length, 0);
});

test("an unknown / stale thread id is skipped, not thrown", async () => {
  const { gh, replies } = ghOver([thread({ threadId: "T1", commentDbIds: [1] })]);
  const items: TriageItem[] = [{ verdict: "address", threads: [999] }];
  const r = await replyAndResolve({ gh, pr: 7, items, resolve: resolveSet });
  assert.equal(r.replied, 0);
  assert.equal(r.skipped, 1);
  assert.equal(replies.length, 0);
});

test("two items pointing at the same thread reply only once", async () => {
  const { gh, replies, resolved } = ghOver([
    thread({ threadId: "T1", commentDbIds: [301, 302] }),
  ]);
  const items: TriageItem[] = [
    { verdict: "address", reason: "a", threads: [301] },
    { verdict: "decline", reason: "b", threads: [302] },
  ];
  const r = await replyAndResolve({ gh, pr: 7, items, resolve: resolveSet });
  assert.equal(r.replied, 1);
  assert.equal(replies.length, 1);
  assert.equal(resolved.length, 1); // resolved once (first item, address)
});

test("items without thread ids produce no thread I/O", async () => {
  const { gh, replies, resolved } = ghOver([thread({ threadId: "T1", commentDbIds: [1] })]);
  const items: TriageItem[] = [{ verdict: "address", reason: "summary-derived" }];
  const r = await replyAndResolve({ gh, pr: 7, items, resolve: resolveSet });
  assert.equal(r.replied, 0);
  assert.equal(replies.length, 0);
  assert.equal(resolved.length, 0);
});
