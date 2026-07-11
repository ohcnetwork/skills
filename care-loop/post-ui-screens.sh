#!/usr/bin/env bash
# post-ui-screens.sh — push UI validation screenshots to the assets branch and post one PR comment
# (part of the care-loop skill). Run in Step 5, immediately after the push.
#
# gh cannot upload images to PR comments, so this uses the assets-branch pattern:
#   1. Commit <run-dir>/ui/round-<N>/*.png to ref care-loop-assets/<branch-flat> (never merged).
#   2. Post/update ONE PR comment ("UI validation — round N") with raw.githubusercontent URLs.
#
# Usage: post-ui-screens.sh [-d RUN_DIR] [-p PR] [-r ROUND] [-R owner/repo]
#   -d  run dir       (default: <skill-dir>/runs/<repo>-<branch>)
#   -p  PR number     (default: from state.json or current branch)
#   -r  round number  (default: from state.json or 1)
#   -R  repo          (default: ohcnetwork/care_fe)
#
# No-op (exit 0) if the ui/round-<N>/ directory doesn't exist or is empty.
# Exit: 0 posted (or no-op) · 1 push/API error · 2 usage/setup error.

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

default_run_dir() {
  local common repo branch
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  repo=$(basename "$(dirname "$common")")
  branch=$(git branch --show-current 2>/dev/null)
  [ -n "$branch" ] || branch="detached"
  branch=$(printf '%s' "$branch" | tr '/' '-')
  echo "$SKILL_DIR/runs/$repo-$branch"
}

REPO="ohcnetwork/care_fe"; RUN_DIR=""; PR=""; ROUND=""
while getopts "d:p:r:R:" o; do case "$o" in
  d) RUN_DIR="$OPTARG";; p) PR="$OPTARG";; r) ROUND="$OPTARG";; R) REPO="$OPTARG";;
  *) echo "usage: post-ui-screens.sh [-d RUN_DIR] [-p PR] [-r ROUND] [-R owner/repo]" >&2; exit 2;;
esac; done

[ -n "$RUN_DIR" ] || RUN_DIR=$(default_run_dir) || {
  echo "post-ui-screens: not in a git repo — pass -d RUN_DIR" >&2; exit 2; }

# Read state.json for defaults
STATE_JSON="$RUN_DIR/state.json"
if [ -z "$PR" ] && [ -f "$STATE_JSON" ]; then
  PR=$(python3 -c "import json,sys; d=json.load(open('$STATE_JSON')); print(d.get('pr') or '')" 2>/dev/null || echo "")
fi
if [ -z "$ROUND" ] && [ -f "$STATE_JSON" ]; then
  ROUND=$(python3 -c "import json,sys; d=json.load(open('$STATE_JSON')); print(d.get('round') or 1)" 2>/dev/null || echo "1")
fi
ROUND="${ROUND:-1}"

[ -n "$PR" ] || { echo "post-ui-screens: no PR number — pass -p or ensure state.json has pr" >&2; exit 2; }

SCREEN_DIR="$RUN_DIR/ui/round-${ROUND}"
if [ ! -d "$SCREEN_DIR" ] || [ -z "$(ls -A "$SCREEN_DIR" 2>/dev/null)" ]; then
  echo "post-ui-screens: no screenshots in $SCREEN_DIR — nothing to post"
  exit 0
fi

# Derive the assets-branch ref name from the current branch (same slug rule as observability.md)
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
[ -n "$BRANCH" ] || { echo "post-ui-screens: cannot determine current branch" >&2; exit 2; }
BRANCH_FLAT=$(printf '%s' "$BRANCH" | tr '/' '-')
ASSETS_REF="care-loop-assets/${BRANCH_FLAT}"
OWNER="${REPO%%/*}"; REPO_NAME="${REPO##*/}"

echo "post-ui-screens: pushing screenshots to ${ASSETS_REF}…"

# Use a temporary index to commit the screenshots without touching the working tree or HEAD
TMPDIR_ASSETS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ASSETS"' EXIT

# Gather all PNG files in round dir
PNG_FILES=()
while IFS= read -r -d '' f; do
  PNG_FILES+=("$f")
done < <(find "$SCREEN_DIR" -maxdepth 1 -name '*.png' -print0 | sort -z)

if [ "${#PNG_FILES[@]}" -eq 0 ]; then
  echo "post-ui-screens: no .png files found in $SCREEN_DIR — nothing to post"
  exit 0
fi

# Build a git tree with the screenshots using low-level plumbing so we never disturb the worktree
GIT_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
export GIT_DIR

