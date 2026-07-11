#!/usr/bin/env bash
# collect-feedback.sh — pre-digest PR bot feedback for care-loop Step 6a (part of the skill).
#
# Today 6a (Opus) runs `gh pr view --json reviews,comments` + the pulls-comments API and parses raw
# JSON. Bot comments are heavily padded (CodeRabbit collapsible <details> / "prompt for AI agents"
# blobs / walkthrough tables; Greptile summary chrome) and land in Opus context verbatim, re-cached
# every turn. This script fetches, strips the HTML/chrome, GROUPS by file+line (every comment kept —
# co-located comments from different bots each keep their own thread id, so "reply to every thread"
# stays satisfiable), tags resolved threads with [resolved], and writes a compact
# (author, path:line, thread-id, trimmed body) list so 6a starts from judgment, not parsing.
# Same move as run_gate.sh, applied to the other verbose boundary.
#
# Usage: collect-feedback.sh [-p PR] [-d STATEDIR] [-R owner/repo]
#   -p  PR number     (default: PR for current branch via `gh pr view`)
#   -d  run dir       (default: the run dir for the current repo+branch,
#                      <skill-dir>/runs/<repo>-<branch> — see guides/observability.md)
#                     — writes $STATEDIR/feedback.md
#   -R  repo          (default: ohcnetwork/care_fe)
#
# Exit: 0 wrote feedback.md (even if empty) · 2 usage/gh error. Requires gh + jq.

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Canonical run dir for the current repo+branch (single default shared by all care-loop
# scripts — see guides/observability.md). Derives the repo name from the MAIN .git
# (git-common-dir, absolute) so it's stable from inside a worktree; flattens '/' in the branch
# so the slug and the runs/*/state.json fleet glob stay flat. Empty when not inside a git repo.
default_run_dir() {
  local common repo branch
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  repo=$(basename "$(dirname "$common")")
  branch=$(git branch --show-current 2>/dev/null)
  [ -n "$branch" ] || branch="detached"
  branch=$(printf '%s' "$branch" | tr '/' '-')
  echo "$SKILL_DIR/runs/$repo-$branch"
}

REPO="ohcnetwork/care_fe"; STATEDIR=""; PR=""
while getopts "p:d:R:" o; do case "$o" in
  p) PR="$OPTARG";; d) STATEDIR="$OPTARG";; R) REPO="$OPTARG";;
  *) echo "usage: collect-feedback.sh [-p PR] [-d STATEDIR] [-R owner/repo]" >&2; exit 2;;
esac; done

command -v jq >/dev/null 2>&1 || { echo "collect-feedback: jq required" >&2; exit 2; }
[ -n "$PR" ] || PR=$(gh pr view --json number --jq .number 2>/dev/null) || {
  echo "collect-feedback: no PR for current branch and no -p given" >&2; exit 2; }
[ -n "$STATEDIR" ] || STATEDIR=$(default_run_dir) || {
  echo "collect-feedback: not in a git repo — pass -d STATEDIR" >&2; exit 2; }

mkdir -p "$STATEDIR" || { echo "collect-feedback: cannot create $STATEDIR" >&2; exit 2; }
OUT="$STATEDIR/feedback.md"

# Only bot authors — the human's own comments aren't triaged here.
BOT_RE='\\[bot\\]|Copilot|coderabbit|greptile|codex'

OWNER="${REPO%%/*}"; NAME="${REPO##*/}"

# Resolved review threads — one GraphQL call (REST doesn't expose isResolved). Produces a CSV of
# comment databaseIds belonging to resolved threads; matching entries below get an inline
# [resolved] tag so 6a can skip them without re-fetching. First 100 threads / 50 comments each is
# plenty for a loop-sized PR; on GraphQL failure the set is empty (nothing gets tagged — safe).
RESOLVED_IDS=$(gh api graphql \
  -f query='query($owner:String!,$name:String!,$pr:Int!){
    repository(owner:$owner,name:$name){ pullRequest(number:$pr){
      reviewThreads(first:100){ nodes{ isResolved comments(first:50){ nodes{ databaseId } } } } } } }' \
  -f owner="$OWNER" -f name="$NAME" -F pr="$PR" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved) | .comments.nodes[].databaseId] | join(",")' \
  2>/dev/null || echo "")

