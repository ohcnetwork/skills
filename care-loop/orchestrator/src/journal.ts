// journal.ts — §10 cutover (PLAN-sqlite-run-store.md): the DATABASE is now the source of truth.
// `read()` queries the active `RunStore`; `append()` derives `seq`/`prev`/`deltaMs` from it too, and
// writes the DB BEFORE the jsonl line (a crash between the two leaves the DB correct and the replica
// merely lagging — never the reverse). `journal.jsonl` remains a continuously-verified REPLICA:
// still fsync'd and hash-chained via `readReplica()`/`truncateTornTail()`, still what `reindex` and
// the doctor read, still what the run.end parity check (parity.ts) diffs against the DB — but
// nothing on the live control-flow path (`resume`, `projectState`, the drivers) depends on it any
// more. Both writes are fatal: a failure at either step propagates and halts the run.
//
// `readReplica()` retains the original crash-only recovery semantics (PLAN-orchestrator-architecture
// §5, Bernstein): a torn FINAL line (unparseable) is dropped; a break in the MIDDLE (parse error or
// hash mismatch on a non-final line) is corruption and throws — tamper/truncation *detection*, no
// HMAC/signing. `read()` has no such concept (DB transactions are atomic); `truncatedTail` is always
// false there, kept only for API-shape compatibility.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { getActiveRunStore } from "./run-store.js";
import { validateState, type CareState } from "./state.js";
import { assertParity, checkParity, parityWarning, type ParityPhase } from "./parity.js";

export type EventType =
  | "run.start"
  | "run.resume"
  | "run.end"
  | "step.enter"
  | "step.exit"
  | "gate.asked"
  | "gate.answered"
  | "plan.approved"
  | "spawn.start"
  | "spawn.result"
  | "spawn.invalid"
  | "spawn.retry"
  | "spawn.escalate"
  | "skill.invoke"
  | "skill.result"
  | "helper.exec"
  | "decision"
  | "push"
  | "ci.wait"
  | "ci.done"
  | "budget.tick"
  | "budget.stop"
  | "checkpoint.written"
  | "doctor.skip"
  | "doctor.start"
  | "doctor.apply"
  | "doctor.coherence"
  | "doctor.verify"
  | "doctor.pr"
  | "doctor.report"
  | "doctor.error";

export interface JournalEvent {
  seq: number;
  ts: string; // ISO-8601 UTC
  run_id: string;
  event: EventType;
  step?: string;
  round?: number;
  data?: Record<string, unknown>;
  cost_cum?: { usd_est: number };
  prev: string; // "sha256:<hex>" of the previous raw line, or GENESIS for the first entry
}

/** Fields the caller supplies; seq/ts/prev are filled by the journal, run_id defaults to runId. */
export type NewEvent = Omit<JournalEvent, "seq" | "prev" | "ts" | "run_id"> & {
  ts?: string;
  run_id?: string;
};

export const GENESIS = "sha256:genesis";

const sha256 = (s: string): string =>
  "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

/** Canonical serialization: fixed key order, optional keys omitted when absent. */
export function serializeEvent(e: JournalEvent): string {
  const o: Record<string, unknown> = {
    seq: e.seq,
    ts: e.ts,
    run_id: e.run_id,
    event: e.event,
  };
  if (e.step !== undefined) o.step = e.step;
  if (e.round !== undefined) o.round = e.round;
  if (e.data !== undefined) o.data = e.data;
  if (e.cost_cum !== undefined) o.cost_cum = e.cost_cum;
  o.prev = e.prev;
  return JSON.stringify(o);
}

export class JournalCorruptionError extends Error {}

export interface ReadResult {
  events: JournalEvent[];
  /** true when a torn final line was dropped (crash-mid-append recovery). */
  truncatedTail: boolean;
}

export class Journal {
  constructor(
    readonly path: string,
    readonly runId: string,
  ) {}

