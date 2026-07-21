// skill-source.ts — loads the reusable methodology body from skill/guide source files.
//
// Strategy 2 (file-injection, not the native skill tool): inject the methodology as the role's system
// prompt at startup rather than having the model load it via the skill tool at runtime. This is equivalent in
// what reaches the model, deterministic, adds zero latency (no extra agentic turn), and avoids
// re-opening the ENG-613 permission-prompt hang class.
//
// Source files use HTML comment markers to delimit reusable regions:
//
//   <!-- care-loop:methodology name="default" -->
//   …reusable methodology…
//   <!-- /care-loop:methodology -->
//
// Multiple regions with the same name are concatenated (handles non-contiguous keep-blocks in files
// like care-diff-review where git/confirm mechanics interleave the methodology). The one-file-two-
// extraction case (care-ux-review: name="static" for 4a, name="live" for 4c) uses distinct names.
//
// Paths are resolved from the loop root (care-loop/), independent of ~/.agents/skills symlinks.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// care-loop/  (grandparent of src/)
const LOOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// skills workspace root (sibling of care-loop/)
const SKILLS_ROOT = resolve(LOOP_DIR, "..");

// ── Memoization ─────────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, string>();

/**
 * Load all `<!-- care-loop:methodology name="<regionName>" -->…<!-- /care-loop:methodology -->`
 * blocks from `absPath`, concatenate them (with a blank line between), and return. Memoized per
 * (path, name) pair so repeated calls in the same process are free.
 *
 * Returns an empty string and logs a warning if the file is missing or no matching region exists —
 * the prompt degrades gracefully (the role preamble still carries the essential instructions) and
 * the failure is visible at startup rather than silently injecting nothing.
 */
export function loadMethodology(absPath: string, regionName: string): string {
  const key = `${absPath}::${regionName}`;
  if (cache.has(key)) return cache.get(key)!;

  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    console.warn(
      `[skill-source] warning: could not read ${absPath}: ${(e as Error).message}`,
    );
    cache.set(key, "");
    return "";
  }

  const pattern = new RegExp(
    `<!--\\s*care-loop:methodology\\s+name="${regionName}"\\s*-->([\\s\\S]*?)<!--\\s*/care-loop:methodology\\s*-->`,
    "g",
  );
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const block = m[1].trim();
    if (block) blocks.push(block);
  }

  if (blocks.length === 0) {
    console.warn(
      `[skill-source] warning: no methodology region name="${regionName}" found in ${absPath}`,
    );
  }

  const result = blocks.join("\n\n");
  cache.set(key, result);
  return result;
}

// ── Public factory functions ─────────────────────────────────────────────────────────────────────

/**
 * The review methodology injected into the 4a reviewer's system prompt.
 * Concatenates care-diff-review (default) + care-technical-review (default).
 * When `tsx` is true (the diff touches src/**‌/*.tsx), also appends care-ux-review (static) —
 * Mode 1 only; Mode 2 (live browser) is deliberately excluded: the 4a reviewer is a bash:deny
 * structured spawn and cannot drive a browser.
 */
export function reviewerMethodology(opts: { tsx: boolean }): string {
  const parts: string[] = [
    loadMethodology(
      resolve(SKILLS_ROOT, "care-diff-review/SKILL.md"),
      "default",
    ),
    loadMethodology(
      resolve(SKILLS_ROOT, "care-technical-review/SKILL.md"),
      "default",
    ),
  ];
  if (opts.tsx) {
    parts.push(
      loadMethodology(
        resolve(SKILLS_ROOT, "care-ux-review/SKILL.md"),
        "static",
      ),
    );
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

/**
 * The planner methodology injected into both the interview-phase and plan-phase system prompts.
 * Sources from the `care-planner` skill (Phases 1–4; the persist/hand-back mechanics outside the
 * region are excluded). Both phases receive the same methodology body; the per-phase preamble
 * controls what to output. Promoted from guides/01-plan.md to a standalone skill so it's eval-able
 * via care-evals like the reviewer lenses.
 */
export function plannerMethodology(): string {
  return loadMethodology(
    resolve(SKILLS_ROOT, "care-planner/SKILL.md"),
    "default",
  );
}

/**
 * The triage methodology injected into the 6a triager's system prompt.
 * Sources from the `care-triager` skill (Collate + Triage core; the persist/output mechanics outside
 * the region are excluded). Promoted from guides/06a-triage.md to a standalone skill.
 */
export function triagerMethodology(): string {
  return loadMethodology(
    resolve(SKILLS_ROOT, "care-triager/SKILL.md"),
    "default",
  );
}

/**
 * The test-grade methodology injected into the 4b test-grader's system prompt.
 * Sources from `care-test-grade` (Working agreement + Steps 2 + 3). Step 1 (gather inputs) is
 * excluded — the headless spawn receives inputs inline (diff, criteria.md, spec file content).
 */
export function testGraderMethodology(): string {
  return loadMethodology(
    resolve(SKILLS_ROOT, "care-test-grade/SKILL.md"),
    "default",
  );
}

/**
 * The CI-fixer methodology injected into the care-ci-fix skill's system prompt (Step 6b ci-fix track).
 * Sources from `care-ci-fix` (test-vs-code classification + guardrails). The implementer preamble
 * carries the edit-only / no-git constraints separately.
 */
export function ciFixerMethodology(): string {
  return loadMethodology(
    resolve(SKILLS_ROOT, "care-ci-fix/SKILL.md"),
    "default",
  );
}

/**
 * The Playwright mechanics region injected into the CI-fixer ONLY when a failing check is an
 * e2e/Playwright spec. Sources the `name="mechanics"` region of the standalone `playwright` skill
 * (Critical Rules + Mindset + the Fixing-a-Failing-Test workflow + flaky triage) — NOT its
 * interactive authoring workflow, which would push a headless fixer to rewrite/expand specs.
 * Conditional, like reviewerMethodology's ux-review append when the diff touches .tsx.
 */
export function playwrightMechanics(): string {
  return loadMethodology(
    resolve(SKILLS_ROOT, "playwright/SKILL.md"),
    "mechanics",
  );
}

/**
 * The UX-review static methodology injected into the 4c ux-validator's system prompt.
 * Sources from `care-ux-review` (name="static") — Mode 1 only, diff-bounded.
 * Mode 2 (live browser) is excluded: the 4c ux-validator is a bash:deny judgment spawn.
 * (The same static region is also blended into the 4a reviewer when the diff touches .tsx;
 *  4c runs it as a dedicated full-pass UX review.)
 */
export function uxValidatorMethodology(): string {
  return loadMethodology(
    resolve(SKILLS_ROOT, "care-ux-review/SKILL.md"),
    "static",
  );
}

/**
 * The FULL care-loop-doctor SKILL.md, injected as the end-of-run doctor's system prompt (auto-doctor.ts).
 * Unlike the role skills, the whole skill IS the methodology (its "Autonomous end-of-run mode" section
 * defines the headless contract), so this reads the entire file rather than a carved region. Also
 * exposes `SKILLS_ROOT` so the wiring can hand the doctor absolute skill/eval paths to edit.
 */
export function doctorMethodology(): string {
  try {
    return readFileSync(
      resolve(SKILLS_ROOT, "care-loop-doctor/SKILL.md"),
      "utf8",
    );
  } catch (e) {
    console.warn(`[skill-source] warning: could not read doctor SKILL.md: ${(e as Error).message}`);
    return "";
  }
}

/** The skills workspace root (sibling of care-loop/) — the doctor edits skill + care-evals files here. */
export const skillsRoot = SKILLS_ROOT;
