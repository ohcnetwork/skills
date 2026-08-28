import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPlaywrightFailure,
  formatCiFailures,
} from "../src/skills-opencode.ts";
import type { CiFailure } from "../src/skill-result.ts";

// A mocked CI failure whose ONLY Playwright signal lives in the extracted job log — the check name is
// the generic "Test / cypress" shard label and there are no annotations. This is the realistic CARE
// case: annotations are runner noise ("shard N failed"), the real assertion is in the job log.
const logOnlyFailure: CiFailure = {
  name: "Test (1/4)",
  summary: "Process completed with exit code 1.",
  log: [
    "1) [chromium] › tests/facility/patient/patientRegistration.spec.ts:352:5 › registers a patient",
    "   Error: expect(locator).toHaveText(expected)",
    '   Expected string: "25 Y"',
    '   Received string: "25y"',
  ].join("\n"),
};

test("isPlaywrightFailure: detects a Playwright failure from the extracted log alone (no name/annotation signal)", () => {
  assert.equal(isPlaywrightFailure([logOnlyFailure]), true);
});

test("isPlaywrightFailure: still matches on the check name", () => {
  assert.equal(
    isPlaywrightFailure([{ name: "Playwright E2E" }]),
    true,
  );
});

test("isPlaywrightFailure: still matches on an annotation spec path", () => {
  assert.equal(
    isPlaywrightFailure([
      {
        name: "Test",
        annotations: [
          { path: "tests/patient.spec.ts", line: 1, message: "boom" },
        ],
      },
    ]),
    true,
  );
});

test("isPlaywrightFailure: a plain tsc/lint failure is NOT Playwright (no mechanics injection)", () => {
  assert.equal(
    isPlaywrightFailure([
      { name: "Typecheck", log: "src/foo.ts(12,5): error TS2322: ..." },
    ]),
    false,
  );
});

test("formatCiFailures: renders the extracted job-log detail into a fenced block for the fixer", () => {
  const out = formatCiFailures([logOnlyFailure]);
  assert.match(out, /### Test \(1\/4\)/);
  assert.match(out, /Failure log \(extracted from the job log\):/);
  assert.match(out, /patientRegistration\.spec\.ts:352/);
  assert.match(out, /Received string: "25y"/);
  // rendered inside a code fence
  assert.match(out, /```[\s\S]*toHaveText[\s\S]*```/);
});

test("formatCiFailures: renders annotations when present, and both together", () => {
  const out = formatCiFailures([
    {
      name: "Test",
      annotations: [
        { path: "tests/a.spec.ts", line: 42, message: "timed out" },
      ],
      log: "Received string: nope",
    },
  ]);
  assert.match(out, /tests\/a\.spec\.ts:42 — timed out/);
  assert.match(out, /Received string: nope/);
});

test("formatCiFailures: empty list → a clear placeholder (not a crash)", () => {
  assert.equal(
    formatCiFailures([]),
    "(no CI failure details available)",
  );
});