  /** Raw non-empty lines exactly as stored (no trailing newline). */
  private rawLines(): string[] {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    if (text.length === 0) return [];
    const lines = text.split("\n");
    // a trailing "\n" produces a final "" element — that is a cleanly-terminated file, not a tear
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  /**
   * The authoritative read (§10 item 3): queries the active `RunStore` for this run's events,
   * ordered by seq. No "torn tail" concept applies — DB transactions are atomic — so
   * `truncatedTail` is always false, kept only for API-shape compatibility with `readReplica()`.
   */
  read(): ReadResult {
    return { events: getActiveRunStore().getEvents(this.runId), truncatedTail: false };
  }

  /**
   * Read + verify the jsonl REPLICA's own hash chain directly off disk, bypassing the DB entirely.
   * Drops a torn final line; throws on mid-chain corruption. Used by `reindex` (rebuilding the DB
   * FROM the replica) and the run.end parity check (diffing the replica against the DB) — NOT a
   * live control-flow path any more.
   */
  readReplica(): ReadResult {
    const raw = this.rawLines();
    if (raw.length === 0) return { events: [], truncatedTail: false };

    const events: JournalEvent[] = [];
    let truncatedTail = false;
    let prevHash = GENESIS;

    for (let i = 0; i < raw.length; i++) {
      const isLast = i === raw.length - 1;
      let ev: JournalEvent;
      try {
        ev = JSON.parse(raw[i]) as JournalEvent;
      } catch (err) {
        if (isLast) {
          truncatedTail = true; // crash-mid-append: drop the torn final line
          break;
        }
        throw new JournalCorruptionError(
          `journal ${this.path}: unparseable line ${i} (mid-chain)`,
        );
      }

      if (ev.prev !== prevHash) {
        throw new JournalCorruptionError(
          `journal ${this.path}: hash-chain break at seq ${ev.seq} (line ${i}): prev=${ev.prev} expected=${prevHash}`,
        );
      }
      if (ev.seq !== i) {
        throw new JournalCorruptionError(
          `journal ${this.path}: seq gap at line ${i}: got ${ev.seq}`,
        );
      }
      events.push(ev);
      prevHash = sha256(raw[i]);
    }

    return { events, truncatedTail };
  }

  /** The last intact event, or null on an empty/only-torn journal. */
  head(): JournalEvent | null {
    const { events } = this.read();
    return events.length ? events[events.length - 1] : null;
  }

  /**
   * Return the intact raw lines, atomically truncating a torn FINAL line off disk if present
   * (the durable form of §6 crash-only recovery — a half-written final line is never-committed
   * data). Only the last line can be torn in practice, so we check just that.
   */
  private truncateTornTail(): string[] {
    const raw = this.rawLines();
    if (raw.length === 0) return raw;
    try {
      JSON.parse(raw[raw.length - 1]);
      return raw; // clean tail
    } catch {
      const intact = raw.slice(0, -1);
      const tmp = this.path + ".tmp";
      writeFileSync(tmp, intact.length ? intact.join("\n") + "\n" : "");
      renameSync(tmp, this.path);
      return intact;
    }
  }

  /**
   * Append one event. §10 (cutover): `seq`/`prev`/`deltaMs` are derived from the ACTIVE STORE's last
   * event for this run — the source of truth — not from the jsonl tail. The DB write happens BEFORE
   * the jsonl line, so a crash between the two leaves the DB correct and the replica merely lagging,
   * never the reverse. Both writes are fatal: a failure at either step propagates and halts the run.
   * Not concurrency-safe by itself — the orchestrator holds the per-run lockfile (§1) so there is
   * exactly one writer.
   */
  append(ev: NewEvent): JournalEvent {
    const store = getActiveRunStore();
    const runId = ev.run_id ?? this.runId;

    // Repair a prior crash's torn tail BEFORE anything reads it, so `prev` below is computed against
    // a well-formed file. (This used to sit just above the jsonl write; it moved up when `prev`
    // started depending on it.)
    const raw = this.truncateTornTail();

    const last = store.getLastEvent(runId);
    const nextSeq = last ? last.seq + 1 : 0;
    // `prev` comes from the REPLICA, not the DB — it is the file's own integrity checksum, a property
    // of the bytes on disk rather than an ordering fact. §10 item 2 originally sourced it from the DB
    // alongside `seq` and `deltaMs`; that was wrong, and it broke every REINDEXED LEGACY run: those
    // events carry a pre-ULID `run_id` in the file, `reindex` backfills a ULID into the DB, and so
    // `serializeEvent(dbEvent)` reproduces a line the file never contained. The chain broke on the
    // first append to any migrated run. `seq` and `deltaMs` stay DB-owned; those ARE ordering facts.
    const prevHash = raw.length > 0 ? sha256(raw[raw.length - 1]) : GENESIS;
    const ts = ev.ts ?? new Date().toISOString();
    const deltaMs =
      last && ev.event !== "run.resume"
        ? new Date(ts).getTime() - new Date(last.ts).getTime()
        : 0;

    const full: JournalEvent = {
      seq: nextSeq,
      ts,
      run_id: runId,
      event: ev.event,
      ...(ev.step !== undefined ? { step: ev.step } : {}),
      ...(ev.round !== undefined ? { round: ev.round } : {}),
      ...(ev.data !== undefined ? { data: ev.data } : {}),
      ...(ev.cost_cum !== undefined ? { cost_cum: ev.cost_cum } : {}),
      prev: prevHash,
    };

    // DB FIRST — fatal, and authoritative for ordering (§10 items 1–2).
    if (full.event === "run.start" && full.data?.state) {
      // Seed the `runs` row BEFORE the event row below, so the run_events FK never dangles on
      // this very first event (§4 "appendEvent must seed the parent row").
      const seeded = validateState(full.data.state as Partial<CareState>);
      store.seedRun(basename(dirname(this.path)), seeded);
    }
    const costUsd =
      full.event === "skill.result"
        ? ((full.data?.cost_usd as number | undefined) ?? 0)
        : 0;
    store.appendEvent(full.run_id, full, { deltaMs, costUsd });

    // Replica SECOND — also fatal (§2: "both writes are fatal"). Its torn tail was already repaired
    // at the top of this method, which is also where `prev` was taken from.
    const line = serializeEvent(full) + "\n";
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd); // §5: durability after every append
    } finally {
      closeSync(fd);
    }

