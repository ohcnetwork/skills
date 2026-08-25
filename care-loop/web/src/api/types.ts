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
  /** Sent by the server rather than derived here — the step vocabulary is the orchestrator's. */
  terminal: boolean;
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
  /** Client-side only: show just the runs with an open gate. The API has no such filter — gates live
   *  in their own table and the needs-you list is one small request. */
  gate?: boolean;
}

// ── Queue + gate ([[PLAN-loop-service]] §4, §7) ───────────────────────────────────────────────────

export type QueueStatus =
  | "pending"
  | "running"
  /** Suspended at a gate: live, but waiting on a PERSON rather than on capacity. Distinct from
   *  `pending` because the two need different UI — one has a queue position, the other has a
   *  question. */
  | "awaiting_gate"
  | "done"
  | "failed"
  | "cancelled";

export interface QueueRow {
  id: number;
  runId: string;
  status: QueueStatus;
  requestedBy: string;
  repo: string;
  branch: string;
  task: string;
  ticket: string;
  summary: string;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  error: string | null;
}

export interface EnqueueResult {
  run_id: string;
  queue_id: number;
  /** Another live run owns this (repo, branch); this one waits for THAT run specifically. */
  blocked_by_branch: string | null;
  /** Pending rows ahead in line — the common reason a run does not start, with a cap of 2. */
  queue_position: number;
}

export interface PlanQuestion {
  id: string;
  prompt: string;
}

export interface ConsolidatedAsk {
  plannedBy: string;
  summary: string;
  criteria: string[];
  classification: string;
  testPlan: string;
  pushAuthNote: string;
}

export interface GateAsk {
  run_id: string;
  ask_id: string;
  kind: "interview" | "approve";
  payload: ConsolidatedAsk | PlanQuestion[];
  asked_at: string;
  expires_at: string;
}

export type GateAnswer =
  | { decision: "approve" }
  | { decision: "reject" }
  | { decision: "amend"; amendment: string }
  | { answers: { id: string; answer: string }[] };

export interface NewRunRequest {
  repo?: string;
  branch: string;
  task: string;
  ticket: string;
  summary: string;
}
