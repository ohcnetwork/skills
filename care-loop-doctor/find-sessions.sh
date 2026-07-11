#!/usr/bin/env bash
# find-sessions.sh — Tier-A evidence discovery for care-loop-doctor (part of the skill).
#
# VS Code stores full Copilot chat sessions on disk — no manual UI export needed:
#   ~/Library/Application Support/Code/User/workspaceStorage/<hash>/chatSessions/*.jsonl
# The <hash> ↔ workspace mapping lives in each <hash>/workspace.json ("folder": "file:///…").
# This script resolves the workspace(s) for a repo and prints matching session file paths,
# newest-first, one per line (paths only — feed them to digest-session.py).
#
# Usage: find-sessions.sh [-r REPO_MATCH] [-n LIMIT] [-d SINCE_DAYS]
#   -r  substring to match in the workspace folder path (default: basename of the git toplevel
#       of cwd, e.g. care_fe; use "" to list ALL workspaces)
#   -n  max session files to print          (default 10)
#   -d  only sessions modified in the last N days (default 14; 0 = no age filter)
#
# Exit: 0 printed ≥1 path · 1 none found · 2 usage/storage-dir missing.

set -uo pipefail

STORE="$HOME/Library/Application Support/Code/User/workspaceStorage"
REPO=""
LIMIT=10
DAYS=14

while getopts "r:n:d:" o; do case "$o" in
  r) REPO="$OPTARG";;
  n) LIMIT="$OPTARG";;
  d) DAYS="$OPTARG";;
  *) echo "usage: find-sessions.sh [-r REPO_MATCH] [-n LIMIT] [-d SINCE_DAYS]" >&2; exit 2;;
esac; done

[ -d "$STORE" ] || { echo "find-sessions: no VS Code workspaceStorage at $STORE" >&2; exit 2; }

if [ -z "$REPO" ]; then
  top=$(git rev-parse --show-toplevel 2>/dev/null) && REPO=$(basename "$top") || REPO=""
fi

# workspaces matching the repo (or all, when no match string)
hashes=()
for wj in "$STORE"/*/workspace.json; do
  [ -f "$wj" ] || continue
  if [ -z "$REPO" ] || grep -q "$REPO" "$wj" 2>/dev/null; then
    hashes+=("$(dirname "$wj")")
  fi
done
[ ${#hashes[@]} -gt 0 ] || { echo "find-sessions: no workspace matches '$REPO'" >&2; exit 1; }

# newest-first session files across those workspaces, age-filtered
tmp="$(mktemp)"
for h in "${hashes[@]}"; do
  [ -d "$h/chatSessions" ] || continue
  if [ "$DAYS" -gt 0 ] 2>/dev/null; then
    find "$h/chatSessions" -name '*.jsonl' -mtime "-${DAYS}d" 2>/dev/null \
      || find "$h/chatSessions" -name '*.jsonl' -mtime "-$DAYS" 2>/dev/null
  else
    find "$h/chatSessions" -name '*.jsonl' 2>/dev/null
  fi
done | while IFS= read -r f; do
  printf '%s\t%s\n' "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)" "$f"
done | sort -rn | head -n "$LIMIT" | cut -f2- > "$tmp"

if [ -s "$tmp" ]; then
  cat "$tmp"; rm -f "$tmp"; exit 0
fi
rm -f "$tmp"
echo "find-sessions: no chat sessions found (repo match '$REPO', last ${DAYS}d)" >&2
exit 1
