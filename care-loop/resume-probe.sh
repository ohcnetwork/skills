#!/usr/bin/env bash
# resume-probe.sh — one-round-trip ground-truth digest for a care-loop resume (part of the skill).
#
# A host session (Copilot) can die mid-step. On re-invocation the orchestrator must NOT trust
# state.json alone — it names the step's start, not its progress. This probe reports reality in a
# few compact lines so guides/00-resume.md's decision table can pick the true re-entry step without
# the model running (and re-caching) five separate git/gh commands. Same token move as run_gate.sh.
#
# Usage: resume-probe.sh [-p PR] [-d RUN_DIR] [-R owner/repo]
#   -p  PR number   (default: from state.json "pr", else `gh pr view` for the current branch)
#   -d  run dir     (default: derived <skill-dir>/runs/<repo>-<branch-flat>)
#   -R  repo        (default: ohcnetwork/care_fe)
#
# Prints (one per line): tree, local-vs-pushed, pr-head/local-head, bots-at-head, ci, artifacts.
# Exit: 0 digest printed · 2 usage/setup (not in a git repo and no -d, or gh/jq missing).

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if command -v timeout >/dev/null 2>&1; then GHTO="timeout 30"
elif command -v gtimeout >/dev/null 2>&1; then GHTO="gtimeout 30"
else GHTO=""; fi
ghc() { $GHTO gh "$@"; }

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Same derivation as the other bundled scripts (see run_gate.sh / observability.md).
default_run_dir() {
  local common repo branch
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  repo=$(basename "$(dirname "$common")")
  branch=$(git branch --show-current 2>/dev/null)
  [ -n "$branch" ] || branch="detached"
  branch=$(printf '%s' "$branch" | tr '/' '-')
  echo "$SKILL_DIR/runs/$repo-$branch"
}

REPO="ohcnetwork/care_fe"; RUN_DIR=""; PR=""
while getopts "p:d:R:" o; do case "$o" in
  p) PR="$OPTARG";; d) RUN_DIR="$OPTARG";; R) REPO="$OPTARG";;
  *) echo "usage: resume-probe.sh [-p PR] [-d RUN_DIR] [-R owner/repo]" >&2; exit 2;;
esac; done

[ -n "$RUN_DIR" ] || RUN_DIR=$(default_run_dir) || {
  echo "resume-probe: not in a git repo — pass -d RUN_DIR" >&2; exit 2; }
STATE="$RUN_DIR/state.json"

# PR: -p, else state.json "pr" (may be a number or a URL — take the trailing digits), else gh.
if [ -z "$PR" ] && [ -f "$STATE" ]; then
  PR=$(grep -o '"pr"[[:space:]]*:[[:space:]]*"\{0,1\}[^",}]*' "$STATE" 2>/dev/null \
       | grep -oE '[0-9]+' | tail -1)
fi
[ -n "$PR" ] || PR=$(ghc pr view --json number --jq .number 2>/dev/null || echo "")

echo "resume-probe: run dir $RUN_DIR  (PR ${PR:-unknown} on $REPO)"

# 1) Working tree — dirty means a maker/6b applied edits that were never committed.
dirty=$(git status --porcelain 2>/dev/null | grep -cvE '^\?\?' || true)
if [ "${dirty:-0}" -gt 0 ]; then echo "tree:      dirty ($dirty tracked file(s) modified)"
else echo "tree:      clean"; fi

local_head=$(git rev-parse HEAD 2>/dev/null || echo "")

# 2/3) Local head vs PR head — is local work pushed?
pr_head=""
[ -n "$PR" ] && pr_head=$(ghc pr view "$PR" --repo "$REPO" --json headRefOid --jq .headRefOid 2>/dev/null || echo "")
if [ -z "$pr_head" ]; then
  echo "pushed:    unknown (no PR head — PR not found or gh failed)"
elif [ "$pr_head" = "$local_head" ]; then
  echo "pushed:    yes (PR head == local HEAD ${local_head:0:9})"
elif git cat-file -e "$pr_head" 2>/dev/null; then
  if git merge-base --is-ancestor "$pr_head" "$local_head" 2>/dev/null; then
    ahead=$(git rev-list --count "$pr_head..$local_head" 2>/dev/null || echo "?")
    echo "pushed:    NO — local ahead by $ahead commit(s) (unpushed work)"
  else
    echo "pushed:    diverged (local ${local_head:0:9} not a descendant of PR head ${pr_head:0:9})"
  fi
else
  echo "pushed:    PR head ${pr_head:0:9} not in local repo (fetch needed to compare)"
fi

# 4) Which bots have reviewed the CURRENT local head (a review at head == that bot is up to date).
if [ -n "$PR" ] && [ -n "$local_head" ]; then
  bots=$(ghc api "repos/$REPO/pulls/$PR/reviews" --paginate \
    --jq ".[] | select(.commit_id==\"$local_head\") | .user.login" 2>/dev/null \
    | sort -u | paste -sd, - 2>/dev/null || echo "")
  echo "bots-at-head: ${bots:-none}"
else
  echo "bots-at-head: unknown"
fi

# 5) CI conclusion at a glance.
if [ -n "$PR" ]; then
  ci=$(ghc pr checks "$PR" --repo "$REPO" --json bucket \
    --jq 'if any(.[];.bucket=="fail") then "fail" elif any(.[];.bucket=="pending") then "pending" elif length==0 then "none" else "pass" end' \
    2>/dev/null || echo "unknown")
  echo "ci:        ${ci:-unknown}"
else
  echo "ci:        unknown"
fi

# 6) Run-dir artifacts — which stage files exist (tells 6a-vs-6b-vs-5 apart).
present=""
for f in criteria.md baseline.md decisions.md intent.md feedback.md verdicts.md declined.md replies.md; do
  [ -f "$RUN_DIR/$f" ] && present="$present $f"
done
posted=$(ls "$RUN_DIR"/replies-r*.posted.md 2>/dev/null | wc -l | tr -d ' ')
[ "${posted:-0}" -gt 0 ] && present="$present replies-posted:$posted"
echo "artifacts:${present:- none}"