# Collect blob hashes
TREE_INPUT=""
for png in "${PNG_FILES[@]}"; do
  filename="round-${ROUND}/$(basename "$png")"
  blob=$(git hash-object -w "$png")
  TREE_INPUT="${TREE_INPUT}100644 blob ${blob}\t${filename}\n"
done

TREE_HASH=$(printf '%b' "$TREE_INPUT" | git mktree)

# Check whether the assets ref already exists (for a stable parent commit)
PARENT_ARG=""
if git rev-parse --verify "refs/heads/${ASSETS_REF}" >/dev/null 2>&1; then
  PARENT_ARG="-p $(git rev-parse refs/heads/${ASSETS_REF})"
elif git rev-parse --verify "refs/remotes/origin/${ASSETS_REF}" >/dev/null 2>&1; then
  PARENT_ARG="-p $(git rev-parse refs/remotes/origin/${ASSETS_REF})"
fi

COMMIT_HASH=$(git commit-tree $PARENT_ARG -m "UI screenshots round ${ROUND} — care-loop" "$TREE_HASH")
git update-ref "refs/heads/${ASSETS_REF}" "$COMMIT_HASH"

# Push the assets ref
if git push origin "refs/heads/${ASSETS_REF}:refs/heads/${ASSETS_REF}" --force-with-lease="refs/heads/${ASSETS_REF}" 2>/dev/null \
   || git push origin "refs/heads/${ASSETS_REF}:refs/heads/${ASSETS_REF}" --force 2>/dev/null; then
  echo "post-ui-screens: PASS pushed ${ASSETS_REF}"
else
  echo "post-ui-screens: FAIL could not push ${ASSETS_REF}" >&2
  exit 1
fi

# Build the PR comment body
COMMENT_BODY="### UI validation — round ${ROUND}

Screenshots taken by care-loop across mobile / tablet / desktop breakpoints.

"

# Group PNGs by surface (prefix before the last -<width> segment). bash-3.2-safe: macOS's
# default bash has no associative arrays — build a unique sorted surface list instead.
SURFACE_LIST=$(for png in "${PNG_FILES[@]}"; do
  basename "$png" .png | sed 's/-[0-9][0-9]*$//'
done | sort -u)

for surface in $SURFACE_LIST; do
  COMMENT_BODY="${COMMENT_BODY}#### ${surface}

| Mobile (375) | Tablet (768) | Desktop (1280) |
|---|---|---|
"
  mobile_url=""; tablet_url=""; desktop_url=""
  for png in "${PNG_FILES[@]}"; do
    base=$(basename "$png" .png)
    suf=$(echo "$base" | grep -o '[0-9][0-9]*$' || echo "")
    surf=$(echo "$base" | sed 's/-[0-9][0-9]*$//')
    [ "$surf" = "$surface" ] || continue
    url="https://raw.githubusercontent.com/${OWNER}/${REPO_NAME}/${ASSETS_REF}/round-${ROUND}/$(basename "$png")"
    case "$suf" in
      375*|375) mobile_url="![$base]($url)" ;;
      768*|768) tablet_url="![$base]($url)" ;;
      1280*|1280) desktop_url="![$base]($url)" ;;
      *) desktop_url="![$base]($url)" ;;  # fallback
    esac
  done
  COMMENT_BODY="${COMMENT_BODY}| ${mobile_url:-—} | ${tablet_url:-—} | ${desktop_url:-—} |

"
done

COMMENT_BODY="${COMMENT_BODY}— care-loop 🤖"

# Check for an existing care-loop UI comment on this PR (to update rather than duplicate)
echo "post-ui-screens: posting PR comment…"
EXISTING_COMMENT_ID=$(gh api "repos/${REPO}/issues/${PR}/comments" \
  --jq '.[] | select(.body | startswith("### UI validation")) | select(.body | contains("care-loop 🤖")) | .id' \
  2>/dev/null | tail -1 || echo "")

if [ -n "$EXISTING_COMMENT_ID" ]; then
  gh api "repos/${REPO}/issues/comments/${EXISTING_COMMENT_ID}" \
    -X PATCH -f body="$COMMENT_BODY" >/dev/null
  echo "post-ui-screens: PASS updated existing comment #${EXISTING_COMMENT_ID} on PR #${PR}"
else
  gh pr comment "$PR" --repo "$REPO" --body "$COMMENT_BODY" >/dev/null
  echo "post-ui-screens: PASS posted new comment on PR #${PR}"
fi

echo "post-ui-screens: cleanup — after the PR is merged, delete the assets ref with:"
echo "  git push origin :${ASSETS_REF}"
