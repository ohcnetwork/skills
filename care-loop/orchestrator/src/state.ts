// state.ts — the ONLY writer of state.json, projected from the journal head
// (PLAN-orchestrator-architecture §2 + §5). state.json is a derived view: never hand-written,
// always regenerable from the journal. This module is the single source of truth for the state
// schema + step vocabulary (the old care-loop/write-state.sh has been retired); the doctor / fleet
// tooling read the emitted state.json, whose shape is unchanged.

import { renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { JournalEvent } from "./journal.js";
import { backfillRunId, isValidRunId } from "./run-id.js";
import { getActiveRunStore, rollupsFromEvents } from "./run-store.js";

// Canonical step vocabulary — single-sourced here (this module is the sole state writer).
export const STEP_VOCAB = [
  "1",
  "2",
  "3",
  "3-implementing",
  "4a",
  "4b",
  "4c",
  "4c-validating",
  "5",
  "5-committing",
  "5-pushing",
  "5-await",
  "5-replying",
  "6a",
  "6b",
  "6b-applying",
  "7",
  "merged",
  "aborted",
] as const;
export type Step = (typeof STEP_VOCAB)[number];

/** `satisfies` is the point: renaming a step in STEP_VOCAB stops this compiling rather than silently
 *  leaving a set of strings that match nothing. Single-sourced because the fleet query, the API, and
 *  the frontend all ask "is this run finished?". */
export const TERMINAL_STEPS = [
  "7",
  "merged",
  "aborted",
] as const satisfies readonly Step[];

export function isTerminalStep(step: string): boolean {
  return (TERMINAL_STEPS as readonly string[]).includes(step);
}

export const TIERS = ["trivial", "standard", "complex"] as const;
export type Tier = (typeof TIERS)[number];

// Key order is significant — state.json is always written in exactly this order.
export const KEY_ORDER = [
  "task",
  "repo",
  "branch",
  "worktree",
  "tier",
  "pr",
  "round",
  "step",
  "head_sha",
  "last_reviewed_sha",
  "updated_at",
  "run_id",
  "requested_by",
  "ticket",
  "summary",
  "started_at",
] as const;

export interface CareState {
  task: string;
  repo: string; // full owner/name
  branch: string;
  worktree: string; // absolute
  tier: Tier;
  pr: number | null; // integer PR number, never a URL
  round: number;
  step: Step;
  head_sha: string;
  last_reviewed_sha: string;
  updated_at: string;
  run_id: string; // ULID, minted once at run.start (run-id.ts); stable PK for the run-store projection
  requested_by: string | null; // GitHub login; null for a local CLI run
  ticket: string | null; // ENG-### — promoted here so it projects into the row (was event-only)
  summary: string | null; // PR-title summary — ditto
  started_at: string; // ISO — events[0].ts, set by projectState
}

export class StateValidationError extends Error {}

/** Validate + normalize into the canonical key order (hard validation; rejects ad-hoc keys). */
export function validateState(s: Partial<CareState>): CareState {
  const fail = (m: string): never => {
    throw new StateValidationError(`state: ${m}`);
  };

  if (!s.task) fail("task is required");
  if (!s.repo || !s.repo.includes("/"))
    fail(`repo '${s.repo}' must be full owner/name`);
  if (s.tier !== undefined && !TIERS.includes(s.tier))
    fail(`tier '${s.tier}' not in ${TIERS.join("|")}`);
  if (s.step === undefined || !STEP_VOCAB.includes(s.step))
    fail(`step '${s.step}' not in vocabulary`);
  if (s.pr !== undefined && s.pr !== null && !Number.isInteger(s.pr))
    fail(`pr must be an integer or null, got ${s.pr}`);
  if (s.round !== undefined && !Number.isInteger(s.round))
    fail(`round must be an integer, got ${s.round}`);
  if (
    s.requested_by !== undefined &&
    s.requested_by !== null &&
    typeof s.requested_by !== "string"
  )
    fail(`requested_by must be a string or null, got ${s.requested_by}`);
  if (s.run_id !== undefined && !isValidRunId(s.run_id))
    fail(`run_id '${s.run_id}' is not a valid run id`);

  const branch = s.branch ?? "unknown";
  const startedAt = s.started_at ?? s.updated_at ?? new Date().toISOString();
  // A journal predating run_id folds no `run_id` patch, so this derives the same id every time it
  // is projected — live resume and `reindex` land on it identically, with no special-casing.
  const runId = s.run_id ?? backfillRunId(startedAt, `${s.repo}-${branch}`);

  const full: CareState = {
    task: s.task!,
    repo: s.repo!,
    branch,
    worktree: s.worktree ?? "unknown",
    tier: s.tier ?? "standard",
    pr: s.pr ?? null,
    round: s.round ?? 1,
    step: s.step!,
    head_sha: s.head_sha ?? "unknown",
    last_reviewed_sha: s.last_reviewed_sha ?? "",
    updated_at: s.updated_at ?? new Date().toISOString(),
    run_id: runId,
    requested_by: s.requested_by ?? null,
    ticket: s.ticket ?? null,
    summary: s.summary ?? null,
    started_at: startedAt,
  };
  // Reject ad-hoc keys (schema drift — IMP-3).
  const extra = Object.keys(s).filter(
    (k) => !(KEY_ORDER as readonly string[]).includes(k),
  );
  if (extra.length) fail(`ad-hoc keys not in schema: ${extra.join(",")}`);
  return full;
}

/** A partial-state patch an event may carry under `data.state`. */
type StatePatch = Partial<CareState>;

function patchOf(ev: JournalEvent): StatePatch | undefined {
  const p = ev.data?.state;
  return p && typeof p === "object" ? (p as StatePatch) : undefined;
}

/**
 * Fold the journal into the current state (§5 "snapshot projection of the journal head"). Rules:
 *  - run.start / run.resume seed or refresh the base state from data.state.
 *  - step.enter sets step (+ round when present).
 *  - any event may carry a data.state patch (shallow-merged) — the FSM's escape hatch for
 *    head_sha / pr / last_reviewed_sha updates without a bespoke rule per event type.
 *  - updated_at tracks the last event's ts.
 * Returns a validated CareState (throws if the head projects to an out-of-schema state).
 */
export function projectState(events: JournalEvent[]): CareState {
  if (events.length === 0)
    throw new StateValidationError(
      "cannot project state from an empty journal",
    );
  let acc: StatePatch = { started_at: events[0].ts };
  for (const ev of events) {
    const patch = patchOf(ev);
    if (patch) acc = { ...acc, ...patch };
    if (ev.event === "step.enter") {
      if (ev.step !== undefined) acc.step = ev.step as Step;
      if (ev.round !== undefined) acc.round = ev.round;
    }
    acc.updated_at = ev.ts;
  }
  // Re-asserted AFTER the fold, not merely seeded before it: `run.start` carries a CareState built a
  // moment before `append()` stamps the event's `ts`, so the fold's first patch would otherwise
  // overwrite this with an earlier value. Asserting it here makes the invariant hold unconditionally.
  acc.started_at = events[0].ts;
  return validateState(acc);
}

/** Atomic write of state.json (tmp + rename), canonical key order. The single write path. */
export function writeStateFile(runDir: string, state: CareState): string {
  const path = join(runDir, "state.json");
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) ordered[k] = state[k];
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(ordered, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
  return path;
}

/** Projects the journal head, writes state.json, and mirrors the full rollup recompute into the run
 *  store — the reconciling write correcting any drift `Journal.append`'s incremental path left. Fatal
 *  on failure: a failed reconcile must halt the run rather than let the db silently diverge. */
export function projectAndWrite(
  runDir: string,
  events: JournalEvent[],
): CareState {
  const state = projectState(events);
  writeStateFile(runDir, state);
  getActiveRunStore().upsertRun(basename(runDir), state, rollupsFromEvents(events));
  return state;
}
