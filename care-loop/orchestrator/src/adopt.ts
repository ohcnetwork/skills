// adopt.ts — bootstrap a run dir from an EXISTING PR so the CI-round loop can be entered late
// (PLAN-pr-salvage §3). A salvage is not a new pipeline: Steps 1–5 are already done and sitting on
// the PR (title/description = intent, diff = implementation). This synthesizes the artifacts the
// rounds read (intent.md / criteria.md / baseline.md / decisions.md / ui-surfaces.md) plus a journal
// that projects to the CI-round entry step, so `planResume` re-enters it like any crashed run.
//
// The intent is reconstructed from the DIFF ALONE (the reconstruction seam never receives the PR
// body — §3.1 blindness is structural, not a prompt rule). The possibly-stale description is compared
// against the reconstruction and the divergence is surfaced at the human gate, which also captures
// non-goals into decisions.md and is what writes the CONFIRMED criteria (never the raw description).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "./journal.js";
import { projectAndWrite, type CareState, type Tier } from "./state.js";
import type { GitHubApi, PrInfo } from "./github.js";

/** What the salvage gate is shown (PLAN-pr-salvage §4). Rendered by front-terminal.ts (§4 task). */
export interface SalvageGateInput {
  pr: number;
  title: string;
  intent: string; // the blind reconstruction (intent.md body)
  description: string; // the PR body — shown for cross-check, NOT fed to reconstruction
  divergence: DivergenceNote;
  draftCriteria: string[]; // derived from the reconstruction, editable at the gate
  reconstructedBy: string; // model/tier label — DISPLAYED, never auto-rejected in salvage (§11 D4)
}
export interface SalvageApproval {
  decision: "approve" | "reject";
  criteria?: string[]; // human-confirmed criteria; defaults to draftCriteria on approve
  nonGoals?: string[]; // captured into decisions.md
  classification?: Tier;
}
export type SalvageGate = (a: SalvageGateInput) => Promise<SalvageApproval>;

export interface DivergenceNote {
  /** true when the description makes claims the reconstruction does not support (or is absent). */
  risk: boolean;
  note: string;
}

export interface AdoptInput {
  gh: GitHubApi;
  pr: number;
  repo: string; // owner/name
  runDir: string;
  worktree: string;
  /** Head-vs-base diff. Injected so tests need no git and the real path can chdir the worktree. */
  diffProvider: (info: PrInfo) => Promise<string>;
  /** Maker-tier reconstruction (care-intent). Given the diff ONLY — never the PR body. */
  reconstruct: (input: {
    diff: string;
  }) => Promise<{ intent: string; criteria: string[]; classification?: Tier }>;
  gate: SalvageGate;
  reconstructedBy?: string;
  now?: () => string;
}

export interface AdoptResult {
  approved: boolean;
  runDir: string;
  prInfo: PrInfo;
  state?: CareState; // present when approved (projected to the CI-round entry step)
  divergence: DivergenceNote;
}

const STOP = new Set([
  "the","a","an","and","or","to","of","in","on","for","with","this","that","is",
  "it","as","be","by","at","from","are","was","were","will","when","then","so",
  "change","changes","adds","add","update","updates","pr","fix","fixes",
]);
function tokens(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(
      (t) => !STOP.has(t),
    ),
  );
}

/** Compare the (blind) reconstruction against the PR description and surface any gap for the gate.
 *  Factual, not a verdict — the human decides. An empty/near-empty description is itself a risk
 *  (nothing to cross-check), which is the common salvage case (§0). Pure. */
export function computeDivergence(
  intent: string,
  description: string,
): DivergenceNote {
  const desc = description.trim();
  if (desc.length < 40) {
    return {
      risk: true,
      note:
        "⚠ The PR description is empty or too thin to cross-check the reconstruction against — " +
        "confirm the reconstructed intent below directly.",
    };
  }
  const it = tokens(intent);
  const dt = tokens(desc);
  let shared = 0;
  for (const t of dt) if (it.has(t)) shared++;
  const overlap = dt.size ? shared / dt.size : 0;
  // Low overlap ⇒ the description talks about different things than the code does (the #16632 case:
  // "describes a completely different set of files and tests than what was actually changed").
  if (overlap < 0.25) {
    return {
      risk: true,
      note:
        `⚠ The description and the code-derived reconstruction have low overlap ` +
        `(${Math.round(overlap * 100)}%). The description may be stale — verify the reconstruction ` +
        `describes what this PR actually changed before accepting the criteria.`,
    };
  }
  return {
    risk: false,
    note: `Description and reconstruction broadly agree (${Math.round(overlap * 100)}% term overlap).`,
  };
}

const touchesTsx = (diff: string): boolean =>
  /^\+\+\+ b\/src\/.*\.tsx$/m.test(diff);

/**
 * Bootstrap the adopted run dir and drive it through the salvage gate. On approval, the journal
 * projects to the CI-round entry step (`5-await`, PR set) so `planResume` returns mode "ci".
 */
