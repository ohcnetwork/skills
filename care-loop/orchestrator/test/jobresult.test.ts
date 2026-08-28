import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJobResult } from "../src/jobresult.ts";

function validReviewerResult(): Record<string, unknown> {
  return {
    schema: "care-loop/jobresult@1",
    role: "care-reviewer",
    run_id: "review",
    round: 1,
    terminal_state: "done",
    verdict: "findings",
    reason_code: "minor_polish",
    findings: [
      {
        class: "legibility",
        file: "src/foo.tsx",
        line_hint: "~287",
        note: "prefer a const over an inline IIFE",
      },
    ],
    model_used: "github-copilot/claude-opus-4.8",
  };
}

test("a well-formed reviewer JobResult validates", () => {
  const data = validReviewerResult();
  assert.equal(validateJobResult(data), true);
});

test("a stray extra top-level field is STRIPPED, not rejected (opencode structured-output drift)", () => {
  // The live crash: Copilot's claude-opus emitted a valid `findings` result plus `questions: ""`.
  const data = { questions: "", ...validReviewerResult() } as Record<
    string,
    unknown
  >;
  assert.equal(
    validateJobResult(data),
    true,
    "stray field must not fail validation",
  );
  assert.ok(
    !("questions" in data),
    "the unknown field must be removed from the data",
  );
});

test("a missing REQUIRED field still fails (stripping does not weaken required checks)", () => {
  const data = validReviewerResult();
  delete (data as Record<string, unknown>).verdict;
  assert.equal(validateJobResult(data), false);
});

test("a bad verdict enum still fails", () => {
  const data = { ...validReviewerResult(), verdict: "questions" };
  assert.equal(validateJobResult(data), false);
});

test("an unknown key inside a finding is stripped, not rejected", () => {
  const data = validReviewerResult();
  (data.findings as Record<string, unknown>[])[0].severity = "low";
  assert.equal(validateJobResult(data), true);
  assert.ok(!("severity" in (data.findings as Record<string, unknown>[])[0]));
});
