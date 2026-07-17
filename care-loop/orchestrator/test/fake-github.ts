// Shared test double for the GitHubApi boundary — full interface, overridable per test.
import type {
  CheckSummary,
  GitHubApi,
  PrComment,
  PrInfo,
  PrReview,
} from "../src/github.ts";

export function makeFakeGitHub(o: Partial<GitHubApi> = {}): GitHubApi {
  return {
    getPr: async (): Promise<PrInfo> => ({
      number: 1,
      state: "open",
      headSha: "head",
      headRef: "b",
      title: "[ENG-1] t",
    }),
    listReviews: async (): Promise<PrReview[]> => [],
    listReviewComments: async (): Promise<PrComment[]> => [],
    listIssueComments: async (): Promise<PrComment[]> => [],
    getChecks: async (): Promise<CheckSummary> => ({
      total: 0,
      pending: 0,
      failing: 0,
      conclusion: "none",
      statuses: [],
    }),
    listResolvedReviewCommentIds: async (): Promise<number[]> => [],
    listReviewThreads: async () => [],
    replyToReviewComment: async (): Promise<void> => {},
    resolveReviewThread: async (): Promise<void> => {},
    createPr: async (): Promise<number> => 1,
    addLabel: async (): Promise<void> => {},
    createComment: async (): Promise<void> => {},
    listFailingChecks: async (): Promise<
      { name: string; summary?: string }[]
    > => [],
    getCheckFailureContext: async () => [],
    ...o,
  };
}
