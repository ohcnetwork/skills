// skill-source.ts — loads the reusable methodology body from skill/guide source files.
//
// Strategy 2 (from PLAN-skill-sourcing.md): inject the methodology as the role's system prompt at
// startup rather than having the model load it via the skill tool at runtime. This is equivalent in
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
    console.warn(`[skill-source] warning: could not read ${absPath}: ${(e as Error).message}`);
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
    console.warn(`[skill-source] warning: no methodology region name="${regionName}" found in ${absPath}`);
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
    loadMethodology(resolve(SKILLS_ROOT, "care-diff-review/SKILL.md"), "default"),
    loadMethodology(resolve(SKILLS_ROOT, "care-technical-review/SKILL.md"), "default"),
  ];
  if (opts.tsx) {
    parts.push(loadMethodology(resolve(SKILLS_ROOT, "care-ux-review/SKILL.md"), "static"));
  }
  return parts.filter(Boolean).join("\n\n---\n\n");
}

/**
 * The planner methodology injected into both the interview-phase and plan-phase system prompts.
 * Sources from guides/01-plan.md (Phases 1–4, enforcement/persistence excluded).
 * Both phases receive the same methodology body; the per-phase preamble controls what to output.
 */
export function plannerMethodology(): string {
  return loadMethodology(resolve(LOOP_DIR, "guides/01-plan.md"), "default");
}

/**
 * The triage methodology injected into the 6a triager's system prompt.
 * Sources from guides/06a-triage.md (Collate + Triage core, enforcement/persistence excluded).
 */
export function triagerMethodology(): string {
  return loadMethodology(resolve(LOOP_DIR, "guides/06a-triage.md"), "default");
}
