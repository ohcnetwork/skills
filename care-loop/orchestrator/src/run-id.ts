// run-id.ts — a stable, unique, time-sortable run identifier (PLAN-sqlite-run-store.md §5).
//
// The pre-existing "run_id" threaded through JournalEvent was really `${repo}-${branch}` — a good
// human label (kept for directory naming, see run-context.ts) but a bad primary key: reusing a
// branch, or re-running months later, collides two distinct runs on the same id. This module mints
// a real ULID (48-bit ms timestamp + 80 bits of randomness, Crockford base32, lexicographically
// time-sortable) once per run, and derives a DETERMINISTIC fallback for journals that predate this
// feature — the same recipe backfills old runs during `reindex` (§8) and self-heals a live
// projection of one (§5), so there is exactly one backfill rule, not two.
//
// No dependency: Node has no built-in ULID and the orchestrator is deliberately dependency-light.

import { createHash, randomInt } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32 (32 symbols, 5 bits/char)
const TIME_LEN = 10; // 10 chars * 5 bits = 50 bits ⊇ 48-bit ms timestamp
const RAND_LEN = 16; // 16 chars * 5 bits = 80 bits of randomness
export const RUN_ID_LENGTH = TIME_LEN + RAND_LEN; // 26

function encodeTime(ms: number): string {
  let n = Math.max(0, Math.floor(ms));
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** Mint a fresh ULID-style run id. Lexicographic order matches minting order at millisecond
 *  resolution or coarser (no sub-ms monotonic counter — two mints in the same ms may tie or invert
 *  by chance in their random suffix; that is acceptable here, it is a primary key, not a sort key). */
export function mintRunId(now: number = Date.now()): string {
  let rand = "";
  for (let i = 0; i < RAND_LEN; i++) rand += ENCODING[randomInt(32)];
  return encodeTime(now) + rand;
}

/**
 * Deterministic backfill for a run journaled before run_id existed: `ULID(started_at, hash(seed))`.
 * Same inputs always produce the same id, so backfilling is idempotent (re-running `reindex`, or
 * re-projecting the same legacy journal from two different processes, never mints two different
 * ids for the same run). `seed` is conventionally the `${repo}-${branch}` slug.
 */
export function backfillRunId(startedAtIso: string, seed: string): string {
  const ms = Date.parse(startedAtIso);
  const time = encodeTime(Number.isFinite(ms) ? ms : 0);
  const hash = createHash("sha256").update(seed, "utf8").digest();
  let rand = "";
  for (let i = 0; i < RAND_LEN; i++) rand += ENCODING[hash[i] % 32];
  return time + rand;
}

const RUN_ID_RE = new RegExp(`^[0-9A-HJKMNP-TV-Z]{${RUN_ID_LENGTH}}$`);

/** True iff `id` has the shape of a run id minted/backfilled by this module. */
export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}
