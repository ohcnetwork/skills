// Golden-master over runCiRounds' journal stream.
//
// The behavioural tests in ci-round.test.ts assert outcomes and reason codes with `.some()`, so they
// would not catch a reordering of journal events. This pins the exact sequence — event, step, round,
// and reason_code — for the scenarios that exercise each branch of the driver, so a refactor that
// changes the order or drops an append fails loudly.
//
// Regenerate deliberately with CARE_GOLDEN_UPDATE=1 after an INTENDED behaviour change, and read the
// resulting diff before committing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCiRounds, type CiRoundsOptions, type CiFixFn } from "../src/ci-round.ts";
import { Journal } from "../src/journal.ts";
import { makeFakeGitHub } from "./fake-github.ts";
import { useRealStore } from "./_store.ts";
import type { CiConclusion } from "../src/github.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "__golden__");
const UPDATE = process.env.CARE_GOLDEN_UPDATE === "1";

// The DB is authoritative since the §10 cutover: `Journal.read()` queries it and `append()` sources
// seq/prev/deltaMs from it, so a run without a real store installed reads back empty forever — the
// seed never lands and `projectAndWrite` throws on an empty journal. A fresh :memory: store per run
// dir also keeps the scenarios isolated from each other.
const rd = () => {
  useRealStore();
  return mkdtempSync(join(tmpdir(), "careloopd-golden-"));
};
const BOTS = [{ name: "a", aliases: ["a[bot]"] }];

const gh = (ci: CiConclusion = "pass", extra: Record<string, unknown> = {}) =>
  makeFakeGitHub({
    getPr: async () => ({
      number: 1, state: "open", headSha: "h", headRef: "b", title: "[ENG-1] x",
    }),
    listReviews: async () => [
      { id: 0, body: "", user: "a[bot]", submittedAt: "2099-01-01T00:00:00Z",
        state: "COMMENTED", commitId: "h" },
    ],
    getChecks: async () => ({
      total: 1, pending: 0, failing: ci === "fail" ? 1 : 0, conclusion: ci,
    }),
    ...extra,
  });

function opts(over: Partial<CiRoundsOptions> = {}): CiRoundsOptions {
  return {
    gh: gh(), runDir: rd(), repo: "ohcnetwork/care_fe", branch: "scratch",
    pr: 1, headSha: "h", sinceIso: "2026-07-13T00:00:00Z", bots: BOTS,
    triage: async () => ({ addressCount: 0, declineCount: 0 }),
    apply: async () => ({ terminalState: "done" }),
    gate: () => ({ exit: 0, summary: "run_gate: ALL PASSED" }),
    push: () => ({ exit: 0, summary: "pushed", headSha: "h2" }),
    pollDeps: { now: () => 0, sleep: async () => {} },
    ...over,
  };
}

/** The stable shape of one journal line: everything the driver controls, nothing timing-dependent. */
function trace(runDir: string): string {
  // readReplica(), not read(): since the §10 cutover `read()` queries the DB BY run_id, and
  // `runCiRounds` mints its own real ULID via `openRun` — the literal "x" here matches nothing, so a
  // DB read comes back empty and every golden silently compares against an empty stream. The
  // file replica is the same events, addressed by path rather than by id.
  const { events } = new Journal(join(runDir, "journal.jsonl"), "x").readReplica();
  return events
    .map((e) => {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const bits = [
        e.event,
        e.step !== undefined ? `step=${e.step}` : null,
        e.round !== undefined ? `round=${e.round}` : null,
        d.reason_code ? `reason=${d.reason_code}` : null,
        d.cmd ? `cmd=${d.cmd}` : null,
        d.role ? `role=${d.role}` : null,
        d.signal ? `signal=${d.signal}` : null,
        d.from ? `${d.from}->${d.to}` : null,
        d.outcome ? `outcome=${d.outcome}` : null,
        d.verdict ? `verdict=${d.verdict}` : null,
      ].filter(Boolean);
      return bits.join(" ");
    })
    .join("\n") + "\n";
}

async function golden(name: string, o: CiRoundsOptions): Promise<void> {
  const res = await runCiRounds(o);
  const actual = `outcome=${res.outcome} rounds=${res.rounds}\n---\n` + trace(o.runDir);
  const path = join(GOLDEN_DIR, `${name}.txt`);
  if (UPDATE || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `journal stream drifted for '${name}'`);
}

test("golden: converged round 1, nothing to address", async () => {
  await golden("converged-clean", opts());
});

test("golden: one address round then converge", async () => {
  let n = 0;
  await golden("address-then-converge", opts({
    triage: async () => (++n === 1
      ? { addressCount: 1, declineCount: 0, items: [{ id: "1", class: "bug", verdict: "address", note: "x", threads: [11] } as any] }
      : { addressCount: 0, declineCount: 0 }),
  }));
});

test("golden: poll timeout defers", async () => {
  await golden("poll-timeout", opts({
    gh: gh("pending", { getChecks: async () => ({ total: 1, pending: 1, failing: 0, conclusion: "pending" as CiConclusion }) }),
    pollDeps: { now: (() => { let t = 0; return () => (t += 60_000 * 60); })(), sleep: async () => {} },
  }));
});

test("golden: bots clean + CI red, no fixer → handoff", async () => {
  await golden("ci-red-handoff", opts({ gh: gh("fail") }));
});

test("golden: standalone ci-fix, fixed then converges", async () => {
  let checks = 0;
  const ciFix: CiFixFn = async () => ({ outcome: "fixed", filesChanged: ["src/a.ts"] });
  await golden("cifix-fixed", opts({
    gh: gh("fail", { getChecks: async () => (++checks <= 1
        ? { total: 1, pending: 0, failing: 1, conclusion: "fail" as CiConclusion }
        : { total: 1, pending: 0, failing: 0, conclusion: "pass" as CiConclusion }) }),
    ciFix,
  }));
});

test("golden: batched round — bot fix + ci fix, single push", async () => {
  let checks = 0;
  let n = 0;
  await golden("batched-round", opts({
    gh: gh("fail", { getChecks: async () => (++checks <= 1
        ? { total: 1, pending: 0, failing: 1, conclusion: "fail" as CiConclusion }
        : { total: 1, pending: 0, failing: 0, conclusion: "pass" as CiConclusion }) }),
    triage: async () => (++n === 1
      ? { addressCount: 1, declineCount: 0, items: [{ id: "1", class: "bug", verdict: "address", note: "x", threads: [11] } as any] }
      : { addressCount: 0, declineCount: 0 }),
    ciFix: async () => ({ outcome: "fixed", filesChanged: ["src/a.ts"] }),
  }));
});

test("golden: gate-loopback then gate-blocked", async () => {
  let n = 0;
  await golden("gate-blocked", opts({
    triage: async () => (++n === 1 ? { addressCount: 1, declineCount: 0 } : { addressCount: 0, declineCount: 0 }),
    gate: () => ({ exit: 1, summary: "tsc: error" }),
  }));
});

test("golden: apply keeps failing → capped", async () => {
  await golden("apply-capped", opts({
    triage: async () => ({ addressCount: 1, declineCount: 0 }),
    apply: async () => ({ terminalState: "failed" }),
  }));
});
