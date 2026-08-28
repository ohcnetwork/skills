// verdicts.ts — render the Step-6a triage verdict list to verdicts.md (IMP-15).
//
// The triager emits a per-item verdict list (skills-opencode.ts): each feedback item gets a verdict
// (address/decline), a class, and a `missed_by` attribution — which of OUR pipeline steps
// should have caught it first. Persisting it serves two consumers:
//   • Step 6b reads verdicts.md to know exactly what to apply (previously a dangling read — nothing
//     wrote it, so the maker worked off raw feedback.md);
//   • the doctor reads verdicts.md ACROSS runs for the `class × missed_by` escape pattern (rubric
//     dim 8). A recurring pair (e.g. care-technical-review repeatedly missing a `correctness` class)
//     is the signal that a lens skill is missing a check.

import type { TriageItem } from "./skill-result.js";

const cell = (s: string | undefined): string =>
  (s ?? "-").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim() || "-";

/** Render the verdict list as a compact, doctor-readable markdown table (pure). */
export function renderVerdicts(inp: {
  pr: number;
  round: number;
  items: TriageItem[];
}): string {
  const L: string[] = [
    `# PR #${inp.pr} — triage verdicts (round ${inp.round})`,
    "# per item: verdict · class · missed_by (which of our steps should have caught it) · severity (bot-declared; CodeRabbit only — Copilot/Greptile are always none) · source · reason",
    "# missed_by is the dim-8 escape-attribution signal; 'none' = not an escape, 'novel' = un-catchable pre-merge.",
    "# severity enables high-severity escape mining: a recurring high-severity miss in class×missed_by is a critical skill gap.",
    "",
    "| verdict | class | missed_by | severity | threads | source | reason |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const it of inp.items) {
    const threads = it.threads?.length ? it.threads.join(" ") : "-";
    L.push(
      `| ${cell(it.verdict)} | ${cell(it.class)} | ${cell(it.missedBy)} | ${cell(it.severity ?? "none")} | ${cell(threads)} | ${cell(it.source)} | ${cell(it.reason)} |`,
    );
  }
  L.push("");
  return L.join("\n") + "\n";
}
