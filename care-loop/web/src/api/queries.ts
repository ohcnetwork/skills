// api/queries.ts — every server interaction, as TanStack Query hooks.
//
// Query keys mirror the URL they fetch, so a filter change is a new key and therefore a new cache
// entry rather than a mutation of an existing one. That is what makes back/forward navigation
// instant: the previous filter's results are still cached under their own key.

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { api, qs } from "./client";
import type {
  ArtifactBody,
  ArtifactSummary,
  EventPage,
  Facets,
  Page,
  RunFilters,
  RunRecord,
  RunSummary,
  User,
} from "./types";

export interface Me {
  login: string | null;
  account: User | null;
}

/** Who the caller is. Answers 200-with-null when nobody is signed in, so this is one unconditional
 *  call whose RESULT decides between the login screen and the app — an anonymous visitor is a state,
 *  not an error, and must not be retried as though the request failed. */
export function useMe(): UseQueryResult<Me> {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<Me>("/api/auth/me"),
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (login: string) => api.post<{ user: User }>("/api/auth/login", { login }),
    // Refetch rather than write the result into the cache: the session cookie is what actually
    // decides identity from here on, so re-asking the server is the honest confirmation that it
    // stuck. Writing `me` optimistically would show a signed-in UI even if the cookie were rejected.
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>("/api/auth/logout"),
    // Everything cached was fetched as someone. Clear all of it, not just `me`.
    onSuccess: () => void qc.clear(),
  });
}

export function useRuns(filters: RunFilters, opts: { refetch?: number } = {}) {
  return useQuery({
    queryKey: ["runs", filters],
    queryFn: () => api.get<Page<RunSummary>>(`/api/runs${qs(filters)}`),
    // Keep showing the previous page while the next loads, so tabbing a filter does not blank the
    // table and jump the scroll position.
    placeholderData: (prev) => prev,
    refetchInterval: opts.refetch,
  });
}

export function useFacets(filters: RunFilters) {
  // Facets answer the SAME filter as the list, so narrowing to one repo offers only that repo's
  // branches. Paging params are stripped: they do not change which values exist.
  const { limit: _l, offset: _o, order: _r, dir: _d, ...rest } = filters;
  return useQuery({
    queryKey: ["facets", rest],
    queryFn: () => api.get<Facets>(`/api/runs/facets${qs(rest)}`),
    staleTime: 30_000,
  });
}

export function useRun(runId: string, opts: { refetch?: number } = {}) {
  return useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.get<{ run: RunRecord; queue: unknown }>(`/api/runs/${runId}`),
    refetchInterval: opts.refetch,
  });
}

/** Page size for the timeline. The API caps at 2000; asking for that in one shot and ignoring
 *  `next_seq` meant a long run's timeline simply STOPPED at 2000 with nothing saying so. The live
 *  fleet already has a 327-event run. */
const EVENTS_PAGE = 500;

export function useRunEvents(runId: string, opts: { refetch?: number } = {}) {
  return useInfiniteQuery({
    queryKey: ["run-events", runId],
    queryFn: ({ pageParam }) =>
      api.get<EventPage>(
        `/api/runs/${runId}/events${qs({ limit: EVENTS_PAGE, after_seq: pageParam })}`,
      ),
    initialPageParam: undefined as number | undefined,
    // `next_seq` is null on the last page — the API returns it precisely so the client does not have
    // to guess from a short page.
    getNextPageParam: (last) => last.next_seq ?? undefined,
    refetchInterval: opts.refetch,
  });
}

export function useRunArtifacts(runId: string) {
  return useQuery({
    queryKey: ["run-artifacts", runId],
    queryFn: () => api.get<{ items: ArtifactSummary[] }>(`/api/runs/${runId}/artifacts`),
  });
}

/** One artifact body, fetched only when opened — bodies are the heavy part and a timeline shows
 *  dozens of refs. `enabled` is what keeps this lazy. */
export function useArtifact(runId: string, sha: string | null) {
  return useQuery({
    queryKey: ["artifact", runId, sha],
    queryFn: () =>
      api.get<ArtifactBody>(`/api/runs/${runId}/artifacts/${(sha ?? "").replace(/^sha256:/, "")}`),
    enabled: sha !== null,
    staleTime: Infinity, // content-addressed: a given sha never changes
  });
}
