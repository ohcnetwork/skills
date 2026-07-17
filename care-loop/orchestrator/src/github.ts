// github.ts — the ONE GitHub I/O boundary for the orchestrator (replaces every `gh` CLI call).
//
// Why: the `gh` CLI is the fragile seam — it pages TTY output (wedging the integrated terminal,
// the crash we just hit), needs a PATH prelude, and returns text to parse. Octokit is typed REST +
// GraphQL over HTTPS: no subprocess, no pager, no TTY. `git` and `npm` stay as subprocess (shell.ts)
// — they are not the paging culprit and have no reliable non-subprocess substitute (worktree/build).
//
// Contract: nothing else in the orchestrator talks to GitHub. Code depends on the `GitHubApi`
// interface; the real impl is Octokit-backed, tests inject a fake (same DI pattern as pipeline.ts).
//
// Token: GITHUB_AUTH_TOKEN / GITHUB_TOKEN / GH_TOKEN from the environment, or a .env file (the
// repo-root skills/.env or orchestrator/.env). As a local convenience it falls back to the gh CLI's
// own token via `gh auth token` (a single non-paging call).

import { execFileSync } from "node:child_process";
import { Octokit } from "octokit";
import { config as loadDotenv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // care-loop/orchestrator/src
// Load the orchestrator env first, then the repo-root skills/.env as a fallback (dotenv never
// overrides an already-set var, so the more specific one wins).
loadDotenv({ path: join(HERE, "../.env"), quiet: true });
loadDotenv({ path: join(HERE, "../../../.env"), quiet: true });

export interface Repo {
  owner: string;
  name: string;
}

export interface PrInfo {
  number: number;
  state: string; // "open" | "closed"
  headSha: string;
  headRef: string;
  title: string;
}

export interface PrReview {
  user: string;
  submittedAt: string; // ISO
  state: string;
  commitId: string; // the SHA this review was submitted against (resume: bots-at-head)
}

export interface PrComment {
  user: string;
  createdAt: string;
  updatedAt: string;
  body: string;
  id?: number; // comment/thread id (review + issue comments)
  path?: string; // review comments only
  line?: number | null; // review comments only
}

/** A review thread, with the GraphQL node id (needed to RESOLVE it), its resolution state, the
 *  databaseIds of its comments (what the feedback digest + triage items reference), and every comment
 *  body (so Step 7 can detect its own `— care-loop 🤖` signature and stay idempotent on resume). */
export interface ReviewThread {
  threadId: string; // GraphQL node id — the resolveReviewThread input
  isResolved: boolean;
  commentDbIds: number[]; // REST databaseIds of the thread's comments
  bodies: string[]; // comment bodies, in order — scanned for our signature
}

export type CiConclusion = "pass" | "fail" | "pending" | "none";
export interface CheckSummary {
  total: number;
  pending: number;
  failing: number;
  conclusion: CiConclusion;
  /** Raw legacy commit-status contexts (name + state). Lets the poller treat advisory review-bot
   *  statuses (e.g. a perpetually-pending "CodeRabbit") as non-blocking and detect bot presence.
   *  Optional so existing fixtures/callers stay valid. */
  statuses?: { context: string; state: string }[];
}

/** The complete GitHub surface the loop needs. Everything is normalized (no raw gh/Octokit shapes). */
export interface GitHubApi {
  getPr(pr: number): Promise<PrInfo>;
  listReviews(pr: number): Promise<PrReview[]>;
  listReviewComments(pr: number): Promise<PrComment[]>;
  listIssueComments(pr: number): Promise<PrComment[]>;
  getChecks(ref: string): Promise<CheckSummary>;
  /** databaseIds of review comments belonging to RESOLVED threads (GraphQL; [] on failure). */
  listResolvedReviewCommentIds(pr: number): Promise<number[]>;
  /** Every review thread with its node id, resolution state, comment databaseIds + bodies (GraphQL;
   *  [] on failure). The Step-7 reply/resolve driver's source of truth. */
  listReviewThreads(pr: number): Promise<ReviewThread[]>;
  /** Post a reply inside an existing review thread, identified by any comment databaseId in it. */
  replyToReviewComment(
    pr: number,
    commentId: number,
    body: string,
  ): Promise<void>;
  /** Mark a review thread resolved (GraphQL mutation; needs the thread node id). */
  resolveReviewThread(threadId: string): Promise<void>;
  createPr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<number>;
  addLabel(pr: number, label: string): Promise<void>;
  createComment(pr: number, body: string): Promise<void>;
  /** Failing check-run names + summaries for a given ref. Used by the CiFixer track to feed
   *  the ci-fix skill and the human-handoff PR comment. Returns [] on any error. */
  listFailingChecks(ref: string): Promise<{ name: string; summary?: string }[]>;
  /** Enriched failing-check context for the CI-fixer: per failing check, its runner annotations AND
   *  the failure detail extracted from the Actions job log (the real Playwright assertion / stack —
   *  annotations alone are usually just "shard N failed" noise). Returns [] on any error
   *  (best-effort — never throws). */
  getCheckFailureContext(
    ref: string,
  ): Promise<import("./skill-result.js").CiFailure[]>;
}

export function resolveToken(explicit?: string): string {
  const t =
    explicit ??
    process.env.GITHUB_AUTH_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN;
  if (t) return t;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "no GitHub token: set GITHUB_AUTH_TOKEN in skills/.env or run `gh auth login`",
    );
  }
}

