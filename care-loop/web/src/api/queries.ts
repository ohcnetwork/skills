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
  EnqueueResult,
  GateAnswer,
  GateAsk,
  NewRunRequest,
  QueueRow,
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
    // Both halves are nullable: `run` is absent until a process writes a journal, `queue` is absent
    // for a CLI-started run. A queued run is addressable before either exists, because the id is
    // minted at enqueue.
    queryFn: () => api.get<{ run: RunRecord | null; queue: QueueRow | null }>(`/api/runs/${runId}`),
    refetchInterval: opts.refetch,
  });
}

/** Page size for the timeline. The API caps at 2000; asking for that in one shot and ignoring
 *  `next_seq` meant a long run's timeline simply STOPPED at 2000 with nothing saying so. The live
 *  fleet already has a 327-event run. */
const EVENTS_PAGE = 500;

export function useRunEvents(runId: string, opts: { refetch?: number; enabled?: boolean } = {}) {
  return useInfiniteQuery({
    // A queued run has an id but no journal, so this route 404s until a process writes one. Asking
    // anyway would 404 on every poll of a perfectly healthy run.
    enabled: opts.enabled ?? true,
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

export function useRunArtifacts(runId: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["run-artifacts", runId],
    queryFn: () => api.get<{ items: ArtifactSummary[] }>(`/api/runs/${runId}/artifacts`),
    enabled: opts.enabled ?? true,
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

// ── Queue + gate ─────────────────────────────────────────────────────────────────────────────────

export function useQueue(opts: { refetch?: number } = {}) {
  return useQuery({
    queryKey: ["queue"],
    queryFn: () => api.get<Page<QueueRow>>("/api/queue"),
    refetchInterval: opts.refetch,
  });
}

/** Every run with an open question. Polled, because the answer to "is anything waiting on me" has to
 *  arrive without a reload — a gate nobody notices is a gate that expires, and expiry is the one
 *  outcome that throws away finished planning work. */
export function useGates(opts: { refetch?: number } = {}) {
  return useQuery({
    queryKey: ["gates"],
    queryFn: () => api.get<{ items: GateAsk[]; total: number }>("/api/gates"),
    refetchInterval: opts.refetch ?? 10_000,
  });
}

export function useRunGate(runId: string, opts: { refetch?: number } = {}) {
  return useQuery({
    queryKey: ["gate", runId],
    queryFn: () => api.get<{ ask: GateAsk | null }>(`/api/runs/${runId}/gate`),
    refetchInterval: opts.refetch,
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewRunRequest) => api.post<EnqueueResult>("/api/runs", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["runs"] });
      void qc.invalidateQueries({ queryKey: ["queue"] });
    },
  });
}

export function useAnswerGate(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (answer: GateAnswer) =>
      api.post<{ run_id: string; ask_id: string; readmitted: boolean }>(
        `/api/runs/${runId}/gate`,
        answer,
      ),
    // The answer re-admits the run, so the queue and the fleet both change — and `gates` most of all,
    // since this run just left the needs-you list.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["gate", runId] });
      void qc.invalidateQueries({ queryKey: ["gates"] });
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["run", runId] });
    },
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      api.post<{ cancelled: boolean; signalled: boolean }>(`/api/runs/${runId}/cancel`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["queue"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
      void qc.invalidateQueries({ queryKey: ["gates"] });
    },
  });
}