resolved_tag() { # $1 = comment id → prints " [resolved]" when in a resolved thread
  case ",$RESOLVED_IDS," in *",$1,"*) printf ' [resolved]';; esac
}

# Strip bot padding to the human-readable core: drop <details> blocks (collapsible chrome and the
# "prompt for AI agents" blobs live there), HTML comments, remaining tags, table rules and image
# refs; collapse blank runs; cap length so one comment can't dominate the digest.
trim_body() {
  awk '
    /<details/ {indetail++; next}
    /<\/details>/ {if(indetail>0)indetail--; next}
    indetail>0 {next}
    {print}
  ' \
  | sed -E 's/<!--.*-->//g; s/<[^>]+>//g; s/!\[[^]]*\]\([^)]*\)//g' \
  | sed -E '/^[[:space:]]*\|?[[:space:]]*[-:| ]+[[:space:]]*\|?[[:space:]]*$/d' \
  | grep -viE '^[[:space:]]*(prompt for ai agents|walkthrough|📝|🧩|<summary)' \
  | awk 'NF{blank=0; print; c++} !NF{if(!blank && c>0)print; blank=1} c>=8{exit}' \
  | cut -c1-600
}

: > "$OUT"
{
  echo "# PR #$PR — pre-digested bot feedback   ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
  echo "# (author · path:line · thread-id · trimmed body) — grouped by file+line; every comment"
  echo "# kept (co-located bots each keep their thread id). [resolved] threads are skippable."
  echo "# Source of truth is the live thread; this is the triage starting point (see 06a-triage.md)."
  echo
} >> "$OUT"

# 1) Inline review comments — the actionable ones (have path + line + a resolvable thread id).
#    Grouped by path:line; ALL comments kept (dropping co-located ones would leave threads with
#    no verdict and no reply, breaking the Step-7 reply-to-every-thread exit condition).
echo "## Inline comments" >> "$OUT"
prev_loc=""
gh api "repos/$REPO/pulls/$PR/comments" --paginate \
  --jq ".[] | select(.user.login|test(\"$BOT_RE\";\"i\")) |
        [.user.login, (.path//\"-\"), ((.line//.original_line)|tostring), (.id|tostring), (.body|@base64)] | @tsv" \
  2>/dev/null \
| sort -t $'\t' -k2,2 -k3,3n -k4,4n \
| while IFS=$'\t' read -r author path line tid b64; do
    loc="$path:$line"
    if [ "$loc" != "$prev_loc" ]; then echo "- \`$loc\`" >> "$OUT"; prev_loc="$loc"; fi
    body=$(printf '%s' "$b64" | base64 --decode 2>/dev/null | trim_body)
    { echo "  - **$author** (thread $tid)$(resolved_tag "$tid")"
      printf '%s\n' "$body" | sed 's/^/      /'; echo; } >> "$OUT"
  done

# 2) Bot summary / top-level issue comments (Greptile summary, CodeRabbit walkthrough, etc.).
echo "## Summary comments" >> "$OUT"
gh api "repos/$REPO/issues/$PR/comments" --paginate \
  --jq ".[] | select(.user.login|test(\"$BOT_RE\";\"i\")) |
        [.user.login, (.id|tostring), (.body|@base64)] | @tsv" \
  2>/dev/null \
| while IFS=$'\t' read -r author tid b64; do
    body=$(printf '%s' "$b64" | base64 --decode 2>/dev/null | trim_body)
    { echo "- **$author** (comment $tid)"; printf '%s\n' "$body" | sed 's/^/    /'; echo; } >> "$OUT"
  done

n=$(grep -cE '\((thread|comment) ' "$OUT" 2>/dev/null || echo 0)
echo "collect-feedback: wrote $OUT ($n bot item(s)). CI checks + our /care-review findings are NOT here — add them in 6a."
