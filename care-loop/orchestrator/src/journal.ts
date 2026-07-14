// journal.ts — the single source of truth (PLAN-orchestrator-architecture §5).
//
// Append-only, one JSON object per line, fsync after every append, hash-chained: each entry's
// `prev` is the sha256 of the PREVIOUS raw line as written to disk. Hashing the raw bytes (not a
// re-serialization) makes verification independent of any stringify ambiguity.
//
// Crash-only property (Bernstein): the process may die mid-append. On read, a torn FINAL line
// (unparseable) is truncated off and the head degrades to the previous intact entry. A break in
// the MIDDLE (parse error or hash mismatch on a non-final line) is corruption and throws — that is
// tamper/truncation *detection*, no HMAC/signing.

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";

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
  | "checkpoint.written";

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

const sha256 = (s: string): string => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

/** Canonical serialization: fixed key order, optional keys omitted when absent. */
export function serializeEvent(e: JournalEvent): string {
  const o: Record<string, unknown> = { seq: e.seq, ts: e.ts, run_id: e.run_id, event: e.event };
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
   * Read + verify the chain. Drops a torn final line; throws on mid-chain corruption.
   * This is the crash-only recovery path — startup reads the head from here.
   */
  read(): ReadResult {
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
        throw new JournalCorruptionError(`journal ${this.path}: unparseable line ${i} (mid-chain)`);
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
   * Append one event: fills seq/ts/prev from the current head, serializes, writes + fsync.
   * Returns the fully-formed entry. Not concurrency-safe by itself — the orchestrator holds the
   * per-run lockfile (§1) so there is exactly one writer. A torn final line from a prior crash is
   * recovered (truncated) before the append, so the chain stays contiguous.
   */
  append(ev: NewEvent): JournalEvent {
    const raw = this.truncateTornTail();
    let prevHash = GENESIS;
    let nextSeq = 0;
    if (raw.length > 0) {
      const lastRaw = raw[raw.length - 1];
      const lastEv = JSON.parse(lastRaw) as JournalEvent; // guaranteed parseable after recovery
      prevHash = sha256(lastRaw);
      nextSeq = lastEv.seq + 1;
    }

    const full: JournalEvent = {
      seq: nextSeq,
      ts: ev.ts ?? new Date().toISOString(),
      run_id: ev.run_id ?? this.runId,
      event: ev.event,
      ...(ev.step !== undefined ? { step: ev.step } : {}),
      ...(ev.round !== undefined ? { round: ev.round } : {}),
      ...(ev.data !== undefined ? { data: ev.data } : {}),
      ...(ev.cost_cum !== undefined ? { cost_cum: ev.cost_cum } : {}),
      prev: prevHash,
    };

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
