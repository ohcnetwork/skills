import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCiFailureLog } from "../src/github.ts";

// A realistic slice of a GitHub Actions job log: ISO-timestamp-prefixed lines, ANSI colour, a lot of
// setup noise, then the actual Playwright failure. extractCiFailureLog must surface the failure and
// drop the noise.
const SAMPLE = [
  "2026-07-17T08:39:01.1234567Z ##[group]Run npx playwright test",
  "2026-07-17T08:39:02.0000000Z \x1b[36mnpm install noise line\x1b[0m",
  "2026-07-17T08:39:03.0000000Z Downloading browsers...",
  "2026-07-17T08:39:40.0000000Z   1) [chromium] › tests/facility/patient/patientRegistration.spec.ts:352:5 › registers a patient",
  "2026-07-17T08:39:40.1000000Z     Error: expect(locator).toHaveText(expected)",
  '2026-07-17T08:39:40.2000000Z     Expected string: "25 Y"',
  '2026-07-17T08:39:40.3000000Z     Received string: "25y"',
  "2026-07-17T08:39:41.0000000Z   1 failed",
  "2026-07-17T08:39:41.5000000Z ##[error]Process completed with exit code 1.",
].join("\n");

test("extractCiFailureLog: surfaces the failing spec + assertion, drops setup noise", () => {
  const out = extractCiFailureLog(SAMPLE) ?? "";
  assert.match(out, /patientRegistration\.spec\.ts:352/);
  assert.match(out, /toHaveText/);
  assert.match(out, /Expected string: "25 Y"/);
  assert.match(out, /Received string: "25y"/);
  // noise dropped
  assert.doesNotMatch(out, /Downloading browsers/);
  assert.doesNotMatch(out, /npm install noise/);
  // timestamps stripped
  assert.doesNotMatch(out, /2026-07-17T08/);
});

test("extractCiFailureLog: no signal → returns a bounded tail, not undefined", () => {
  const noise = Array.from(
    { length: 60 },
    (_, i) => `2026-07-17T08:00:0${i % 10}.0Z setup step ${i}`,
  ).join("\n");
  const out = extractCiFailureLog(noise);
  assert.ok(out && out.length > 0, "should fall back to the log tail");
  assert.doesNotMatch(out!, /2026-07-17T08/, "timestamps still stripped");
});

test("extractCiFailureLog: empty input → undefined", () => {
  assert.equal(extractCiFailureLog(""), undefined);
});
