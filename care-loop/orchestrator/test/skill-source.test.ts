import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMethodology } from "../src/skill-source.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "careloopd-skillsrc-"));

function write(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

test("loadMethodology extracts a single named region, trimmed", () => {
  const dir = tmp();
  const p = write(
    dir,
    "a.md",
    '# Title\n\npreamble (host mechanic)\n\n<!-- care-loop:methodology name="default" -->\ncore body\n<!-- /care-loop:methodology -->\n\ntrailer (mechanic)\n',
  );
  const out = loadMethodology(p, "default");
  assert.equal(out, "core body");
  assert.doesNotMatch(out, /preamble|trailer/);
});

test("loadMethodology concatenates multiple regions of the same name (non-contiguous)", () => {
  const dir = tmp();
  const p = write(
    dir,
    "b.md",
    '<!-- care-loop:methodology name="default" -->\nblock one\n<!-- /care-loop:methodology -->\n' +
      "STRIP THIS MIDDLE MECHANIC\n" +
      '<!-- care-loop:methodology name="default" -->\nblock two\n<!-- /care-loop:methodology -->\n',
  );
  const out = loadMethodology(p, "default");
  assert.equal(out, "block one\n\nblock two");
  assert.doesNotMatch(out, /STRIP THIS MIDDLE/);
});

test("loadMethodology isolates regions by name (static vs live — the ux Mode-2 trap)", () => {
  const dir = tmp();
  const p = write(
    dir,
    "ux.md",
    '<!-- care-loop:methodology name="static" -->\nstatic rubric\n<!-- /care-loop:methodology -->\n' +
      '<!-- care-loop:methodology name="live" -->\nlive browser instructions\n<!-- /care-loop:methodology -->\n',
  );
  assert.equal(loadMethodology(p, "static"), "static rubric");
  assert.doesNotMatch(loadMethodology(p, "static"), /live browser/);
  assert.equal(loadMethodology(p, "live"), "live browser instructions");
});

test("loadMethodology returns empty string when the named region is missing", () => {
  const dir = tmp();
  const p = write(
    dir,
    "c.md",
    '<!-- care-loop:methodology name="default" -->\nx\n<!-- /care-loop:methodology -->\n',
  );
  assert.equal(loadMethodology(p, "nonexistent"), "");
});

test("loadMethodology returns empty string when the file is missing", () => {
  assert.equal(
    loadMethodology(join(tmp(), "does-not-exist.md"), "default"),
    "",
  );
});

test("loadMethodology memoizes per (path, region) — a second read of a since-changed file returns the cached body", () => {
  const dir = tmp();
  const p = write(
    dir,
    "d.md",
    '<!-- care-loop:methodology name="default" -->\nv1\n<!-- /care-loop:methodology -->\n',
  );
  assert.equal(loadMethodology(p, "default"), "v1");
  writeFileSync(
    p,
    '<!-- care-loop:methodology name="default" -->\nv2\n<!-- /care-loop:methodology -->\n',
    "utf8",
  );
  assert.equal(loadMethodology(p, "default"), "v1"); // cached
});

// ── PLAN-pr-salvage §3.1: care-intent extraction must not move the 4a reviewer prompt ─────────────
import { readFileSync } from "node:fs";
import {
  reviewerMethodology,
  intentReconstruction,
} from "../src/skill-source.ts";

const goldenDir = join(import.meta.dirname, "fixtures");

test("reviewerMethodology is byte-identical after Step 2 → care-intent (no-tsx)", () => {
  const golden = readFileSync(
    join(goldenDir, "reviewer-methodology-notsx.golden.txt"),
    "utf8",
  );
  assert.equal(reviewerMethodology({ tsx: false }), golden);
});

test("reviewerMethodology is byte-identical after Step 2 → care-intent (tsx appends ux-static)", () => {
  const golden = readFileSync(
    join(goldenDir, "reviewer-methodology-tsx.golden.txt"),
    "utf8",
  );
  assert.equal(reviewerMethodology({ tsx: true }), golden);
});

test("the answer-key rule stays OUT of the reviewer prompt (it lives outside every region)", () => {
  // Regression guard for the extraction trap: care-diff-review Step 1's "don't read the commit
  // message / PR body" rule is NOT in the reviewer prompt today, and must not sneak in via care-intent.
  const r = reviewerMethodology({ tsx: false });
  assert.doesNotMatch(r, /are the answer key/i);
});

test("the Reference block stays IN the reviewer prompt (the second findings region)", () => {
  const r = reviewerMethodology({ tsx: false });
  assert.match(r, /what "legible CARE code" looks like/);
});

test("intentReconstruction is Step 2 only — no Reference block, no answer-key rule", () => {
  const ir = intentReconstruction();
  assert.match(ir, /Reconstruct the intent from the code/);
  assert.match(ir, /Intent reconstruction mini-checklist/);
  assert.doesNotMatch(ir, /what "legible CARE code" looks like/); // Reference excluded
  assert.doesNotMatch(ir, /Legibility gaps/); // Step 3 excluded — reconstruction, not critique
});