    // §9/§10 items 6-7: the standing parity check, at the two points it can tell us something.
    // run.resume is the one that matters — it is the moment the DB is trusted to RECONSTRUCT a run,
    // and the only trigger that covers crash paths (a run killed mid-step never reaches run.end).
    // See parity.ts's header for why the two phases differ.
    if (full.event === "run.end" || full.event === "run.resume") {
      const phase: ParityPhase = full.event;
      let replicaEvents: JournalEvent[] | null = null;
      try {
        replicaEvents = this.readReplica().events;
      } catch (err) {
        // A missing or corrupt replica is a degraded BACKUP, not a corrupt truth: the DB is
        // authoritative (§2). Refusing to finish or resume a run because its backup is unreadable
        // would be worse than the fault it reports. Warn at both phases; never fatal.
        console.error(
          parityWarning(
            phase,
            `replica unreadable (${err instanceof Error ? err.message : String(err)})`,
          ),
        );
      }
      if (replicaEvents) {
        const dbEvents = store.getEvents(full.run_id);
        if (phase === "run.resume") {
          assertParity(replicaEvents, dbEvents, phase); // throws — reconstruction would be wrong
        } else {
          // run.end: both writes are already committed and the run's work is done. A detector, not
          // a guard — it cannot undo the divergence, so record it and let the run finish.
          const result = checkParity(replicaEvents, dbEvents);
          if (!result.ok) {
            const reason = result.reason ?? "unknown";
            console.error(parityWarning(phase, reason));
            store.recordParityError(full.run_id, reason);
          }
        }
      }
    }

    return full;
  }
}
