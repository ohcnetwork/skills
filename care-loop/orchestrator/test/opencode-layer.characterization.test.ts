// Pins what every opencode-backed role actually sends: the server config (permission, tools), each
// session's turns (model, system, parts, structured-output schema), each drive's deadline, and the
// `opencode run` argv/env/timeout for the two CLI roles — plus how each adapter maps the reply back.
//
// The transport workarounds (two-turn explore→emit, NO_EXPLORE_TOOLS, `task` off, external_directory,
// fork prime, per-role timeouts, the implementer's git denies) all live in this contract, so a refactor
// of the layer must leave the golden byte-identical, and an intended change shows up as a reviewable
// diff. Skill text is replaced by `<<skill:…>>` placeholders so skill edits don't churn it.
//
// Regenerate deliberately: UPDATE_GOLDEN=1 node --import tsx --test test/opencode-layer.characterization.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeOpencode, type FakeReply, type FakeScript } from "./_fake-opencode.ts";
import {
  setOpencodeLauncher,
  setDriveObserver,
  promptStructured,
  promptAgenticThenStructured,
  driveDoctorSpawn,
  startEvalServer,
} from "../src/opencode-runner.ts";
import {
  setCliRunner,
  opencodeReviewer,
  opencodeImplementer,
  opencodeTriager,
  opencodeTestGrader,
  opencodeUxValidator,
  opencodeCiFixer,
  opencodePlanner,
  opencodeIntentReconstructor,
} from "../src/skills-opencode.ts";
import {
  reviewerMethodology,
  plannerMethodology,
  triagerMethodology,
  testGraderMethodology,
  uxValidatorMethodology,
  ciFixerMethodology,
  playwrightMechanics,
  intentReconstruction,
  doctorMethodology,
} from "../src/skill-source.ts";
import type { HelperOptions, HelperResult } from "../src/shell.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "__golden__", "opencode-layer-calls.json");
const PNG = join(HERE, "fixtures", "probe-image.png");

const MODELS = {
  provider: "github-copilot",
  reviewer: "claude-opus-4.8",
  implementer: "claude-sonnet-4.6",
  triager: "claude-opus-4.8",
  planner: "claude-opus-4.8",
  plannerRecon: "claude-sonnet-4.6",
  testGrader: "claude-opus-4.8",
  uxValidator: "claude-opus-4.8",
  ciFixer: "claude-sonnet-4.6",
};

const FEEDBACK = [
  "# PR #1 — pre-digested bot feedback   (2026-09-11T00:00:00Z)",
  "",
  "## Inline comments",
  "- `src/Foo.tsx:1`",
  "  - **coderabbitai[bot]** (thread 101)",
  "      🟠 Major: `n` may be undefined here — `n!.toFixed()` throws.",
  "",
  "- `src/Bar.tsx:1`",
  "  - **greptile-apps[bot]** (thread 202)",
  "      Consider memoizing Bar.",
  "",
  "## Summary comments",
  "- **coderabbitai[bot]** (comment 303)",
  "    Walkthrough: Foo gains an `n` prop.",
  "",
].join("\n");

/** A canned, schema-valid reply for whichever structured output the turn asks for. */
function reply(body: any): FakeReply {
  const base: FakeReply = {
    modelID: body?.model?.modelID,
    cost: 0.01,
    tokens: { input: 100, output: 10, cache: { read: 0, write: 0 } },
  };
  const schema = body?.format?.schema;
  if (!schema) return base; // an exploration or warm-up turn
  const req: string[] = schema.required ?? [];
  const itemReq: string[] = schema.properties?.items?.items?.required ?? [];
  let structured: unknown;
  if (req.includes("role"))
    structured = {
      schema: "care-loop/jobresult@1",
      role: "care-reviewer",
      run_id: "review",
      round: 1,
      terminal_state: "done",
      verdict: "findings",
      reason_code: "reviewed",
      findings: [{ class: "correctness", file: "src/Foo.tsx", line_hint: "1", note: "null deref" }],
      model_used: body.model.modelID,
    };
  else if (itemReq.includes("needs_cross_file"))
    structured = {
      items: [
        {
          source: "coderabbitai[bot]",
          class: "correctness",
          verdict: "address",
          missed_by: "care-reviewer",
          reason: "real",
          threads: [101],
          needs_cross_file: false,
        },
      ],
    };
  else if (req.includes("items"))
    structured = {
      items: [
        {
          source: "coderabbitai[bot]",
          class: "correctness",
          verdict: "address",
          missed_by: "care-reviewer",
          severity: "high",
          reason: "real bug",
          threads: [101],
        },
        {
          source: "greptile-apps[bot]",
          class: "other",
          verdict: "decline",
          missed_by: "none",
          reason: "not worth it",
          threads: [202],
        },
      ],
    };
  else if (req.includes("criteria_grades"))
    structured = {
      verdict: "advisory",
      criteria_grades: [
        { criterion: "renders Foo", verdict: "Weak", criticality: "Secondary", finding: "thin", fix: "assert text" },
      ],
    };
  else if (req.includes("reason_code"))
    structured = {
      verdict: "findings",
      reason_code: "ux_reviewed",
      findings: [{ severity: "Polish", file: "src/Foo.tsx", line_hint: "1", note: "spacing" }],
    };
  else if (req.includes("questions")) structured = { questions: [{ id: "q1", prompt: "Which list?" }] };
  else if (req.includes("scope"))
    structured = {
      scope: "s",
      files: ["src/Foo.tsx"],
      approach: "a",
      criteria: ["renders Foo"],
      nonGoals: ["no BE"],
      testSurface: "route /foo",
      classification: "standard",
      plannedBy: "Opus 4.8",
    };
  else if (req.includes("intent"))
    structured = { intent: "Overall: tweak", criteria: ["renders Foo"], classification: "trivial" };
  else if (req.includes("ok")) structured = { ok: true };
  else throw new Error(`characterization fake: no canned reply for a schema requiring ${req.join(",")}`);
  return { ...base, structured };
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    encoding: "utf8",
  });
}

