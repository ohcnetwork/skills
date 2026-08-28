// ci-artifact.ts — read the specs that genuinely failed on a CI head, from Playwright's own JSON
// report, so the reactive loop knows exactly which specs the CI-fix track must update (e2e is
// verified on cloud CI, not re-run locally) instead of predicting.
//
// Why the artifact and not check annotations / the PR comment: care_fe's playwright reporter is
// [html, json→test-results.json, list] with NO `github` reporter, run across N shards. So check-run
// annotations are only shard-level "::error::…shard X failed" noise (no spec paths), and the
// "🎭 Playwright Test Results" PR comment carries aggregate counts only (never names specs). The one
// authoritative per-spec source is the JSON report, uploaded as the `playwright-final-report`
// artifact (all-results/playwright-results-shard-*/test-results.json).
//
// Two outputs (the frozen Session-0 contract):
//   • specPaths        — repo-relative "tests/…​.spec.ts" of every genuinely-failed spec, merged
//                        across shards, deduped.
//   • shardOnlyFailure — true when CI was red but NO real spec failure was found: an infra/shard
//                        death (OOM, port-in-use global-setup error, runner timeout). The caller
//                        re-triggers CI rather than sending a phantom failure to the fixer.
//
// The parsing (specsFromReport / mergeShardReports / normalizeSpecPath) is pure and unit-tested; the
// gh download is a thin, injectable seam.

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** The Session-0 frozen return shape (referenced by GitHubApi.getFailingSpecs). */
export interface FailingSpecs {
  /** Repo-relative spec paths that genuinely failed, merged across shards, sorted + deduped. */
  specPaths: string[];
  /** CI red but zero real spec failures found → infra/shard death; caller should re-trigger. */
  shardOnlyFailure: boolean;
}

// ── Playwright JSON reporter — the minimal shape we read (see playwright/types/testReporter.d.ts:
//    JSONReport → JSONReportSuite{ file, specs, suites? } → JSONReportSpec{ file, tests } →
//    JSONReportTest{ status } where status is the POST-RETRY verdict). We treat a test as a real
//    failure only when status === "unexpected"; "flaky" (failed then passed on retry), "expected",
//    and "skipped" are deliberately NOT failures we need to re-run. ────────────────────────────────
interface PwTest {
  status?: "skipped" | "expected" | "unexpected" | "flaky";
}
interface PwSpec {
  title?: string;
  file?: string;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
export interface PwReport {
  suites?: PwSuite[];
}

/** Playwright's JSON `file` is relative to rootDir (the config dir = repo root → "tests/…"), but a
 *  sharded/CI run can emit an absolute path. Reduce either to the repo-relative "tests/…​.spec.ts"
 *  form the CI-fix track reports (and `npx playwright test <path>` expects). Falls back to the raw
 *  value if the path doesn't look like a spec (defensive — never throws). */
export function normalizeSpecPath(file: string): string {
  const m = file.match(/(?:^|\/)(tests\/.*\.spec\.[cm]?[jt]sx?)$/);
  return m ? m[1] : file;
}

/** Walk the (recursively nested) suites, yielding each spec with the nearest file path in scope
 *  (spec.file when present, else the containing suite's file). */
function* eachSpec(
  suites: PwSuite[] | undefined,
  parentFile?: string,
): Generator<{ file: string; spec: PwSpec }> {
  for (const s of suites ?? []) {
    const file = s.file ?? parentFile;
    for (const spec of s.specs ?? [])
      yield { file: spec.file ?? file ?? "", spec };
    yield* eachSpec(s.suites, file);
  }
}

/** Failing spec paths from ONE shard's report — a spec fails if any of its tests ended `unexpected`. */
export function specsFromReport(report: PwReport): string[] {
  const out = new Set<string>();
  for (const { file, spec } of eachSpec(report.suites)) {
    if (!file) continue;
    if ((spec.tests ?? []).some((t) => t.status === "unexpected")) {
      out.add(normalizeSpecPath(file));
    }
  }
  return [...out];
}

/** Union the per-shard reports into the frozen FailingSpecs contract. shardOnlyFailure = "red but no
 *  real spec failure anywhere" (empty union) — the caller only invokes this when CI is already red,
 *  so an empty union means the redness was infra/shard, not a spec. */
export function mergeShardReports(reports: PwReport[]): FailingSpecs {
  const set = new Set<string>();
  for (const r of reports) for (const p of specsFromReport(r)) set.add(p);
  const specPaths = [...set].sort();
  return { specPaths, shardOnlyFailure: specPaths.length === 0 };
}

const WORKFLOW = "Playwright Tests"; // playwright.yaml `name:`
const ARTIFACT = "playwright-final-report"; // merged all-shards artifact

// A gh artifact download can wedge (on eng-747 a stalled `gh run download` held ~13 min at ~0 CPU
// before it was killed by hand) or transiently fail. Run each attempt under a hard timeout so a hung
// try is aborted rather than stranding the run, and retry up to GH_ATTEMPTS times before giving up —
// after which getFailingSpecs' best-effort guard degrades to annotations-only. The timeout is set
// comfortably above a healthy download (~2m40s) so it only fires on a genuine stall.
const GH_ATTEMPTS = 3; // total tries per gh call
const GH_TIMEOUT_MS = 5 * 60_000; // per-attempt hard timeout
const GH_RETRY_BACKOFF_MS = 3_000; // brief pause between attempts

/** Run `fn` up to GH_ATTEMPTS times, pausing briefly between tries; rethrow the last error if every
 *  attempt fails. Each `fn` invocation is expected to enforce its own per-attempt timeout. */
async function withRetry<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GH_ATTEMPTS; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt < GH_ATTEMPTS) await sleep(GH_RETRY_BACKOFF_MS);
    }
  }
  throw lastErr;
}

