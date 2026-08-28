// The database is the source of truth: `read()` queries the active `RunStore`, and `append()` writes
// the db BEFORE the jsonl line, so a crash between the two leaves the db correct and the log merely
// lagging. Both writes are fatal.
//
// `journal.jsonl` is the human- and doctor-readable log — still fsync'd and hash-chained, still what
// `reindex` rebuilds from — but nothing on the live control-flow path depends on it. It is
// deliberately not diffed against the db: that guarded a single-writer local SQLite file and bought
// nothing `VACUUM INTO` backups do not.
//
// `readReplica()` keeps the crash-only recovery semantics: a torn FINAL line is dropped, while a
// break MID-chain is corruption and throws. `read()` has no such concept, DB transactions being
// atomic, so its `truncatedTail` is always false.

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

export type EventType =
  | "run.start"
  | "run.resume"
  | "run.end"
  | "step.enter"
  | "step.exit"
  | "gate.asked"
  | "gate.answered"
  // A pause, not a terminus: the process exited at an unanswered gate to free its slot. No
  // `run.end` follows, and the next event is written by the run resuming.
  | "gate.suspended"
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

  /** The authoritative read. `truncatedTail` is always false — see the header. */
  read(): ReadResult {
    return { events: getActiveRunStore().getEvents(this.runId), truncatedTail: false };
  }

  /** Reads and verifies the log's own hash chain off disk, bypassing the db. Used by `reindex` and
   *  by `run-context`'s pre-`run_id` peek — never on a live control-flow path. */
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

  /** Truncates a torn final line off disk: a half-written last line is never-committed data. Only
   *  the last line can be torn in practice. */
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

  /** Not concurrency-safe by itself: the orchestrator holds the per-run lockfile, so there is
   *  exactly one writer. */
  append(ev: NewEvent): JournalEvent {
    const store = getActiveRunStore();
    const runId = ev.run_id ?? this.runId;

    // Must precede the `prev` below, which has to hash a well-formed file.
    const raw = this.truncateTornTail();

    const last = store.getLastEvent(runId);
    const nextSeq = last ? last.seq + 1 : 0;
    // `prev` comes from the FILE, not the db: it checksums the bytes on disk rather than stating an
    // ordering fact. Sourcing it from the db broke every reindexed legacy run — those events carry a
    // pre-ULID `run_id` in the file while reindex backfills a ULID into the db, so re-serializing the
    // db row reproduces a line the file never contained, and the chain broke on the first append.
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

    // DB first: fatal, and authoritative for ordering.
    if (full.event === "run.start" && full.data?.state) {
      // Before the event row below, so the run_events FK never dangles on this first event.
      const seeded = validateState(full.data.state as Partial<CareState>);
      store.seedRun(basename(dirname(this.path)), seeded);
    }
    const costUsd =
      full.event === "skill.result"
        ? ((full.data?.cost_usd as number | undefined) ?? 0)
        : 0;
    store.appendEvent(full.run_id, full, { deltaMs, costUsd });

    // Log second, also fatal. Its torn tail was repaired at the top of this method.
    const line = serializeEvent(full) + "\n";
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd); // §5: durability after every append
    } finally {
      closeSync(fd);
    }

    return full;
  }
}
