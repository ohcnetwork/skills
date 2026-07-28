import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getFailingSpecs,
  mergeShardReports,
  normalizeSpecPath,
  specsFromReport,
  type PwReport,
} from "../src/ci-artifact.ts";

// A realistic single-shard report: nested describe suites, a passed spec, a flaky spec (failed then
// passed on retry → NOT a failure to re-run), a genuine failure in a nested suite, and a spec whose
// own `file` is absent so the path must fall back to the containing suite's (absolute) file.
const shard1: PwReport = {
  suites: [
    {
      title: "login.spec.ts",
      file: "tests/auth/login.spec.ts",
      specs: [
        { title: "logs in", file: "tests/auth/login.spec.ts", tests: [{ status: "expected" }] },
      ],
      suites: [
        {
          title: "when locked out",
          file: "tests/auth/login.spec.ts",
          specs: [
            { title: "shows error", file: "tests/auth/login.spec.ts", tests: [{ status: "unexpected" }] },
          ],
        },
      ],
    },
    {
      title: "paymentSheetUrl.spec.ts",
      // absolute path, as a CI runner emits — must normalize to repo-relative:
      file: "/home/runner/work/care_fe/care_fe/tests/billing/paymentSheetUrl.spec.ts",
      specs: [
        { title: "retries once", tests: [{ status: "flaky" }] }, // excluded
        { title: "renders url", tests: [{ status: "unexpected" }] }, // fail, uses suite file
      ],
    },
  ],
};

// A second shard failing a different spec — used to prove the cross-shard union.
const shard2: PwReport = {
  suites: [
    {
      title: "encounter.spec.ts",
      file: "tests/facility/patient/encounter/encounter.spec.ts",
      specs: [
        { title: "creates encounter", tests: [{ status: "unexpected" }] },
      ],
    },
  ],
};

// The real degenerate report observed in care_fe: a global-setup error (port in use) → zero suites.
// This is the infra/shard-death shape: red CI, no per-spec failure.
const infra: PwReport = { suites: [] };

test("normalizeSpecPath: absolute and relative both reduce to repo-relative tests/…", () => {
  assert.equal(
    normalizeSpecPath("/home/runner/work/care_fe/care_fe/tests/billing/paymentSheetUrl.spec.ts"),
    "tests/billing/paymentSheetUrl.spec.ts",
  );
  assert.equal(normalizeSpecPath("tests/auth/login.spec.ts"), "tests/auth/login.spec.ts");
  // non-spec / unexpected shape → returned as-is (defensive, never throws)
  assert.equal(normalizeSpecPath("weird/path.txt"), "weird/path.txt");
});

test("specsFromReport: collects real failures, dedups, excludes flaky/passed, walks nested suites", () => {
  const specs = specsFromReport(shard1).sort();
  assert.deepEqual(specs, [
    "tests/auth/login.spec.ts", // nested-suite failure, appears once despite the passed spec above
    "tests/billing/paymentSheetUrl.spec.ts", // absolute path normalized; flaky sibling excluded
  ]);
});

test("specsFromReport: infra report (no suites) yields no specs", () => {
  assert.deepEqual(specsFromReport(infra), []);
});

test("mergeShardReports: unions across shards, sorted + deduped, shardOnlyFailure=false", () => {
  const r = mergeShardReports([shard1, shard2]);
  assert.deepEqual(r.specPaths, [
    "tests/auth/login.spec.ts",
    "tests/billing/paymentSheetUrl.spec.ts",
    "tests/facility/patient/encounter/encounter.spec.ts",
  ]);
  assert.equal(r.shardOnlyFailure, false);
});

test("mergeShardReports: all-infra shards → shardOnlyFailure=true, no specs", () => {
  const r = mergeShardReports([infra, { suites: [] }]);
  assert.deepEqual(r.specPaths, []);
  assert.equal(r.shardOnlyFailure, true);
});

test("getFailingSpecs: merges via injected fetch", async () => {
  const r = await getFailingSpecs("sha123", undefined, async () => [shard1, shard2]);
  assert.equal(r.specPaths.length, 3);
  assert.equal(r.shardOnlyFailure, false);
});

test("getFailingSpecs: threads the repo slug through to the fetcher (repo-explicit gh)", async () => {
  let seen: string | undefined = "UNSET";
  await getFailingSpecs("sha123", "ohcnetwork/care_fe", async (_ref, repo) => {
    seen = repo;
    return [];
  });
  assert.equal(seen, "ohcnetwork/care_fe");
});

test("getFailingSpecs: fetch failure degrades to no-specs + shardOnlyFailure (never throws)", async () => {
  const r = await getFailingSpecs("sha123", undefined, async () => {
    throw new Error("gh download failed");
  });
  assert.deepEqual(r, { specPaths: [], shardOnlyFailure: true });
});