/** Extract just the failure detail from a raw GitHub Actions job log — strips per-line ISO timestamps
 *  and ANSI colour, then keeps the lines carrying the assertion/stack signal (Playwright: the failing
 *  spec, `expect(...)`, Expected/Received, code frame). Bounded so the ci-fixer gets the real error,
 *  not a megabyte of setup noise. Falls back to the log tail if no signal line matches. Exported for
 *  unit testing. */
export function extractCiFailureLog(raw: string): string | undefined {
  if (!raw) return undefined;
  const lines = raw
    .replace(/\x1b\[[0-9;]*m/g, "") // strip ANSI colour
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s/, "")); // strip Actions timestamps
  const SIGNAL =
    /\b\d+\)\s|›|Error:|Expected|Received|expect\(|Timed out|toHaveText|toContainText|toBeVisible|locator\(|\.spec\.ts[:(]|AssertionError|✘|✕|\d+\s+failed/i;
  const keep = lines.filter((l) => l.trim() && SIGNAL.test(l));
  const out = keep.join("\n").trim();
  if (out) return out.slice(-4000); // keep the most recent failure detail, bounded
  // No recognisable failure signal — return the log tail so the fixer at least sees the end.
  const tail = lines
    .filter((l) => l.trim())
    .slice(-40)
    .join("\n")
    .trim();
  return tail ? tail.slice(-3000) : undefined;
}

export class OctokitGitHub implements GitHubApi {
  private readonly kit: Octokit;
  constructor(
    private readonly repo: Repo = { owner: "ohcnetwork", name: "care_fe" },
    token?: string,
  ) {
    // Disable the bundled retry plugin: it keys off `error.status` and MISSES GitHub's HTML 500 page
    // (the "Unicorn" page — it surfaces as a body/parse error with no clean status), which aborted a
    // run mid reply/resolve. We install our own request-layer retry below that classifies by message
    // too, so a transient GitHub blip self-heals instead of killing the run.
    this.kit = new Octokit({
      auth: resolveToken(token),
      retry: { enabled: false },
    });
    // Retry TRANSIENT GitHub failures at the request layer — covers every REST + GraphQL call in one
    // place (octokit.graphql routes through octokit.request). Transient = any 5xx (incl. the HTML
    // Unicorn 500), network drops, and secondary rate limits. Real errors (4xx: 404/422/permission)
    // are NEVER retried — they propagate immediately. Exponential backoff, capped.
    this.kit.hook.wrap("request", async (request: any, options: any) => {
      const max = Number(process.env.GH_MAX_RETRIES) || 4;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= max; attempt++) {
        try {
          return await request(options);
        } catch (e: any) {
          lastErr = e;
          const status = e?.status ?? e?.response?.status;
          const msg = String(e?.message ?? e);
          const transient =
            (typeof status === "number" && status >= 500 && status < 600) ||
            /Unicorn|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|network error|secondary rate limit|abuse detection|server error/i.test(
              msg,
            );
          if (!transient || attempt === max) throw e;
          await new Promise((r) =>
            setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 8000)),
          );
        }
      }
      throw lastErr;
    });
  }

  private base() {
    return { owner: this.repo.owner, repo: this.repo.name };
  }

  async getPr(pr: number): Promise<PrInfo> {
    const { data } = await this.kit.rest.pulls.get({
      ...this.base(),
      pull_number: pr,
    });
    return {
      number: data.number,
      state: data.state,
      headSha: data.head.sha,
      headRef: data.head.ref,
      title: data.title,
    };
  }

  async listReviews(pr: number): Promise<PrReview[]> {
    const rows = await this.kit.paginate(this.kit.rest.pulls.listReviews, {
      ...this.base(),
      pull_number: pr,
      per_page: 100,
    });
    return rows.map((r) => ({
      user: r.user?.login ?? "",
      submittedAt: r.submitted_at ?? "",
      state: r.state ?? "",
      commitId: r.commit_id ?? "",
    }));
  }

  async listReviewComments(pr: number): Promise<PrComment[]> {
    const rows = await this.kit.paginate(
      this.kit.rest.pulls.listReviewComments,
      { ...this.base(), pull_number: pr, per_page: 100 },
    );
    return rows.map((c) => ({
      user: c.user?.login ?? "",
      createdAt: c.created_at ?? "",
      updatedAt: c.updated_at ?? "",
      body: c.body ?? "",
      id: c.id,
      path: c.path ?? undefined,
      line: c.line ?? c.original_line ?? null,
    }));
  }

  async listIssueComments(pr: number): Promise<PrComment[]> {
    const rows = await this.kit.paginate(this.kit.rest.issues.listComments, {
      ...this.base(),
      issue_number: pr,
      per_page: 100,
    });
    return rows.map((c) => ({
      user: c.user?.login ?? "",
      createdAt: c.created_at ?? "",
      updatedAt: c.updated_at ?? "",
      body: c.body ?? "",
      id: c.id,
    }));
  }

  async getChecks(ref: string): Promise<CheckSummary> {
    // gh pr checks aggregates GitHub-Actions check-runs AND legacy commit statuses — mirror both.
    const runs = await this.kit.paginate(this.kit.rest.checks.listForRef, {
      ...this.base(),
      ref,
      per_page: 100,
    });
    const status = await this.kit.rest.repos.getCombinedStatusForRef({
      ...this.base(),
      ref,
    });

    let pending = 0;
    let failing = 0;
    for (const r of runs) {
      if (r.status !== "completed") pending++;
      else if (
        r.conclusion &&
        ["failure", "timed_out", "cancelled", "action_required"].includes(
          r.conclusion,
        )
      )
        failing++;
    }
    for (const s of status.data.statuses) {
      if (s.state === "pending") pending++;
      else if (s.state === "failure" || s.state === "error") failing++;
    }
    const total = runs.length + status.data.statuses.length;
    const conclusion: CiConclusion =
      total === 0
        ? "none"
        : failing > 0
          ? "fail"
          : pending > 0
            ? "pending"
            : "pass";
    const statuses = status.data.statuses.map((s) => ({
      context: s.context ?? "",
      state: s.state ?? "",
    }));
    return { total, pending, failing, conclusion, statuses };
  }

  async listFailingChecks(
    ref: string,
  ): Promise<{ name: string; summary?: string }[]> {
    try {
      const runs = await this.kit.paginate(this.kit.rest.checks.listForRef, {
        ...this.base(),
        ref,
        per_page: 100,
      });
      const status = await this.kit.rest.repos.getCombinedStatusForRef({
        ...this.base(),
        ref,
      });
      const failing: { name: string; summary?: string }[] = [];
      const FAIL_CONCLUSIONS = new Set([
        "failure",
        "timed_out",
        "cancelled",
        "action_required",
      ]);
      for (const r of runs) {
        if (
          r.status === "completed" &&
          r.conclusion &&
          FAIL_CONCLUSIONS.has(r.conclusion)
        ) {
          failing.push({
            name: r.name ?? "(unknown check)",
            summary: r.output?.summary?.slice(0, 400) ?? undefined,
          });
          if (failing.length >= 8) break; // cap: enough context without overwhelming the comment
        }
      }
      for (const s of status.data.statuses) {
        if (s.state === "failure" || s.state === "error") {
          failing.push({ name: s.context ?? "(unknown status)" });
          if (failing.length >= 10) break;
        }
      }
      return failing;
    } catch {
      return [];
    }
  }

  async getCheckFailureContext(
    ref: string,
  ): Promise<import("./skill-result.js").CiFailure[]> {
    try {
      const runs = await this.kit.paginate(this.kit.rest.checks.listForRef, {
        ...this.base(),
        ref,
        per_page: 100,
      });
      const FAIL_CONCLUSIONS = new Set([
        "failure",
        "timed_out",
        "cancelled",
        "action_required",
      ]);
      const failing = runs.filter(
        (r) =>
          r.status === "completed" &&
          r.conclusion &&
          FAIL_CONCLUSIONS.has(r.conclusion),
      );
      // The check annotations are runner-level noise for CARE's Playwright CI ("shard N failed",
      // "exit code 1") — the REAL failure (which spec, expected-vs-received) lives in the Actions
      // JOB LOG. Fetch + extract those so the ci-fixer has something to act on (else it noops).
      const jobLogs = await this.failingJobLogs(ref);
      const results: import("./skill-result.js").CiFailure[] = [];
      for (const run of failing.slice(0, 8)) {
        let annotations: { path: string; line: number; message: string }[] = [];
        try {
          const raw = await this.kit.paginate(
            this.kit.rest.checks.listAnnotations,
            {
              ...this.base(),
              check_run_id: run.id,
              per_page: 50,
            },
          );
          annotations = raw
            .filter(
              (a) =>
                a.annotation_level === "failure" ||
                a.annotation_level === "warning",
            )
            .slice(0, 20)
            .map((a) => ({
              path: a.path,
              line: a.start_line,
              message: (a.message ?? a.raw_details ?? "").slice(0, 500),
            }));
        } catch {
          /* best-effort */
        }
        results.push({
          name: run.name ?? "(unknown check)",
          summary: run.output?.summary?.slice(0, 400) ?? undefined,
          annotations: annotations.length > 0 ? annotations : undefined,
          log: jobLogs.get(run.name ?? "") ?? undefined,
        });
      }
      // Fallback: if no check-run name matched a job (name skew between the check + the Actions job),
      // but we DID pull logs, attach the combined extract to the first failing check so the detail
      // isn't lost.
      if (
        results.length > 0 &&
        !results.some((r) => r.log) &&
        jobLogs.size > 0
      ) {
        results[0].log = [...jobLogs.values()].join("\n\n").slice(0, 6000);
      }
      return results;
    } catch {
      return [];
    }
  }

  /** Failing Actions job logs at `ref`, keyed by job name, with only the failure detail extracted
   *  (Playwright assertion / stack). Best-effort — returns an empty map on any failure so the CI-fix
   *  path degrades to annotations-only rather than throwing. */
  private async failingJobLogs(ref: string): Promise<Map<string, string>> {
    const byName = new Map<string, string>();
    try {
      const runsRes = await this.kit.rest.actions.listWorkflowRunsForRepo({
        ...this.base(),
        head_sha: ref,
        per_page: 20,
      });
      const wfRuns = (runsRes.data.workflow_runs ?? []).filter(
        (r) =>
          r.conclusion &&
          r.conclusion !== "success" &&
          r.conclusion !== "skipped",
      );
      for (const wf of wfRuns.slice(0, 5)) {
        const jobs = await this.kit.paginate(
          this.kit.rest.actions.listJobsForWorkflowRun,
          { ...this.base(), run_id: wf.id, per_page: 50 },
        );
        const failedJobs = jobs.filter(
          (j) =>
            j.conclusion &&
            ["failure", "timed_out", "cancelled"].includes(j.conclusion),
        );
        for (const job of failedJobs.slice(0, 8)) {
          try {
            const logRes =
              await this.kit.rest.actions.downloadJobLogsForWorkflowRun({
                ...this.base(),
                job_id: job.id,
              });
            const text =
              typeof logRes.data === "string"
                ? logRes.data
                : Buffer.from(logRes.data as ArrayBuffer).toString("utf8");
            const extracted = extractCiFailureLog(text);
            if (extracted) byName.set(job.name ?? "", extracted);
          } catch {
            /* best-effort per job */
          }
        }
      }
    } catch {
      /* best-effort — degrade to annotations-only */
    }
    return byName;
  }

  async listResolvedReviewCommentIds(pr: number): Promise<number[]> {
    // Derived from the richer listReviewThreads (one GraphQL query definition). On any failure that
    // returns [], so this yields [] too — the feedback collector's safe default (nothing tagged).
    const ids: number[] = [];
    for (const t of await this.listReviewThreads(pr))
      if (t.isResolved) ids.push(...t.commentDbIds);
    return ids;
  }

  async listReviewThreads(pr: number): Promise<ReviewThread[]> {
    // REST doesn't expose thread node ids / isResolved — one GraphQL call. On any failure return []
    // (Step 7 then no-ops rather than throwing mid-run), matching the collector's safe default.
    const query = `query($owner:String!,$name:String!,$pr:Int!){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        reviewThreads(first:100){ nodes{ id isResolved comments(first:50){ nodes{ databaseId body } } } } } } }`;
    try {
      const res = (await this.kit.graphql(query, {
        owner: this.repo.owner,
        name: this.repo.name,
        pr,
      })) as any;
      const nodes = res?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      return nodes
        .filter((t: any) => typeof t?.id === "string")
        .map((t: any) => {
          const comments = t?.comments?.nodes ?? [];
          return {
            threadId: t.id as string,
            isResolved: !!t.isResolved,
            commentDbIds: comments
              .map((c: any) => c?.databaseId)
              .filter((n: any): n is number => typeof n === "number"),
            bodies: comments.map((c: any) => String(c?.body ?? "")),
          };
        });
    } catch {
      return [];
    }
  }

  async replyToReviewComment(
    pr: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.kit.rest.pulls.createReplyForReviewComment({
      ...this.base(),
      pull_number: pr,
      comment_id: commentId,
      body,
    });
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    const mutation = `mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ isResolved } } }`;
    await this.kit.graphql(mutation, { id: threadId });
  }

  async createPr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<number> {
    const { data } = await this.kit.rest.pulls.create({
      ...this.base(),
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      draft: input.draft ?? false,
    });
    return data.number;
  }

  async addLabel(pr: number, label: string): Promise<void> {
    await this.kit.rest.issues.addLabels({
      ...this.base(),
      issue_number: pr,
      labels: [label],
    });
  }

  async createComment(pr: number, body: string): Promise<void> {
    await this.kit.rest.issues.createComment({
      ...this.base(),
      issue_number: pr,
      body,
    });
  }
}
