#!/usr/bin/env bash
# watch-agents.sh — token-free watchdog for care-loop agents (part of the care-loop skill).
#
# Blocks in the terminal (sleep loop; no model tokens) and returns the MOMENT an agent needs
# attention, so a stuck agent becomes a user prompt instead of a silent hang.
#
# Agents write structured lines to $DIR/agents/<agent>.log (the agents/ subdir keeps the
# orchestrator's loop.log and the gate/ logs out of the all-DONE check), e.g.:
#   HEARTBEAT 2026-07-08T18:40:00Z
#   STATUS: implementing quantity clear
#   NEEDS_INPUT: which Jira ticket for this branch?
#   BLOCKED: backend not up on :9000
#   DONE
#
# Returns (exit 0, prints the reason) on the FIRST of:
#   - a NEEDS_INPUT: or BLOCKED: marker in any agent log — NEW markers only: per-file byte
#     offsets are persisted to $DIR/.watch-cursor on exit, so a marker that was already
#     surfaced (and answered) never re-triggers the next invocation,
#   - a stall (no file written anywhere under $DIR within STALL seconds — gate/ logs written
#     mid-build count as activity, so a long run_gate stage isn't a false stall),
#   - all agents ending in DONE.
# Exit 1 on overall timeout, 2 on usage error.
#
# Usage: watch-agents.sh [-d DIR] [-s STALL_SECS] [-i INTERVAL] [-t TIMEOUT]
#   -d  run dir            (default: the run dir for the current repo+branch,
#                           <skill-dir>/runs/<repo>-<branch> — see guides/observability.md)
#   -s  stall threshold s  (default: 900 — no activity across the run dir => stalled;
#                           agents should HEARTBEAT before starting a long command)
#   -i  poll interval s    (default: 30)
#   -t  overall timeout s  (default: 3600; 0 = no cap)

set -uo pipefail

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

DIR=""; STALL=900; INTERVAL=30; TIMEOUT=3600
while getopts "d:s:i:t:" o; do case "$o" in
  d) DIR="$OPTARG";; s) STALL="$OPTARG";; i) INTERVAL="$OPTARG";; t) TIMEOUT="$OPTARG";;
  *) echo "usage: $0 [-d DIR] [-s STALL] [-i INTERVAL] [-t TIMEOUT]" >&2; exit 2;;
esac; done
[ -n "$DIR" ] || DIR=$(default_run_dir) || {
  echo "watch-agents: not in a git repo — pass -d DIR" >&2; exit 2; }

CURSOR="$DIR/.watch-cursor"

mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }
fsize() { wc -c <"$1" 2>/dev/null | tr -d ' ' || echo 0; }

# Byte offset already surfaced for a file (0 if never seen). Kept bash-3.2-safe (no
# associative arrays — macOS ships bash 3.2).
get_off() {
  awk -F'\t' -v f="$1" '$1==f{print $2; found=1} END{if(!found)print 0}' "$CURSOR" 2>/dev/null || echo 0
}

# Persist current end-of-file offsets so everything printed up to now counts as surfaced.
write_cursor() {
  local f tmp="$CURSOR.tmp"
  : > "$tmp"
  for f in "$@"; do printf '%s\t%s\n' "$f" "$(fsize "$f")" >> "$tmp"; done
  mv "$tmp" "$CURSOR"
}

deadline=$(( $(date +%s) + TIMEOUT ))
echo "watch-agents: watching $DIR (stall ${STALL}s, interval ${INTERVAL}s)"

while :; do
  logs=()
  for f in "$DIR"/agents/*.log; do [ -e "$f" ] && logs+=("$f"); done

  if [ ${#logs[@]} -gt 0 ]; then
    # 1) attention markers — NEW ones only (past the persisted cursor); surface immediately
    hits=""
    for f in "${logs[@]}"; do
      off=$(get_off "$f")
      h=$(tail -c +"$((off + 1))" "$f" 2>/dev/null | grep -E "NEEDS_INPUT:|BLOCKED:" | tail -n 5 || true)
      [ -n "$h" ] && hits="${hits}$(basename "$f"): $h"$'\n'
    done
    if [ -n "$hits" ]; then
      echo "watch-agents: ATTENTION —"; printf '%s' "$hits"
      write_cursor "${logs[@]}"
      exit 0
    fi

    # 2) all agents DONE? (grep the whole file, not just the tail — a trailing HEARTBEAT written
    #    after DONE would otherwise scroll DONE out of view and the watchdog would never see it.)
    all_done=1
    for f in "${logs[@]}"; do grep -q "^DONE" "$f" 2>/dev/null || { all_done=0; break; }; done
    if [ "$all_done" = 1 ]; then
      echo "watch-agents: all agents DONE"
      write_cursor "${logs[@]}"
      exit 0
    fi

    # 3) stall — nothing written anywhere under the run dir within STALL seconds. Recursive so
    #    gate/*.log written mid-build counts as activity; hidden files (.watch-cursor) excluded.
    now=$(date +%s); newest=0
    while IFS= read -r f; do
      m=$(mtime "$f"); [ "$m" -gt "$newest" ] && newest=$m
    done < <(find "$DIR" -type f ! -name ".*" 2>/dev/null)
    if [ "$newest" -gt 0 ] && [ $(( now - newest )) -ge "$STALL" ]; then
      echo "watch-agents: STALLED — no activity for $(( now - newest ))s. Last lines:"
      for f in "${logs[@]}"; do echo "--- $(basename "$f")"; tail -n 3 "$f" 2>/dev/null; done
      write_cursor "${logs[@]}"
      exit 0
    fi
  fi

  if [ "$TIMEOUT" -gt 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then
    echo "watch-agents: TIMEOUT after ${TIMEOUT}s" >&2; exit 1
  fi
  sleep "$INTERVAL"
done
