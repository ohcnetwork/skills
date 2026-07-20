// auto-doctor.ts — the end-of-run self-improvement stage (PLAN-auto-doctor.md). After a loopd run
// terminates, the doctor diagnoses the run, applies eval-COVERED skill edits, verifies them with
// orchestrator tests + affected care-evals, and opens a self-improvement PR carrying the diagnosis +
// coverage delta.
//
// Deterministic scaffold, LLM core (the loopd philosophy): the LLM is invoked ONLY for judgment
// (diagnose + edit skill prose + author fixtures) via the injected `spawnDoctor` seam; every
// side-effect — git branch, running tests/evals, the coherence check, `gh pr create`, journaling —
// goes through an injected seam, so this module is pure decision logic and fully fake-testable, and
// the risky verbs (git/gh/npm) stay off the autonomous agent.
//
// Best-effort: `runAutoDoctor` is called AFTER the loop's real outcome is settled, so any throw here
// is journaled (`doctor.error`) and swallowed — the loop's result is never affected (reply-seam rule).
//
// Apply authority is tiered by EVAL COVERAGE (HARNESS-COVERAGE.md lens): eval coverage is the license
// to auto-apply. A skill edit we can't measure with a fixture must not auto-merge — it is demoted to a
// propose-only item and the PR opens as a DRAFT.

import type { NewEvent } from "./journal.js";

/** skill → care-evals task prefix. A skill NOT in this map has no eval coverage, so its edits are
 *  demoted to propose-only (never auto-merged). care-planner is deliberately absent — it is not a
 *  diff-graded skill (HARNESS-COVERAGE.md BS-3), so nothing can verify a planner edit offline.
 *  care-diff-review / care-technical-review are the care-review lenses: measured INDIRECTLY through
 *  the cr-* suite, so an edit auto-applies only if it keeps the cr numbers green. */
export const SKILL_EVAL_PREFIX: Readonly<Record<string, string>> = {
  "care-review": "cr",
  "care-diff-review": "cr",
  "care-technical-review": "cr",
  "care-test-grade": "tg",
  "care-ux-review": "ux",
  "care-triager": "tr",
  "care-ci-fix": "cf",
};

/** True when `skill` has offline eval coverage (⇒ eligible for gated auto-apply). */
export function hasEvalCoverage(skill: string): boolean {
  return skill in SKILL_EVAL_PREFIX;
}

// ── The doctor LLM's structured output (it also edits files on disk; this is the manifest) ─────────

export interface DoctorFinding {
  imp: string; // "IMP-16" or "new"
  dimension: number; // rubric dimension
  sensorType: "computational" | "inferential" | "none";
  bsRow?: string; // e.g. "BS-8", when the finding maps to a coverage blind spot
  summary: string;
  reObserved: boolean; // seen in a prior diagnosis (dim-7 trend read)
  seen: number; // IMPROVEMENTS.md seen: count after this observation
  regression: boolean; // an `applied` entry recurred — a regression, per IMPROVEMENTS.md rule
}

export interface SkillEdit {
  skill: string; // e.g. "care-ux-review"
  files: string[]; // repo-relative paths the LLM edited for this skill
  note: string;
}

export interface ProposeOnlyItem {
  target: string; // "orchestrator/src/foo.ts" or a skill name without coverage
  reason: "orchestrator-code" | "no-eval-coverage" | "unrecurred-fixture" | "coherence";
  patch: string; // the concrete proposed change, for the PR body
}

export interface NewFixture {
  name: string; // e.g. "ux-11-nested-scroll-tablet"
  skill: string; // which skill's task set it guards
  kind: "verbatim" | "class-sibling";
  recurred: boolean; // for the recurrence gate (only meaningful for class-sibling)
}

export interface CoverageDelta {
  green: number;
  yellow: number;
  red: number;
}

export interface DoctorOutput {
  findings: DoctorFinding[];
  skillEdits: SkillEdit[];
  proposeOnly: ProposeOnlyItem[];
  fixtures: NewFixture[];
  coverageDelta: CoverageDelta;
  /** the diagnosis markdown body — becomes the PR body */
  reportBody: string;
}

// ── Seams (all injected; real impls live in default-wiring.ts) ────────────────────────────────────

export interface GitSeam {
  checkoutNewBranch: (name: string) => void;
  /** revert one repo-relative file to HEAD (used to un-apply a demoted skill edit) */
  revertFile: (path: string) => void;
  changedFiles: () => string[]; // repo-relative, working-tree changes
  commitAll: (message: string) => string; // returns commit sha
}

