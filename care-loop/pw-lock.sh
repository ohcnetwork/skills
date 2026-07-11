#!/usr/bin/env bash
# pw-lock.sh — global mutex for the shared Playwright backend/DB (part of the care-loop skill).
#
# Every loop runs in its own git worktree, but the backend on :9000 and the Playwright DB snapshot
# are shared singletons. This serializes access so only one loop touches the DB / runs specs at a
# time. Wraps an arbitrary command: acquires the lock, restores the DB snapshot for a clean start
# (unless -S), runs the command, releases the lock, and exits with the command's status. The wait
# is a token-free sleep loop that heartbeats to the run dir so watch-agents.sh won't flag a stall.
#
# Usage: pw-lock.sh [-t TIMEOUT_S] [-i INTERVAL_S] [-d RUN_DIR] [-S] [--] <command...>
#        pw-lock.sh -H [-t TIMEOUT_S] [-d RUN_DIR] [-S]     # acquire and HOLD (no command)
#        pw-lock.sh -U                                       # release a held lock
#   -t  max seconds to wait for the lock   (default 1800)
#   -i  poll interval while waiting         (default 5)
#   -d  run dir for the heartbeat log       (default: derived <skill-dir>/runs/<repo>-<branch>)
#   -S  SKIP the restore-on-acquire (for the snapshot-bootstrap path in preflight.sh, where no
#       snapshot exists yet so a restore would fail). Everything else wants the clean-DB restore.
#   -H  HOLD mode — acquire the lock, leave a background holder process, and exit 0. For
#       sessions that aren't a single shell command (e.g. Step 4.8's browser-MCP tool calls,
#       which can't be wrapped in `pw-lock.sh -- cmd`). ALWAYS pair with -U when done; if the
#       holder dies unreleased, the stale-pid steal reclaims the lock — that's the safety net,
#       not the plan.
#   -U  RELEASE a lock held via -H (kills the holder, removes the lock). No-op if not held.
#   --  optional; everything after is the command to run under the lock
#
# Restore-on-acquire (default): whoever acquires runs `npm run playwright:db-restore` (~2s) FIRST —
# never trust the previous holder to have cleaned up (specs mutate the DB; a stolen stale lock may
# have died mid-mutation). This also makes stale-lock stealing safe with no extra bookkeeping.
#
# Exit: the wrapped command's status · 1 restore failed · 2 usage · 124 lock-wait timeout.

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="$SKILL_DIR/runs/.playwright.lock"

# Same derivation as the other bundled scripts (see run_gate.sh / observability.md): repo name from
# the MAIN .git so it's stable inside a worktree; branch '/' flattened. Empty outside a git repo.
default_run_dir() {
  local common repo branch
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  repo=$(basename "$(dirname "$common")")
  branch=$(git branch --show-current 2>/dev/null)
  [ -n "$branch" ] || branch="detached"
  branch=$(printf '%s' "$branch" | tr '/' '-')
  echo "$SKILL_DIR/runs/$repo-$branch"
}

TIMEOUT=1800; INTERVAL=5; RUN_DIR=""; SKIP_RESTORE=0; HOLD=0; RELEASE=0
while getopts "t:i:d:SHU" opt; do
  case "$opt" in
    t) TIMEOUT="$OPTARG" ;;
    i) INTERVAL="$OPTARG" ;;
    d) RUN_DIR="$OPTARG" ;;
    S) SKIP_RESTORE=1 ;;
    H) HOLD=1 ;;
    U) RELEASE=1 ;;
    *) echo "usage: pw-lock.sh [-t TIMEOUT] [-i INTERVAL] [-d RUN_DIR] [-S] [--] <command...> | -H | -U" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))

# -U: release a held lock and exit. Safe to call when nothing is held.
if [ "$RELEASE" = 1 ]; then
  if [ -d "$LOCK" ]; then
    holder=$(cat "$LOCK/pid" 2>/dev/null || echo "")
    [ -n "$holder" ] && kill "$holder" 2>/dev/null
    rm -rf "$LOCK" 2>/dev/null
    echo "pw-lock: released (holder pid ${holder:-?})"
  else
    echo "pw-lock: no lock held — nothing to release"
  fi
  exit 0
fi

if [ "$HOLD" = 0 ] && [ "$#" -eq 0 ]; then
  echo "pw-lock: no command given (use -H to acquire-and-hold without one)" >&2; exit 2
fi

[ -n "$RUN_DIR" ] || RUN_DIR=$(default_run_dir 2>/dev/null) || RUN_DIR=""
HB=""
if [ -n "$RUN_DIR" ] && mkdir -p "$RUN_DIR/agents" 2>/dev/null; then HB="$RUN_DIR/agents/pw-lock.log"; fi
hb() { [ -n "$HB" ] && echo "$1" >>"$HB"; return 0; }

mkdir -p "$SKILL_DIR/runs" 2>/dev/null || { echo "pw-lock: cannot create $SKILL_DIR/runs" >&2; exit 2; }

acquired=0
release() { [ "$acquired" = 1 ] && rm -rf "$LOCK" 2>/dev/null; return 0; }
trap release EXIT INT TERM

# Acquire — mkdir is atomic, so it doubles as the lock primitive.
deadline=$(( $(date +%s) + TIMEOUT ))
while :; do
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$$" >"$LOCK/pid"; acquired=1; break
  fi
  holder=$(cat "$LOCK/pid" 2>/dev/null || echo "")
  # Steal a stale lock whose holder pid is dead (crashed loop / killed session).
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    hb "STATUS: stealing stale pw-lock from dead pid $holder"
    rm -rf "$LOCK" 2>/dev/null
    continue
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "pw-lock: timed out after ${TIMEOUT}s waiting for $LOCK (held by pid ${holder:-?})" >&2
    exit 124
  fi
  hb "HEARTBEAT $(date -u +%Y-%m-%dT%H:%M:%SZ) — waiting for pw-lock (held by ${holder:-?})"
  sleep "$INTERVAL"
done

# Restore-on-acquire — clean DB before the command (unless the snapshot-bootstrap path opted out).
if [ "$SKIP_RESTORE" = 0 ]; then
  hb "STATUS: pw-lock acquired — restoring DB snapshot"
  if ! npm run --silent playwright:db-restore >/dev/null 2>&1; then
    echo "pw-lock: db-restore failed after acquiring lock" >&2
    exit 1
  fi
fi

hb "STATUS: pw-lock acquired — running: $*"
"$@"
status=$?
hb "DONE pw-lock command exited $status"
exit $status
