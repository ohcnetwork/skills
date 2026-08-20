// api/types.ts — the shapes `care-loopd serve` returns ([[PLAN-loop-service]] §6).
//
// Hand-mirrored rather than imported from the orchestrator: the two are separate packages with
// separate builds, and a type-only coupling across that boundary would drag the whole server
// tsconfig into this one. The API contract is frozen and tested server-side, so this file is a
// transcription of a fixed thing rather than a guess that can drift unnoticed.

export interface RunSummary {
  runId: string;
  /** Directory slug — a DISPLAY label. Never key off it; a reused branch collides deterministically. */
  slug: string;
  requestedBy: string | null;
  repo: string;
  branch: string;
  tier: string;
  step: string;
  round: number;
  pr: number | null;
  startedAt: string;
  updatedAt: string;
  eventCount: number;
  costUsd: number | null;
  durationMs: number;
  parityError: string | null;
  stale: boolean;
}

export interface RunRecord extends RunSummary {
  task: string;
  ticket: string | null;
  summary: string | null;
  worktree: string;
  headSha: string | null;
  lastReviewedSha: string | null;
}

export interface JournalEvent {
  seq: number;
  ts: string;
  run_id: string;
  event: string;
  step?: string;
  round?: number;
  data?: Record<string, unknown>;
  cost_cum?: { usd_est: number };
  prev: string;
}

export interface ArtifactSummary {
  path: string;
  name: string;
  sha256: string;
  bytes: number;
}

export interface ArtifactBody extends ArtifactSummary {
  content: unknown;
}

export interface User {
  id: number;
  login: string;
  githubId: number | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface Facets {
  repos: FacetValue[];
  branches: FacetValue[];
  users: FacetValue[];
  steps: FacetValue[];
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  /** The limit ACTUALLY applied — the server clamps, and reports what it clamped to. */
  limit: number;
  offset: number;
}

export interface EventPage {
  items: JournalEvent[];
  next_seq: number | null;
}

export type ListOrder = "started_at" | "updated_at" | "cost_usd" | "duration_ms";

export interface RunFilters {
  requested_by?: string;
  repo?: string;
  branch?: string;
  step?: string;
  ticket?: string;
  q?: string;
  active?: boolean;
  stale?: boolean;
  order?: ListOrder;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