export interface VerifyResult {
  ok: boolean;
  output: string;
}

export interface AutoDoctorGh {
  createPr: (o: {
    branch: string;
    title: string;
    body: string;
    draft: boolean;
  }) => Promise<number>;
}

export interface AutoDoctorSeams {
  spawnDoctor: (i: {
    runDir: string;
    repoRoot: string;
  }) => Promise<DoctorOutput>;
  git: GitSeam;
  runTests: () => Promise<VerifyResult>;
  runEvals: (taskPrefixes: string[]) => Promise<VerifyResult>;
  coherenceCheck: (skills: string[]) => Promise<{ ok: boolean; note?: string }>;
  gh: AutoDoctorGh;
  append: (ev: NewEvent) => void; // journal sink
  now: () => Date;
}

export interface AutoDoctorOptions {
  runDir: string;
  repoRoot: string; // the SKILLS repo root (where the skills live), NOT the care_fe worktree
  runSlug: string; // for the branch name
  enabled: boolean; // false ⇒ --no-doctor / CARE_DOCTOR=0
  /** journal events of the just-finished run — the guard reads run.start from here */
  journalEvents: { event: string }[];
  /** dry run (Phase-3 smoke): spawn + apply + verify, but NO branch/commit/PR — edits are left in the
   *  working tree to inspect. The verdict (would-be draft?) is still computed and returned/journaled. */
  dry?: boolean;
}

export interface AutoDoctorResult {
  ran: boolean;
  skipped?: string; // reason, when ran === false
  dry?: boolean; // true when no branch/commit/PR was made (Phase-3 smoke)
  branch?: string;
  pr?: number;
  draft?: boolean;
  applied: string[]; // skills auto-applied
  demoted: string[]; // skills moved to propose-only (no eval coverage)
  proposeOnly: number; // total propose-only items in the PR
  fixtures: { committed: string[]; proposed: string[] };
  verify?: { tests: boolean; evals: boolean };
  coherenceOk?: boolean;
  coverageDelta?: CoverageDelta;
}

/** Pure guard: should the stage run at all? Returns a skip-reason string, or null to proceed. */
export function guardReason(o: AutoDoctorOptions): string | null {
  if (!o.enabled) return "disabled (--no-doctor / CARE_DOCTOR=0)";
  if (!o.journalEvents.some((e) => e.event === "run.start"))
    return "no run.start in journal — nothing to diagnose";
  return null;
}

const dateStamp = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Run the end-of-run doctor. Deterministic decision logic over the injected seams; the LLM does the
 * judgment inside `spawnDoctor`. Never throws — a failure is journaled and returned as `ran:false`.
 */
