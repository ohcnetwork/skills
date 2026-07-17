// reply.ts — the Step-7 "reply-to-every-thread" exit (PLAN-orchestrator-architecture §2: step 5 posts
// replies, step 7 is the terminal done). Once a round's verdicts are known and its fixes are pushed,
// post a verdict reply into every bot review thread the triager judged, and RESOLVE the threads whose
// feedback we acted on or deliberately rejected (policy, injected). Replies are posted for EVERY
// triaged thread regardless.
//
// Idempotent by construction: threads already carrying our `— care-loop 🤖` signature are skipped, so
// a resume, a re-round, or a double call never double-posts (the §6 resume rule made executable). All
// side effects go through the injected GitHubApi, so this is fully fake-testable.

import type { GitHubApi } from "./github.js";
import type { TriageItem } from "./skill-result.js";

/** The idempotency marker. Any thread whose comments already contain this string is left untouched.
 *  Kept in sync with the PLAN §6 resume rule ("skip threads already carrying a `— care-loop 🤖`
 *  reply at head"). */
export const CARE_SIGNATURE = "— care-loop 🤖";

export type Verdict = "address" | "decline";
const VERDICT_LABEL: Record<Verdict, string> = {
  address: "addressed",
  decline: "won't fix",
};

/** Render one thread reply from a triaged item (pure). */
export function renderReplyBody(item: { verdict: Verdict; reason?: string }): string {
  const reason = item.reason?.trim() ? ` — ${item.reason.trim()}` : "";
  return `**care-loop: ${VERDICT_LABEL[item.verdict]}**${reason}\n\n${CARE_SIGNATURE}`;
}

export interface ReplyResolveInput {
  gh: GitHubApi;
  pr: number;
  items: TriageItem[];
  /** verdicts whose threads get RESOLVED after the reply (replies are posted for ALL). */
  resolve: ReadonlySet<Verdict>;
}
export interface ReplyResolveResult {
  replied: number;
  resolved: number;
  skipped: number; // already-signed, already-handled this call, or unmatched thread id
}

/** Post + resolve for one batch of triaged items. Re-fetches the live threads each call, so the
 *  signature scan sees replies posted in earlier rounds (cross-call idempotency). */
export async function replyAndResolve(o: ReplyResolveInput): Promise<ReplyResolveResult> {
  const threads = await o.gh.listReviewThreads(o.pr);
  // databaseId → thread: co-located bots share one thread, so any of its comment ids resolves to it.
  const byDbId = new Map<number, (typeof threads)[number]>();
  for (const t of threads) for (const id of t.commentDbIds) byDbId.set(id, t);

  let replied = 0;
  let resolved = 0;
  let skipped = 0;
  const handled = new Set<string>(); // thread node ids acted on this call (dedup across items)

  for (const item of o.items) {
    const verdict = item.verdict as Verdict;
    for (const dbId of item.threads ?? []) {
      const thread = byDbId.get(dbId);
      if (!thread) {
        skipped++; // stale / unknown id — nothing to reply to
        continue;
      }
      if (handled.has(thread.threadId)) continue; // another item already covered this thread
      if (thread.bodies.some((b) => b.includes(CARE_SIGNATURE))) {
        skipped++; // already replied in a prior round / run — idempotent
        continue;
      }
      handled.add(thread.threadId);
      await o.gh.replyToReviewComment(o.pr, dbId, renderReplyBody({ verdict, reason: item.reason }));
      replied++;
      if (o.resolve.has(verdict) && !thread.isResolved) {
        await o.gh.resolveReviewThread(thread.threadId);
        resolved++;
      }
    }
  }
  return { replied, resolved, skipped };
}
