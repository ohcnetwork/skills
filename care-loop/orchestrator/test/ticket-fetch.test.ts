import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enrichPlanInput,
  jiraConfigFromEnv,
  flattenAdf,
  collectMediaAlts,
} from "../src/ticket-fetch.ts";
import type { TicketFetcher, TicketContext } from "../src/ports.ts";
import type { PlanInput } from "../src/plan-front.ts";

const rd = () => mkdtempSync(join(tmpdir(), "careloopd-tf-"));

const baseInput = (over: Partial<PlanInput> = {}): PlanInput => ({
  task: "operator note: fix the age string",
  ticket: "ENG-648",
  branch: "eng-648",
  summary: "Fix age",
  repo: "ohcnetwork/care_fe",
  mainRepoPath: "/repo",
  worktree: "/wt",
  runDir: rd(),
  ...over,
});

const ctx = (over: Partial<TicketContext> = {}): TicketContext => ({
  enrichedText: "# ENG-648: Fix age\n\nShow patient age as '25y 3m'.",
  attachments: [],
  ...over,
});

// ── enrichPlanInput: the no-op / merge / cache / degrade paths ─────────────────────────────────────

test("no fetcher ⇒ input returned unchanged (today's behavior)", async () => {
  const input = baseInput();
  const out = await enrichPlanInput(input, undefined);
  assert.equal(out, input);
});

test("fetcher ⇒ ticket text merged into task + attachments threaded + cache written", async () => {
  const input = baseInput();
  const att = [{ path: "/x/a.png", mime: "image/png", filename: "a.png" }];
  const fetcher: TicketFetcher = async () => ctx({ attachments: att });
  const out = await enrichPlanInput(input, fetcher);

  assert.match(out.task, /Show patient age as '25y 3m'/); // ticket text present
  assert.match(out.task, /operator note: fix the age string/); // operator note preserved
  assert.deepEqual(out.attachments, att);
  assert.ok(existsSync(join(input.runDir, "ticket.json")));
  const cached = JSON.parse(
    readFileSync(join(input.runDir, "ticket.json"), "utf8"),
  ) as TicketContext;
  assert.deepEqual(cached.attachments, att);
});

test("resume: cached ticket.json short-circuits the fetch (fetcher never called)", async () => {
  const input = baseInput();
  writeFileSync(
    join(input.runDir, "ticket.json"),
    JSON.stringify(ctx({ enrichedText: "CACHED BRIEF", attachments: [] })),
  );
  let called = 0;
  const fetcher: TicketFetcher = async () => {
    called++;
    return ctx();
  };
  const out = await enrichPlanInput(input, fetcher);
  assert.equal(called, 0);
  assert.match(out.task, /CACHED BRIEF/);
});

test("fetch failure with a kickoff task ⇒ degrades to raw input (no throw)", async () => {
  const input = baseInput();
  const fetcher: TicketFetcher = async () => {
    throw new Error("Jira 500");
  };
  const out = await enrichPlanInput(input, fetcher);
  assert.equal(out.task, input.task); // unchanged raw task
  assert.equal(out.attachments, undefined);
});

test("fetch failure with NO kickoff task ⇒ throws (no brief to plan against)", async () => {
  const input = baseInput({ task: "   " });
  const fetcher: TicketFetcher = async () => {
    throw new Error("Jira 404");
  };
  await assert.rejects(() => enrichPlanInput(input, fetcher), /nothing to plan/);
});

// ── flattenAdf ─────────────────────────────────────────────────────────────────────────────────────

test("flattenAdf: plain string passthrough", () => {
  assert.equal(flattenAdf("hello"), "hello");
});

test("flattenAdf: ADF doc → text with block newlines", () => {
  const adf = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Acceptance criteria:" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "text", text: "age shows months" }],
          },
        ],
      },
    ],
  };
  const out = flattenAdf(adf);
  assert.match(out, /Acceptance criteria:/);
  assert.match(out, /age shows months/);
  assert.ok(out.includes("\n")); // block boundaries produced newlines
});

// The real CARE-298 shape: para → image → para → image, with a Figma inlineCard. Verifies inline
// [image: NAME] markers land in document order and the alt→filename join is what correlates them.
const care298Adf = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "inlineCard", attrs: { url: "https://figma.com/design/x" } },
        { type: "text", text: " " },
        { type: "hardBreak" },
        { type: "text", text: "Add the sheet to view historic data." },
      ],
    },
    {
      type: "mediaSingle",
      content: [
        {
          type: "media",
          attrs: { type: "file", id: "uuid-1", alt: "sheet.png" },
        },
      ],
    },
    {
      type: "paragraph",
      content: [{ type: "text", text: "Existing UI - add a button here." }],
    },
    {
      type: "mediaSingle",
      content: [
        {
          type: "media",
          attrs: { type: "file", id: "uuid-2", alt: "existing.png" },
        },
      ],
    },
  ],
};

test("flattenAdf: inline images become [image: NAME] markers in document order", () => {
  const out = flattenAdf(care298Adf);
  // marker for image 1 sits AFTER its paragraph and BEFORE the second paragraph
  const iSheet = out.indexOf("[image: sheet.png]");
  const iSecondPara = out.indexOf("Existing UI");
  const iExisting = out.indexOf("[image: existing.png]");
  assert.ok(iSheet > 0, "sheet marker present");
  assert.ok(iSheet < iSecondPara, "sheet image precedes the second paragraph");
  assert.ok(iExisting > iSecondPara, "existing-UI image follows its paragraph");
  assert.match(out, /\[link: https:\/\/figma\.com\/design\/x\]/); // Figma link surfaced
});

test("collectMediaAlts: media alts in document order", () => {
  assert.deepEqual(collectMediaAlts(care298Adf), ["sheet.png", "existing.png"]);
});

// ── jiraConfigFromEnv ────────────────────────────────────────────────────────────────────────────

test("jiraConfigFromEnv: undefined when env incomplete", () => {
  assert.equal(jiraConfigFromEnv({ JIRA_BASE_URL: "x" } as NodeJS.ProcessEnv), undefined);
});

test("jiraConfigFromEnv: config when fully set, trailing slash trimmed", () => {
  const cfg = jiraConfigFromEnv({
    JIRA_BASE_URL: "https://org.atlassian.net/",
    JIRA_EMAIL: "me@org.com",
    JIRA_TOKEN: "tok",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg, {
    baseUrl: "https://org.atlassian.net",
    email: "me@org.com",
    token: "tok",
  });
});
