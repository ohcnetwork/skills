import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSeed } from "../src/front-terminal.ts";

test("ticket accepts ENG-### and upper-cases a lowercase prefix", () => {
  assert.deepEqual(validateSeed("ticket", "ENG-613"), { value: "ENG-613" });
  assert.deepEqual(validateSeed("ticket", "  eng-42 "), { value: "ENG-42" });
});

test("ticket rejects anything that is not ENG-###", () => {
  for (const bad of ["613", "ENG-", "ENG613", "ENG-6a", "JIRA-1", ""]) {
    const r = validateSeed("ticket", bad);
    assert.ok("error" in r, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("branch accepts a normal slug and trims it", () => {
  assert.deepEqual(validateSeed("branch", "  eng-613-fix-expiry "), {
    value: "eng-613-fix-expiry",
  });
  assert.deepEqual(validateSeed("branch", "feature/eng-1_v2.1"), {
    value: "feature/eng-1_v2.1",
  });
});

test("branch rejects unsafe names that would break git worktree add", () => {
  for (const bad of [
    "has space",
    "-leading",
    "/leading",
    "trailing/",
    "a..b",
    "bad$char",
    "",
  ]) {
    const r = validateSeed("branch", bad);
    assert.ok("error" in r, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("task and summary reject empty, accept trimmed text", () => {
  assert.ok("error" in validateSeed("task", "   "));
  assert.ok("error" in validateSeed("summary", ""));
  assert.deepEqual(validateSeed("task", "  clean up the value  "), {
    value: "clean up the value",
  });
  assert.deepEqual(validateSeed("summary", "Consolidate print invoice"), {
    value: "Consolidate print invoice",
  });
});

test("an unknown field key is reported as an error, not thrown", () => {
  assert.deepEqual(validateSeed("nope", "x"), {
    error: "unknown field 'nope'",
  });
});