export async function runAutoDoctor(
  opts: AutoDoctorOptions,
  seams: AutoDoctorSeams,
): Promise<AutoDoctorResult> {
  const skip = guardReason(opts);
  if (skip) {
    seams.append({ event: "doctor.skip", data: { reason: skip } });
    return {
      ran: false,
      skipped: skip,
      applied: [],
      demoted: [],
      proposeOnly: 0,
      fixtures: { committed: [], proposed: [] },
    };
  }

  const branch = `care-loop/self-improve/${dateStamp(seams.now())}-${opts.runSlug}`;
  try {
    if (!opts.dry) seams.git.checkoutNewBranch(branch);
    seams.append({ event: "doctor.start", data: { branch, dry: !!opts.dry } });

    const out = await seams.spawnDoctor({
      runDir: opts.runDir,
      repoRoot: opts.repoRoot,
    });

    // ── Reconcile the manifest against GROUND TRUTH. The manifest is the LLM's self-report; trust it
    //    only where it matches actual file changes on disk (the loop's validated-worker-boundary rule
    //    — the orchestrator writes state from verified results, not the agent's word). A skill edit
    //    whose declared files didn't actually change, or a fixture whose files were never written, is
    //    a PHANTOM: dropped (never applied/committed) and journaled. Caught by the 2026-07-20 smoke,
    //    where the manifest claimed a `committedFixtures` entry the doctor never wrote to disk. ──────
    const changed = seams.git.changedFiles();
    const realSkillEdits = out.skillEdits.filter((e) =>
      e.files.some((f) => changed.includes(f)),
    );
    const realFixtures = out.fixtures.filter((fx) =>
      changed.some((c) => c.includes(fx.name)),
    );
    const phantomSkills = out.skillEdits
      .filter((e) => !realSkillEdits.includes(e))
      .map((e) => e.skill);
    const phantomFixtures = out.fixtures
      .filter((fx) => !realFixtures.includes(fx))
      .map((fx) => fx.name);
    if (phantomSkills.length || phantomFixtures.length)
      seams.append({
        event: "doctor.apply",
        data: { phantom: { skills: phantomSkills, fixtures: phantomFixtures } },
      });

    // ── Authority tiering: an edit to a skill without eval coverage cannot auto-merge. Revert the
    //    file so the branch stays clean, and demote it to a propose-only item for the PR body. ──────
    const applied: string[] = [];
    const demoted: string[] = [];
    const proposeOnly: ProposeOnlyItem[] = [...out.proposeOnly];
    for (const edit of realSkillEdits) {
      if (hasEvalCoverage(edit.skill)) {
        applied.push(edit.skill);
      } else {
        demoted.push(edit.skill);
        for (const f of edit.files) seams.git.revertFile(f);
        proposeOnly.push({
          target: edit.skill,
          reason: "no-eval-coverage",
          patch: edit.note,
        });
      }
    }

    // ── Recurrence gate: a synthesized class-sibling fixture only becomes a trusted (committed)
    //    guard once its class has recurred; a first-time escape gets the verbatim anchor only. An
    //    unrecurred sibling is demoted to a proposed (human-review) fixture. Verbatim always commits.
    const committedFixtures: string[] = [];
    const proposedFixtures: string[] = [];
    for (const fx of realFixtures) {
      const trusted = fx.kind === "verbatim" || fx.recurred;
      if (trusted) committedFixtures.push(fx.name);
      else {
        proposedFixtures.push(fx.name);
        proposeOnly.push({
          target: `care-evals fixture ${fx.name}`,
          reason: "unrecurred-fixture",
          patch: `class-sibling for ${fx.skill}; recurrence not yet observed — review before trusting`,
        });
      }
    }

    seams.append({
      event: "doctor.apply",
      data: {
        applied: [...new Set(applied)],
        demoted: [...new Set(demoted)],
        committedFixtures,
        proposedFixtures,
        proposeOnly: proposeOnly.length,
      },
    });

    // ── Coherence gate (BS-8): an autonomous skill edit must not contradict a sibling skill. ───────
    const coherence = applied.length
      ? await seams.coherenceCheck([...new Set(applied)])
      : { ok: true };
    seams.append({
      event: "doctor.coherence",
      data: { ok: coherence.ok, note: coherence.note },
    });

    // ── Verify: affected evals (from applied skills + committed fixtures) + orchestrator tests. ────
    const prefixes = new Set<string>();
    for (const s of applied) prefixes.add(SKILL_EVAL_PREFIX[s]);
    for (const name of committedFixtures) prefixes.add(name.split("-")[0]);
    const editedSomething = applied.length > 0 || committedFixtures.length > 0;

    let verify: { tests: boolean; evals: boolean } | undefined;
    if (editedSomething) {
      const tests = await seams.runTests();
      const evals = await seams.runEvals([...prefixes]);
      verify = { tests: tests.ok, evals: evals.ok };
      seams.append({
        event: "doctor.verify",
        data: { tests: tests.ok, evals: evals.ok, prefixes: [...prefixes] },
      });
    }

    // ── Land. No edits at all ⇒ report-only (commit the diagnosis, no PR). Otherwise a PR: DRAFT if
    //    verification failed, coherence failed, or anything was demoted/unverified; else a real PR. ─
    const verifyGreen = !verify || (verify.tests && verify.evals);
    const draft =
      !verifyGreen ||
      !coherence.ok ||
      demoted.length > 0 ||
      proposeOnly.length > 0 ||
      proposedFixtures.length > 0;

    const anyChange =
      editedSomething || proposeOnly.length > 0 || proposedFixtures.length > 0;

    // Dry run (Phase-3 smoke): stop here — the working-tree edits stand for inspection, no branch/
    // commit/PR. The would-be verdict (draft?) is still reported so we can judge the run.
    if (opts.dry) {
      seams.append({
        event: "doctor.pr",
        data: { pr: null, dry: true, wouldDraft: anyChange ? draft : null },
      });
      return {
        ran: true,
        dry: true,
        branch,
        draft: anyChange ? draft : undefined,
        applied,
        demoted,
        proposeOnly: proposeOnly.length,
        fixtures: { committed: committedFixtures, proposed: proposedFixtures },
        verify,
        coherenceOk: coherence.ok,
        coverageDelta: out.coverageDelta,
      };
    }

    if (!anyChange) {
      seams.git.commitAll(`doctor: diagnosis for ${opts.runSlug} (report-only)`);
      seams.append({ event: "doctor.pr", data: { pr: null, reason: "report-only" } });
      return {
        ran: true,
        branch,
        applied,
        demoted,
        proposeOnly: proposeOnly.length,
        fixtures: { committed: committedFixtures, proposed: proposedFixtures },
        verify,
        coherenceOk: coherence.ok,
        coverageDelta: out.coverageDelta,
      };
    }

    seams.git.commitAll(
      `doctor: self-improvement for ${opts.runSlug}${draft ? " (needs review)" : ""}`,
    );
    const body = renderPrBody(out, {
      applied,
      demoted,
      proposeOnly,
      committedFixtures,
      proposedFixtures,
      verify,
      coherence,
      draft,
    });
    const title = `[auto-doctor] self-improvement from ${opts.runSlug}${draft ? " — needs review" : ""}`;
    const pr = await seams.gh.createPr({ branch, title, body, draft });
    seams.append({ event: "doctor.pr", data: { pr, draft } });

    return {
      ran: true,
      branch,
      pr,
      draft,
      applied,
      demoted,
      proposeOnly: proposeOnly.length,
      fixtures: { committed: committedFixtures, proposed: proposedFixtures },
      verify,
      coherenceOk: coherence.ok,
      coverageDelta: out.coverageDelta,
    };
  } catch (err) {
    seams.append({
      event: "doctor.error",
      data: { branch, message: err instanceof Error ? err.message : String(err) },
    });
    return {
      ran: false,
      skipped: `error: ${err instanceof Error ? err.message : String(err)}`,
      branch,
      applied: [],
      demoted: [],
      proposeOnly: 0,
      fixtures: { committed: [], proposed: [] },
    };
  }
}