function fixtures(): { root: string; WT: string; RUN: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oc-char-")));
  const WT = join(root, "wt");
  const RUN = join(root, "run");
  mkdirSync(join(WT, "src"), { recursive: true });
  mkdirSync(join(WT, "tests"), { recursive: true });
  mkdirSync(RUN, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "develop", WT]);
  writeFileSync(join(WT, "src/Foo.tsx"), "export const Foo = () => <div>a</div>;\n");
  writeFileSync(join(WT, "src/Bar.tsx"), "export const Bar = () => null;\n");
  writeFileSync(join(WT, "tests/foo.spec.ts"), "test('foo', () => {});\n");
  git(WT, "add", "-A");
  git(WT, "commit", "-qm", "base");
  git(WT, "checkout", "-qb", "feature");
  writeFileSync(
    join(WT, "src/Foo.tsx"),
    "export const Foo = ({ n }: { n?: number }) => <div>{n!.toFixed()}</div>;\n",
  );
  writeFileSync(
    join(WT, "tests/foo.spec.ts"),
    "test('foo', async ({ page }) => { await expect(page.getByText('1')).toBeVisible(); });\n",
  );
  git(WT, "add", "-A");
  git(WT, "commit", "-qm", "change");
  writeFileSync(join(RUN, "criteria.md"), "# Acceptance criteria — ENG-1\n\n- renders Foo\n");
  writeFileSync(join(RUN, "decisions.md"), "# Decisions — ENG-1\n\n## Non-goals\n\n- no backend change\n");
  writeFileSync(join(RUN, "feedback.md"), FEEDBACK);
  return { root, WT, RUN };
}

function stripTimes(r: unknown): unknown {
  if (r && typeof r === "object" && "startedAt" in r) {
    const { startedAt: _s, endedAt: _e, ...rest } = r as Record<string, unknown>;
    return rest;
  }
  return r;
}

const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Skill text → placeholders, temp paths → stable tokens, data URIs → content hashes. */
function normalize(value: unknown, subs: [string, string][]): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const [from, to] of subs) s = s.split(from).join(to);
    return s.replace(
      /data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)/g,
      (_m, mime: string, b64: string) => `data:${mime};base64,<sha256:${shortHash(b64)} len=${b64.length}>`,
    );
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, subs));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, subs)]));
  return value;
}

