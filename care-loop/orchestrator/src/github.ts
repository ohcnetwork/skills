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
  createPr(input: {
    head: string;
    base: string;
    title: string;
    body: string;
    draft?: boolean;
  }): Promise<number>;
  addLabel(pr: number, label: string): Promise<void>;
  createComment(pr: number, body: string): Promise<void>;
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

export class OctokitGitHub implements GitHubApi {
  private readonly kit: Octokit;
  constructor(
    private readonly repo: Repo = { owner: "ohcnetwork", name: "care_fe" },
    token?: string,
  ) {
    this.kit = new Octokit({ auth: resolveToken(token) });
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

  async listResolvedReviewCommentIds(pr: number): Promise<number[]> {
    // REST doesn't expose thread isResolved — one GraphQL call. On any failure return [] (nothing
    // tagged resolved), matching the feedback collector's safe default.
    const query = `query($owner:String!,$name:String!,$pr:Int!){
      repository(owner:$owner,name:$name){ pullRequest(number:$pr){
        reviewThreads(first:100){ nodes{ isResolved comments(first:50){ nodes{ databaseId } } } } } } }`;
    try {
      const res = (await this.kit.graphql(query, {
        owner: this.repo.owner,
        name: this.repo.name,
        pr,
      })) as any;
      const nodes = res?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
      const ids: number[] = [];
      for (const t of nodes) {
        if (!t?.isResolved) continue;
        for (const c of t?.comments?.nodes ?? [])
          if (typeof c?.databaseId === "number") ids.push(c.databaseId);
      }
      return ids;
    } catch {
      return [];
    }
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