/** Copilot's integrated terminal is a non-login shell that often lacks brew on PATH, so `gh` comes
 *  back "command not found" — mirror run_gate.sh and prepend the common bins. */
function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}`,
  };
}

/** Default fetch: locate the most recent "Playwright Tests" run for `ref`, download its
 *  `playwright-final-report` artifact (gh auto-unzips), and parse every shard's test-results.json.
 *
 *  `repo` ("owner/name") is REQUIRED in practice: the orchestrator process never chdir's to the
 *  care_fe worktree (default-wiring hands every git/gate command an explicit cwd/-C instead), so a
 *  bare `gh run …` would resolve the wrong repo — or none — from process.cwd(). Passing `--repo`
 *  makes these calls repo-explicit, matching OctokitGitHub's pinned `{owner,name}`. */
async function defaultFetchShardReports(
  ref: string,
  repo?: string,
): Promise<PwReport[]> {
  const repoArgs = repo ? ["--repo", repo] : [];
  const { stdout } = await withRetry(() =>
    pexec(
      "gh",
      [
        "run",
        "list",
        ...repoArgs,
        "--commit",
        ref,
        "--workflow",
        WORKFLOW,
        "--json",
        "databaseId",
        "--limit",
        "1",
      ],
      { env: ghEnv(), timeout: GH_TIMEOUT_MS },
    ),
  );
  const runId = (JSON.parse(stdout) as { databaseId: number }[])[0]?.databaseId;
  if (!runId) return [];
  // Fresh temp dir per attempt: a timed-out download may leave a partial extract behind, so each retry
  // starts clean rather than re-downloading over stale shard files.
  return withRetry(async () => {
    const dir = mkdtempSync(join(tmpdir(), "care-loop-pw-"));
    try {
      await pexec(
        "gh",
        [
          "run",
          "download",
          String(runId),
          ...repoArgs,
          "-n",
          ARTIFACT,
          "-D",
          dir,
        ],
        {
          env: ghEnv(),
          timeout: GH_TIMEOUT_MS,
        },
      );
      return readReportsUnder(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** Recursively collect + parse every test-results.json under `dir` (one per shard). A corrupt shard
 *  file is skipped, not fatal — we still act on the shards we could read. */
function readReportsUnder(dir: string): PwReport[] {
  const out: PwReport[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name === "test-results.json") {
        try {
          out.push(JSON.parse(readFileSync(p, "utf8")) as PwReport);
        } catch {
          /* skip a corrupt/partial shard report */
        }
      }
    }
  }
  return out;
}

/** The GitHubApi.getFailingSpecs implementation. Best-effort: on any fetch/parse failure we return
 *  no specs + shardOnlyFailure=true (we couldn't identify a spec to fix → the caller re-triggers or
 *  hands off, never fabricates a target). `repo` ("owner/name") makes the gh calls repo-explicit —
 *  see defaultFetchShardReports. `fetchReports` is injectable for unit tests. */
export async function getFailingSpecs(
  ref: string,
  repo?: string,
  fetchReports: (
    ref: string,
    repo?: string,
  ) => Promise<PwReport[]> = defaultFetchShardReports,
): Promise<FailingSpecs> {
  try {
    return mergeShardReports(await fetchReports(ref, repo));
  } catch {
    return { specPaths: [], shardOnlyFailure: true };
  }
}
