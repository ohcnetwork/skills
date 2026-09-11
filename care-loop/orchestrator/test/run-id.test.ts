import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mintRunId,
  backfillRunId,
  isValidRunId,
  RUN_ID_LENGTH,
} from "../src/run-id.ts";

test("mintRunId produces a 26-char Crockford-base32 id", () => {
  const id = mintRunId();
  assert.equal(id.length, RUN_ID_LENGTH);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(isValidRunId(id), true);
});

test("mintRunId is time-sortable across distinct timestamps (monotonicity)", () => {
  const t0 = Date.parse("2026-08-19T00:00:00.000Z");
  const t1 = t0 + 1000;
  const ids0 = Array.from({ length: 20 }, () => mintRunId(t0));
  const ids1 = Array.from({ length: 20 }, () => mintRunId(t1));
  // every id minted at the later timestamp sorts after every id minted at the earlier one
  const maxAt0 = ids0.sort().at(-1)!;
  const minAt1 = ids1.sort()[0];
  assert.ok(
    maxAt0 < minAt1,
    `expected all t0 ids < all t1 ids, got max(t0)=${maxAt0} min(t1)=${minAt1}`,
  );
});

test("mintRunId is unique across calls at the same timestamp", () => {
  const t = Date.now();
  const ids = new Set(Array.from({ length: 200 }, () => mintRunId(t)));
  assert.equal(ids.size, 200);
});

test("backfillRunId is deterministic and idempotent", () => {
  const a = backfillRunId("2026-07-01T12:00:00.000Z", "ohcnetwork/care_fe-eng-613");
  const b = backfillRunId("2026-07-01T12:00:00.000Z", "ohcnetwork/care_fe-eng-613");
  assert.equal(a, b);
  assert.equal(isValidRunId(a), true);
});

test("backfillRunId differs across distinct seeds or timestamps", () => {
  const base = backfillRunId("2026-07-01T12:00:00.000Z", "ohcnetwork/care_fe-eng-613");
  const otherSeed = backfillRunId("2026-07-01T12:00:00.000Z", "ohcnetwork/care_fe-eng-614");
  const otherTime = backfillRunId("2026-07-02T12:00:00.000Z", "ohcnetwork/care_fe-eng-613");
  assert.notEqual(base, otherSeed);
  assert.notEqual(base, otherTime);
});

test("isValidRunId rejects malformed ids", () => {
  assert.equal(isValidRunId("not-a-ulid"), false);
  assert.equal(isValidRunId(""), false);
  assert.equal(isValidRunId("0".repeat(26)), true); // all-zero is still shape-valid
  assert.equal(isValidRunId("I".repeat(26)), false); // I/L/O/U excluded from Crockford
});