test("the opencode layer sends exactly what the golden records", async () => {
  for (const k of Object.keys(process.env)) if (k.startsWith("OC_")) delete process.env[k];
  const { root, WT, RUN } = fixtures();
  const DIFF = git(WT, "diff", "develop...HEAD");

  const cases: unknown[] = [];
  const record = async (
    name: string,
    run: () => Promise<unknown>,
    script: FakeScript = ({ body }) => reply(body),
  ) => {
    const fake = fakeOpencode(script);
    const cli: unknown[] = [];
    setOpencodeLauncher(fake.launcher as any);
    setDriveObserver(fake.observeDrive);
    setCliRunner((o: HelperOptions): HelperResult => {
      const perm = o.env?.OPENCODE_PERMISSION;
      cli.push({
        cmd: o.cmd,
        args: o.args,
        permission: perm ? JSON.parse(perm) : undefined,
        timeoutMs: o.timeoutMs,
        logPath: o.logPath,
      });
      // The maker "edits" the tree, so the adapters take their changed-tree branch.
      writeFileSync(join(WT, "src/Foo.tsx"), "export const Foo = () => <div>edited</div>;\n");
      return { cmd: o.cmd, args: o.args ?? [], exit: 0, summary: "ok", logPath: o.logPath };
    });
    let result: unknown;
    try {
      result = stripTimes(await run());
    } catch (e) {
      result = { threw: (e as Error).message };
    }
    git(WT, "checkout", "--", ".");
    cases.push({
      name,
      servers: fake.servers.map((s) => ({ config: s.config, closed: s.closed, calls: s.calls })),
      cli,
      result,
    });
  };

  try {
    await record("reviewer", () => opencodeReviewer(MODELS)({ diff: DIFF, runDir: RUN, round: 1 }));
    await record("implementer", () =>
      opencodeImplementer(MODELS)({
        task: "Add an optional n prop to Foo",
        worktree: WT,
        runDir: RUN,
        round: 1,
        findings: "- [correctness] src/Foo.tsx:1 — null deref",
      }),
    );
    await record("triager (fan-out)", () =>
      opencodeTriager(MODELS, WT, "develop")({
        pr: 1,
        round: 1,
        runDir: RUN,
        feedbackPath: join(RUN, "feedback.md"),
      }),
    );
    await record("triager (single-spawn)", () =>
      opencodeTriager(MODELS)({ pr: 1, round: 1, runDir: RUN, feedbackPath: join(RUN, "feedback.md") }),
    );
    await record("test-grader", () => opencodeTestGrader(MODELS, WT)({ diff: DIFF, runDir: RUN, round: 1 }));
    await record("ux-validator", () => opencodeUxValidator(MODELS)({ diff: DIFF, runDir: RUN, round: 1 }));
    await record("ci-fixer", () =>
      opencodeCiFixer(MODELS, WT, "develop")({
        ciFailures: [
          {
            name: "Playwright Tests (shard 1)",
            summary: "1 failed",
            annotations: [{ path: "tests/foo.spec.ts", line: 1, message: "expect(locator).toBeVisible() failed" }],
            log: "Error: expect(locator).toBeVisible() — tests/foo.spec.ts:1",
          },
        ],
        worktree: WT,
        runDir: RUN,
        round: 2,
        failingSpecs: ["tests/foo.spec.ts"],
      }),
    );
    const attachments = [{ path: PNG, mime: "image/png", filename: "probe-image.png" }];
    await record("planner (interview)", () =>
      opencodePlanner(MODELS)({
        task: "Add an optional n prop to Foo",
        ticket: "ENG-1",
        mainRepoPath: WT,
        runDir: RUN,
        round: 1,
        phase: "interview",
        attachments,
      }),
    );
    await record("planner (plan)", () =>
      opencodePlanner(MODELS)({
        task: "Add an optional n prop to Foo",
        ticket: "ENG-1",
        mainRepoPath: WT,
        runDir: RUN,
        round: 2,
        phase: "plan",
        questions: [{ id: "q1", prompt: "Which list?" }],
        answers: [{ id: "q1", answer: "the patient list" }],
        amendment: "use a tooltip",
        attachments,
      }),
    );
    await record("intent reconstructor", () => opencodeIntentReconstructor(MODELS, WT, RUN)({ diff: DIFF }));
    await record("doctor spawn", () =>
      driveDoctorSpawn(
        {
          providerID: "github-copilot",
          modelID: "claude-opus-4.8",
          editSystem: "EDIT-SYSTEM",
          editInstruction: "EDIT-INSTRUCTION",
          emitSystem: "EMIT-SYSTEM",
          emitInstruction: "EMIT-INSTRUCTION",
          timeoutMs: 1_200_000,
        },
        { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
      ),
    );
    await record("eval server", async () => {
      const s = await startEvalServer();
      await s.close();
      return "started+closed";
    });

    // ── Failure paths ─────────────────────────────────────────────────────────────────────────────
    // What each session shape does when a turn errors, emits nothing, stalls, or the prompt is refused
    // over HTTP: which error surfaces, and whether the spawn is retried on a fresh server.
    const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    const oneTurn = { role: "probe", providerID: "p", modelID: "m", system: "SYS", task: "TASK", round: 1, timeoutMs: 60_000 };
    const twoTurn = {
      role: "probe",
      providerID: "p",
      modelID: "m",
      reconSystem: "RECON",
      task: "TASK",
      emitSystem: "EMIT",
      emitInstruction: "EMIT-NOW",
      round: 1,
      timeoutMs: 60_000,
    };
    const doctor = {
      providerID: "p",
      modelID: "m",
      editSystem: "EDIT",
      editInstruction: "EDIT-NOW",
      emitSystem: "EMIT",
      emitInstruction: "EMIT-NOW",
      timeoutMs: 60_000,
    };
    const isEmit = (body: any) => !!body?.format;
    const emitReturns =
      (r: FakeReply): FakeScript =>
      ({ body }) =>
        isEmit(body) ? r : reply(body);
    const structuredOutputError = emitReturns({ error: { name: "StructuredOutputError", message: "schema mismatch" } });
    const noStructuredOutput = emitReturns({ modelID: "m" });
    const exploreErrors: FakeScript = ({ body }) =>
      isEmit(body) ? reply(body) : { error: { name: "ProviderAuthError", message: "token expired" } };
    const stallsOnce = (): FakeScript => {
      let stalled = false;
      return ({ body }) => {
        if (stalled) return reply(body);
        stalled = true;
        return { hang: true };
      };
    };
    const httpStatus =
      (status: number): FakeScript =>
      () => ({ httpError: { status, body: { name: "ServerError", data: { message: `HTTP ${status}` } } } });

    // A stall is caught by the inactivity watchdog; shorten it so these cases take milliseconds.
    process.env.OC_INACTIVITY_TIMEOUT_MS = "200";
    const one = () => promptStructured(oneTurn, SCHEMA);
    const two = () => promptAgenticThenStructured(twoTurn, SCHEMA);
    const doc = () => driveDoctorSpawn(doctor, SCHEMA);
    await record("one-turn: StructuredOutputError", one, structuredOutputError);
    await record("one-turn: no structured output", one, noStructuredOutput);
    await record("one-turn: stall, retried on a fresh server", one, stallsOnce());
    await record("one-turn: promptAsync answers HTTP 400", one, httpStatus(400));
    await record("one-turn: promptAsync answers HTTP 500", one, httpStatus(500));
    await record("two-turn: explore turn errors", two, exploreErrors);
    await record("two-turn: StructuredOutputError", two, structuredOutputError);
    await record("two-turn: no structured output", two, noStructuredOutput);
    await record("two-turn: stall, retried on a fresh server", two, stallsOnce());
    await record("doctor: edit turn errors", doc, exploreErrors);
    await record("doctor: StructuredOutputError", doc, structuredOutputError);
    await record("doctor: no structured output", doc, noStructuredOutput);
    await record("doctor: stall, not retried", doc, stallsOnce());
    delete process.env.OC_INACTIVITY_TIMEOUT_MS;

    // Triager fan-out degradation: every per-file fork fails, and then the reduce as well.
    const isFork = (body: any) =>
      !!body?.format?.schema?.properties?.items?.items?.required?.includes("needs_cross_file");
    const triage = () =>
      opencodeTriager(MODELS, WT, "develop")({ pr: 1, round: 1, runDir: RUN, feedbackPath: join(RUN, "feedback.md") });
    await record("triager (fan-out): every fork fails", triage, ({ body }) =>
      isFork(body) ? { modelID: MODELS.plannerRecon } : reply(body),
    );
    await record("triager (fan-out): every fork and the reduce fail", triage, ({ body }) =>
      isEmit(body) ? { modelID: body.model.modelID } : reply(body),
    );
  } finally {
    delete process.env.OC_INACTIVITY_TIMEOUT_MS;
    setOpencodeLauncher();
    setDriveObserver();
    setCliRunner();
  }

  const skills: [string, string][] = (
    [
      ["reviewer+ux", reviewerMethodology({ tsx: true })],
      ["reviewer", reviewerMethodology({ tsx: false })],
      ["planner", plannerMethodology()],
      ["triager", triagerMethodology()],
      ["test-grader", testGraderMethodology()],
      ["ux-validator", uxValidatorMethodology()],
      ["ci-fixer", ciFixerMethodology()],
      ["playwright-mechanics", playwrightMechanics()],
      ["intent", intentReconstruction()],
      ["doctor", doctorMethodology()],
    ] as [string, string][]
  )
    .filter(([, text]) => text.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([name, text]) => [text, `<<skill:${name}>>`] as [string, string]);
  const subs: [string, string][] = [...skills, [root, "<TMP>"], [HERE, "<TEST>"]];
  // Round-trip through JSON so `undefined`-valued keys (e.g. an unset `cost`) compare the way the golden
  // stores them — dropped — rather than as a spurious mismatch.
  const actual = JSON.parse(JSON.stringify(normalize(cases, subs)));

  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  assert.deepStrictEqual(actual, JSON.parse(readFileSync(GOLDEN, "utf8")));
});
