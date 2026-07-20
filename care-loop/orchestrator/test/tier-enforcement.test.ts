import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRightTier,
  WrongTierError,
} from "../src/skills-opencode.ts";

// BS-1 (HARNESS-COVERAGE.md): the judgment-tier pin for reviewer/triager/test-grader/ux-validator.
// The subtle contract is the `satisfied === false` semantics — a throw ONLY on an explicit mismatch,
// never on `undefined` (unverifiable: a local models.json engine, or a test fake). Mirrors the
// planner gate ([plan.ts:90]) so the two enforcement points can't diverge.

test("throws WrongTierError when opencode reports an explicit mismatch (false)", () => {
  assert.throws(
    () => assertRightTier("care-reviewer", "claude-opus-4.8", "claude-sonnet-4.6", false),
    (e: unknown) => {
      assert.ok(e instanceof WrongTierError);
      assert.equal(e.role, "care-reviewer");
      assert.equal(e.pinned, "claude-opus-4.8");
      assert.equal(e.reported, "claude-sonnet-4.6");
      // the reported engine is named so the run's failure line is actionable
      assert.match(e.message, /claude-sonnet-4\.6/);
      assert.match(e.message, /claude-opus-4\.8/);
      return true;
    },
  );
});

test("does NOT throw when the pin is verified satisfied (true)", () => {
  assert.doesNotThrow(() =>
    assertRightTier("care-triager", "claude-opus-4.8", "claude-opus-4.8", true),
  );
});

test("does NOT throw when the engine is unverifiable (undefined) — local models / test fakes pass", () => {
  assert.doesNotThrow(() =>
    assertRightTier("care-test-grader", "claude-opus-4.8", undefined, undefined),
  );
});
