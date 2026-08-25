import { test } from "node:test";
import assert from "node:assert/strict";
import { derivePaths, runSlug, validateSeed } from "../src/front-terminal.ts";

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

// ── Path roots ([[PLAN-loop-service]] §6 deploy) ──────────────────────────────────────────────────

test("path roots are flag, then environment, then the laptop default", () => {
  const saved = { main: process.env.CARE_MAIN_REPO, wt: process.env.CARE_WORKTREE_ROOT };
  try {
    delete process.env.CARE_MAIN_REPO;
    delete process.env.CARE_WORKTREE_ROOT;
    // `~/Desktop` is a reasonable guess on the machine a person is sitting at...
    const laptop = derivePaths("feat-a", {});
    assert.match(laptop.mainRepoPath, /Desktop\/care_fe$/);
    assert.match(laptop.worktree, /Desktop\/care_fe-feat-a$/);

    // ...and nonsense on a headless box, where the service user's home is a state directory. These
    // are properties of the MACHINE, so the unit sets them once rather than the supervisor passing
    // two more flags on every spawn.
    process.env.CARE_MAIN_REPO = "/srv/care_fe";
    process.env.CARE_WORKTREE_ROOT = "/var/lib/care-loopd/worktrees";
    const server = derivePaths("feat-a", {});
    assert.equal(server.mainRepoPath, "/srv/care_fe");
    assert.equal(server.worktree, "/var/lib/care-loopd/worktrees/care_fe-feat-a");

    // A flag still wins over both — a one-off run against another checkout must not need the env
    // unset first.
    const flagged = derivePaths("feat-a", { main: "/tmp/other", worktree: "/tmp/wt" });
    assert.equal(flagged.mainRepoPath, "/tmp/other");
    assert.equal(flagged.worktree, "/tmp/wt");
  } finally {
    if (saved.main === undefined) delete process.env.CARE_MAIN_REPO;
    else process.env.CARE_MAIN_REPO = saved.main;
    if (saved.wt === undefined) delete process.env.CARE_WORKTREE_ROOT;
    else process.env.CARE_WORKTREE_ROOT = saved.wt;
  }
});

test("the run slug is the same rule the service inspects the lock with", () => {
  // Two copies of this would mean the service checking one path's lock while the child takes
  // another's — the admission control would be looking at the wrong file.
  assert.equal(runSlug("ohcnetwork/care_fe", "eng-613/expiry"), "care_fe-eng-613-expiry");
  assert.equal(derivePaths("eng-613/expiry", {}).runDir.endsWith("care_fe-eng-613-expiry"), true);
});
