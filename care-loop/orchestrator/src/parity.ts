// parity.ts — the standing parity check between the jsonl replica and the DB (PLAN-sqlite-run-store.md
// §9/§10 items 6-7). Folds the replica through `projectState`, diffs it against the DB-derived state
// for the same run, and confirms the event counts match. This is what makes the journal a VERIFIED
// replica rather than an unchecked backup, and it is the objective gate for widening §10 further
// (flip once N consecutive runs are parity-clean).
//
// Two trigger points, two policies (§10 item 7):
//   run.resume — the DB is about to be trusted to RECONSTRUCT a run. A divergence here means the
//                reconstruction would be wrong, so it THROWS. This is the check that matters: it is
//                the only one covering crash paths, which never reach run.end at all.
//   run.end    — both writes have already committed, the PR is open, CI has run. The check cannot
//                undo what it finds, so it RECORDS (runs.parity_error) and warns. Throwing here
//                would fail a run whose work is complete — destroying the thing it was watching.
// A replica that is unreadable/missing is a degraded BACKUP, not a corrupt truth: the DB is
// authoritative (§2), so that warns at both phases and never throws.

import { projectState, type CareState } from "./state.js";
import type { JournalEvent } from "./journal.js";

export class ParityError extends Error {}

/** The two points `Journal.append` runs the check. Policy differs per phase — see the header. */
export type ParityPhase = "run.end" | "run.resume";

/** One place for the operator-facing wording, so both phases read the same in a log scrape. */
export function parityWarning(phase: ParityPhase, reason: string): string {
  return `care-loopd: PARITY (${phase}) — journal replica and DB disagree: ${reason}`;
}

export interface ParityResult {
  ok: boolean;
  reason?: string;
}

/** Compare the replica's folded state against the DB's folded state, field-for-field, plus the raw
 *  event counts. Pure — no I/O — so it's unit-testable without a real journal/store. */
export function checkParity(
  replicaEvents: JournalEvent[],
  dbEvents: JournalEvent[],
): ParityResult {
  if (replicaEvents.length !== dbEvents.length) {
    return {
      ok: false,
      reason: `event count mismatch: replica=${replicaEvents.length} db=${dbEvents.length}`,
    };
  }
  if (replicaEvents.length === 0) return { ok: true }; // nothing to fold — vacuously parity-clean

  let replicaState: CareState;
  let dbState: CareState;
  try {
    replicaState = projectState(replicaEvents);
    dbState = projectState(dbEvents);
  } catch (err) {
    return {
      ok: false,
      reason: `projection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const a = JSON.stringify(replicaState);
  const b = JSON.stringify(dbState);
  if (a !== b) {
    return { ok: false, reason: `projected state mismatch: replica=${a} db=${b}` };
  }
  return { ok: true };
}

/** Run the check and throw `ParityError` on a divergence — the run.resume policy. Kept separate from
 *  `checkParity` so the run.end path, and callers that want the result without throwing (a dashboard
 *  health endpoint, say), can still use the pure function. */
export function assertParity(
  replicaEvents: JournalEvent[],
  dbEvents: JournalEvent[],
  phase: ParityPhase = "run.resume",
): void {
  const result = checkParity(replicaEvents, dbEvents);
  if (!result.ok) {
    throw new ParityError(`${phase} parity check failed: ${result.reason}`);
  }
}
