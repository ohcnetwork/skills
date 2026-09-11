// ULID-style run ids: a 48-bit ms timestamp then 80 bits of randomness, Crockford base32.
//
// Hand-rolled because Node ships no ULID and the orchestrator is deliberately dependency-light.
// Runs journaled before run ids existed get a deterministic id from the same recipe, so `reindex`
// and a live re-projection of the same legacy journal always agree on it.

import { createHash, randomInt } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: 32 symbols, 5 bits each
const TIME_CHARS = 10; // 50 bits, covering the 48-bit ms timestamp
const RANDOM_CHARS = 16; // 80 bits
export const RUN_ID_LENGTH = TIME_CHARS + RANDOM_CHARS;

const RUN_ID_RE = new RegExp(`^[0-9A-HJKMNP-TV-Z]{${RUN_ID_LENGTH}}$`);

function encodeTime(ms: number): string {
  let remaining = Math.max(0, Math.floor(ms));
  let encoded = "";
  for (let i = 0; i < TIME_CHARS; i++) {
    encoded = ENCODING[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandom(nextSymbolIndex: (position: number) => number): string {
  let encoded = "";
  for (let i = 0; i < RANDOM_CHARS; i++) encoded += ENCODING[nextSymbolIndex(i)];
  return encoded;
}

export function mintRunId(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom(() => randomInt(32));
}

/** Same inputs always yield the same id, so backfilling twice cannot mint two ids for one run.
 *  `seed` is conventionally the `${repo}-${branch}` slug. */
export function backfillRunId(startedAtIso: string, seed: string): string {
  const ms = Date.parse(startedAtIso);
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return encodeTime(Number.isFinite(ms) ? ms : 0) + encodeRandom((i) => digest[i] % 32);
}

export function isValidRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}