export async function adoptPr(input: AdoptInput): Promise<AdoptResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const reconstructedBy = input.reconstructedBy ?? "care-intent (maker)";
  const prInfo = await input.gh.getPr(input.pr);
  const description = prInfo.body ?? "";

  // Reconstruct from the diff ALONE — the PR body is deliberately not passed here (§3.1).
  const diff = await input.diffProvider(prInfo);
  const recon = await input.reconstruct({ diff });
  const divergence = computeDivergence(recon.intent, description);

  mkdirSync(input.runDir, { recursive: true });
  const write = (name: string, body: string) =>
    writeFileSync(
      join(input.runDir, name),
      body.endsWith("\n") ? body : body + "\n",
    );
  write(
    "intent.md",
    `# Reconstructed intent — PR #${input.pr} (${reconstructedBy})\n` +
      `# Reconstructed from the diff alone; NOT from the PR description.\n\n${recon.intent}\n`,
  );
  write(
    "baseline.md",
    `# Scope baseline — PR #${input.pr} (salvage)\n\n` +
      `request: ${prInfo.title}\n` +
      `branch: ${prInfo.headRef}\n` +
      `base: ${prInfo.baseRef ?? "(unknown)"}\n` +
      `owner-boundary: ${input.repo}\n\n` +
      `## Adopted diff (the implementation is DONE — do not grow from here)\n\n` +
      "```diff\n" +
      diff +
      "\n```\n",
  );
  if (touchesTsx(diff))
    write(
      "ui-surfaces.md",
      `# UI surfaces — PR #${input.pr} (salvage)\n\n` +
        `The diff touches .tsx; the changed components are the UI surfaces under review. See baseline.md.\n`,
    );

  const j = new Journal(
    join(input.runDir, "journal.jsonl"),
    `${input.repo.replace("/", "-")}-${prInfo.headRef}`,
  );
  const seed: CareState = {
    task: prInfo.title,
    repo: input.repo,
    branch: prInfo.headRef,
    worktree: input.worktree,
    tier: "standard",
    pr: null,
    round: 1,
    step: "1",
    head_sha: prInfo.headSha,
    last_reviewed_sha: "",
    updated_at: now(),
  };
  if (j.read().events.length === 0)
    j.append({ event: "run.start", step: "1", round: 1, data: { state: seed } });
  j.append({ event: "step.enter", step: "1", round: 1 });

  const approval = await input.gate({
    pr: input.pr,
    title: prInfo.title,
    intent: recon.intent,
    description,
    divergence,
    draftCriteria: recon.criteria,
    reconstructedBy,
  });

  if (approval.decision === "reject") {
    j.append({
      event: "run.end",
      step: "1",
      round: 1,
      data: { outcome: "aborted", reason: "salvage plan rejected" },
    });
    projectAndWrite(input.runDir, j.read().events);
    return { approved: false, runDir: input.runDir, prInfo, divergence };
  }

  // CONFIRMED criteria — from the gate, never the description.
  const criteria = approval.criteria ?? recon.criteria;
  const tier = approval.classification ?? recon.classification ?? "standard";
  write(
    "criteria.md",
    `# Acceptance criteria — PR #${input.pr} (salvage; human-confirmed)\n\n` +
      (criteria.map((c) => `- ${c}`).join("\n") || "- (none stated)") +
      "\n",
  );
  const nonGoals = approval.nonGoals ?? [];
  write(
    "decisions.md",
    `# Decisions — PR #${input.pr} (salvage)\n\n` +
      `## Provenance\n\n- Adopted from PR #${input.pr}; intent reconstructed from the diff and ` +
      `confirmed at the salvage gate (${reconstructedBy}).\n- ${divergence.note}\n\n` +
      `## Non-goals\n\n` +
      (nonGoals.map((n) => `- ${n}`).join("\n") || "- (none stated)") +
      "\n",
  );

  j.append({
    event: "plan.approved",
    step: "1",
    round: 1,
    data: {
      planned_by: reconstructedBy,
      classification: tier,
      push_authorized: true,
      ticket: prInfo.title,
      summary: prInfo.title,
      salvage: true,
      state: { tier },
    },
  });
  j.append({ event: "step.exit", step: "1", round: 1, data: { reason_code: "plan_ready" } });
  j.append({
    event: "decision",
    step: "1",
    round: 1,
    data: { from: "1", to: "2", signal: "advance" },
  });
  // Synthetic push at the PR head, BACKDATED to epoch. `planResume` derives the poll baseline
  // (`sinceIso`) from the push matching the head SHA; a salvaged PR's bots reviewed BEFORE we adopted
  // it, so a now-dated baseline would make the round-1 poll wait forever for re-reviews that never
  // come (the head is unchanged). Epoch makes every EXISTING review count as "arrived", so round 1
  // converges immediately and goes straight to collecting the feedback we came to address. Later
  // rounds get a fresh, correctly-timed push from the loop after we push our fixes.
  j.append({
    event: "push",
    step: "5",
    round: 1,
    ts: new Date(0).toISOString(),
    data: {
      head_sha: prInfo.headSha,
      salvage: true,
      note: "adopted PR head (baseline for existing reviews)",
    },
  });
  // The PR already exists — record it as opened so state.pr is set and planResume enters mode "ci".
  j.append({
    event: "decision",
    step: "5",
    round: 1,
    data: {
      note: "pr-opened",
      pr: input.pr,
      title: prInfo.title,
      state: { pr: input.pr, step: "5-await", head_sha: prInfo.headSha },
    },
  });
  const state = projectAndWrite(input.runDir, j.read().events);
  return { approved: true, runDir: input.runDir, prInfo, state, divergence };
}