/** Render the self-improvement PR body — surfaces the memory (framing point 5): new-vs-re-observed
 *  findings with seen counts, regression flags, the propose-only backlog, and the coverage delta. */
export function renderPrBody(
  out: DoctorOutput,
  ctx: {
    applied: string[];
    demoted: string[];
    proposeOnly: ProposeOnlyItem[];
    committedFixtures: string[];
    proposedFixtures: string[];
    verify?: { tests: boolean; evals: boolean };
    coherence: { ok: boolean; note?: string };
    draft: boolean;
  },
): string {
  const L: string[] = [];
  const d = out.coverageDelta;
  L.push(`## Auto-doctor self-improvement`);
  if (ctx.draft) L.push(`> ⚠️ **Draft — needs human review** (see flags below).`);
  L.push("");
  L.push(
    `**Coverage delta:** 🟢 ${fmt(d.green)} · 🟡 ${fmt(d.yellow)} · 🔴 ${fmt(d.red)}`,
  );
  if (ctx.verify)
    L.push(
      `**Verify:** tests ${ctx.verify.tests ? "✅" : "❌"} · evals ${ctx.verify.evals ? "✅" : "❌"}`,
    );
  L.push(
    `**Coherence:** ${ctx.coherence.ok ? "✅" : `❌ ${ctx.coherence.note ?? ""}`}`,
  );
  L.push("");

  L.push(`### Findings`);
  for (const f of out.findings) {
    const tags = [
      f.reObserved ? `re-observed (seen: ${f.seen})` : "new",
      f.regression ? "⚠️ REGRESSION" : "",
      f.bsRow ?? "",
      `${f.sensorType}`,
    ]
      .filter(Boolean)
      .join(" · ");
    L.push(`- **${f.imp}** [dim ${f.dimension}] ${f.summary} — _${tags}_`);
  }
  L.push("");

  if (ctx.applied.length) {
    L.push(`### Applied (eval-gated)`);
    for (const s of [...new Set(ctx.applied)]) L.push(`- \`${s}\``);
    L.push("");
  }
  if (ctx.committedFixtures.length) {
    L.push(`### New fixtures (committed, trusted)`);
    for (const n of ctx.committedFixtures) L.push(`- \`${n}\``);
    L.push("");
  }
  if (ctx.proposeOnly.length || ctx.proposedFixtures.length) {
    L.push(`### Propose-only — human required`);
    for (const p of ctx.proposeOnly)
      L.push(`- **${p.target}** (${p.reason}): ${p.patch}`);
    for (const n of ctx.proposedFixtures)
      L.push(`- **fixture ${n}** (unrecurred class-sibling): review before trusting`);
    L.push("");
  }

  L.push(`---`);
  L.push(out.reportBody);
  return L.join("\n");
}

const fmt = (n: number): string => (n > 0 ? `+${n}` : `${n}`);
