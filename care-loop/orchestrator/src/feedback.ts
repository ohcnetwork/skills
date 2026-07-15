// feedback.ts — pre-digest PR bot feedback for Step 6a, ported from collect-feedback.sh onto the
// GitHubApi boundary (no gh, no jq, no base64/awk/sed pipeline). Fetches inline + summary bot
// comments, strips the CodeRabbit/Greptile HTML chrome, groups inline comments by file+line, tags
// [resolved] threads, and renders a compact digest so 6a starts from judgment, not parsing.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GitHubApi, PrComment } from "./github.js";

const BOT_RE = /\[bot\]|Copilot|coderabbit|greptile|codex/i;
export const isBot = (login: string): boolean => BOT_RE.test(login);

const CHROME_RE = /^\s*(prompt for ai agents|walkthrough|📝|🧩|<summary)/i;
const TABLE_RULE_RE = /^\s*\|?\s*[-:|\s]+\s*\|?\s*$/;

/**
 * Strip bot padding to the human-readable core: drop <details> blocks (collapsible chrome + the
 * "prompt for AI agents" blobs), HTML comments/tags, image refs, table rules and chrome lines;
 * keep at most 8 non-empty lines; cap at 600 chars. Pure — the awk/sed pipeline as string ops.
 */
export function trimBody(body: string): string {
  const out: string[] = [];
  let detail = 0;
  let kept = 0;
  let lastBlank = false;

  for (const raw of body.split("\n")) {
    if (/<details/i.test(raw)) {
      detail++;
      continue;
    }
    if (/<\/details>/i.test(raw)) {
      if (detail > 0) detail--;
      continue;
    }
    if (detail > 0) continue;

    const cleaned = raw
      .replace(/<!--.*?-->/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
      .replace(/<[^>]+>/g, ""); // remaining tags

    if (TABLE_RULE_RE.test(cleaned)) continue;
    if (CHROME_RE.test(cleaned)) continue;

    if (cleaned.trim().length === 0) {
      if (!lastBlank && kept > 0) out.push("");
      lastBlank = true;
      continue;
    }
    out.push(cleaned);
    lastBlank = false;
    if (++kept >= 8) break;
  }

  return out.join("\n").slice(0, 600).trimEnd();
}

export interface FeedbackInputs {
  pr: number;
  reviewComments: PrComment[]; // inline (have path/line/id)
  issueComments: PrComment[]; // summary/top-level (have id)
  resolvedIds: number[];
  now?: string;
}

/** Render the feedback.md digest (pure). */
export function renderFeedback(inp: FeedbackInputs): {
  markdown: string;
  count: number;
} {
  const resolved = new Set(inp.resolvedIds);
  const now = inp.now ?? new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const L: string[] = [
    `# PR #${inp.pr} — pre-digested bot feedback   (${now})`,
    "# (author · path:line · thread-id · trimmed body) — grouped by file+line; every comment",
    "# kept (co-located bots each keep their thread id). [resolved] threads are skippable.",
    "# Source of truth is the live thread; this is the triage starting point (see the care-triager skill).",
    "",
  ];
  let count = 0;

  // 1) Inline comments — actionable (path + line + resolvable thread id). Group by path:line,
  //    sorted by path, then line, then id; ALL bot comments kept (co-located threads each need a
  //    verdict + reply for the Step-7 reply-to-every-thread exit).
  L.push("## Inline comments");
  const inline = inp.reviewComments
    .filter((c) => isBot(c.user))
    .sort(
      (a, b) =>
        (a.path ?? "").localeCompare(b.path ?? "") ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.id ?? 0) - (b.id ?? 0),
    );
  let prevLoc = "";
  for (const c of inline) {
    const loc = `${c.path ?? "-"}:${c.line ?? "-"}`;
    if (loc !== prevLoc) {
      L.push(`- \`${loc}\``);
      prevLoc = loc;
    }
    const tag = c.id !== undefined && resolved.has(c.id) ? " [resolved]" : "";
    L.push(`  - **${c.user}** (thread ${c.id ?? "-"})${tag}`);
    L.push(indent(trimBody(c.body), 6));
    L.push("");
    count++;
  }

  // 2) Summary / top-level bot comments (Greptile summary, CodeRabbit walkthrough, …).
  L.push("## Summary comments");
  for (const c of inp.issueComments.filter((c) => isBot(c.user))) {
    L.push(`- **${c.user}** (comment ${c.id ?? "-"})`);
    L.push(indent(trimBody(c.body), 4));
    L.push("");
    count++;
  }

  return { markdown: L.join("\n") + "\n", count };
}

function indent(text: string, n: number): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l.length ? pad + l : l))
    .join("\n");
}

/** Fetch + render + write feedback.md. CI checks and our own /care-review findings are NOT here. */
export async function collectFeedback(
  gh: GitHubApi,
  opts: { pr: number; runDir?: string },
): Promise<{ markdown: string; count: number }> {
  const [reviewComments, issueComments, resolvedIds] = await Promise.all([
    gh.listReviewComments(opts.pr),
    gh.listIssueComments(opts.pr),
    gh.listResolvedReviewCommentIds(opts.pr),
  ]);
  const rendered = renderFeedback({
    pr: opts.pr,
    reviewComments,
    issueComments,
    resolvedIds,
  });
  if (opts.runDir) {
    mkdirSync(opts.runDir, { recursive: true });
    writeFileSync(join(opts.runDir, "feedback.md"), rendered.markdown);
  }
  return rendered;
}
