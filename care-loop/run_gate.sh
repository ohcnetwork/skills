#!/usr/bin/env bash
# run_gate.sh — the care-loop pre-push gate in one round-trip (part of the care-loop skill).
#
# Runs the fast gate in order and prints ONE compact pass/fail line per stage, so the
# orchestrator spends a single tool round-trip instead of a dozen — and never re-caches
# full build/test output (see "Token discipline" in SKILL.md). Full output for each stage
# is written to $LOGDIR/<stage>.log; on failure only a short grepped signal is printed.
#
#   tsc --noEmit  →  lint  →  build  →  [vitest, if present]  →  [affected Playwright specs]
#
# Stops at the first failing stage (fail fast). Exits 0 only if every run stage passed.
#
# Usage: run_gate.sh [-s "spec1 spec2 ..."] [-d LOGDIR] [-n] [-P]
#   -s  space-separated Playwright spec paths to run (default: none — Playwright skipped)
#   -d  log dir for per-stage output   (default: <run-dir>/gate — see below)
#   -n  no-build — skip `npm run build` (e.g. quick inner-loop type/lint check)
#   -P  skip the backend-readiness probe before Playwright (assume BE already checked)
#
# Default log dir: the care-loop run dir for the current repo+branch —
# <skill-dir>/runs/<repo>-<branch>/gate/. Gate logs living
# under the run dir also count as run-dir activity.
#
# Exit: 0 all stages passed · 1 a stage failed · 2 usage/setup error.

set -uo pipefail

# Copilot's integrated terminal is a non-login zsh that often lacks Homebrew on PATH,
# so node/npm/npx/gh come back "command not found". Prepend common brew bins once.
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

SPECS=""
LOGDIR=""
DO_BUILD=1
PROBE_BE=1

while getopts "s:d:nP" opt; do
  case "$opt" in
    s) SPECS="$OPTARG" ;;
    d) LOGDIR="$OPTARG" ;;
    n) DO_BUILD=0 ;;
    P) PROBE_BE=0 ;;
    *) echo "usage: run_gate.sh [-s \"specs\"] [-d LOGDIR] [-n] [-P]" >&2; exit 2 ;;
  esac
done

if [ -z "$LOGDIR" ]; then
  rundir=$(default_run_dir) || { echo "run_gate: not in a git repo — pass -d LOGDIR" >&2; exit 2; }
  LOGDIR="$rundir/gate"
fi

mkdir -p "$LOGDIR" || { echo "run_gate: cannot create $LOGDIR" >&2; exit 2; }

# Run a stage: name, logfile, then the command. On failure print a short grepped signal
# (never the whole log — that would get re-cached every turn) and fail the gate.
stage() {
  local name="$1" log="$2"; shift 2
  printf 'run_gate: %-18s ' "${name}…"
  if "$@" >"$log" 2>&1; then
    echo "PASS"
    return 0
  fi
  echo "FAIL"
  echo "run_gate: --- $name signal (see $log) ---" >&2
  grep -nE "error|Error|✗|✖|fail|Failing|Cannot|not found" "$log" 2>/dev/null | tail -20 >&2 \
    || tail -20 "$log" >&2
  exit 1
}

stage "tsc --noEmit" "$LOGDIR/tsc.log"   npx tsc --noEmit
stage "lint"         "$LOGDIR/lint.log"  npm run lint
# The production build is memory-heavy (care_fe's Docker build sets the same ceiling). Without a
# heap bound, a foreground `npm run build` has OOM'd and taken the host terminal + VS Code down
# mid-build. Cap node's heap so it can't balloon unbounded; honor a larger caller-set value.
[ "$DO_BUILD" = 1 ] && export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
[ "$DO_BUILD" = 1 ] && stage "build" "$LOGDIR/build.log" npm run build

# vitest — only if the repo actually has it wired (future fast unit layer). Detected via a
# "test:unit" / "vitest" script in package.json; absent today, so this is a no-op until added.
if node -e 'const s=require("./package.json").scripts||{};process.exit(s["test:unit"]||s.vitest?0:1)' 2>/dev/null; then
  if node -e 'process.exit((require("./package.json").scripts||{})["test:unit"]?0:1)' 2>/dev/null; then
    stage "vitest" "$LOGDIR/vitest.log" npm run test:unit
  else
    stage "vitest" "$LOGDIR/vitest.log" npm run vitest
  fi
fi

# Affected Playwright specs — only when specs were passed. Bounded backend probe first (read-only,
# lock-free) so the gate never spins on a down backend. The specs themselves run under pw-lock.sh —
# the backend :9000 + Playwright DB are shared singletons across concurrent worktree loops, so only
# one loop runs specs at a time. Restore-on-acquire (pw-lock default) gives this run a clean DB.
if [ -n "$SPECS" ]; then
  if [ "$PROBE_BE" = 1 ]; then
    "$SKILL_DIR/preflight.sh" -B || exit 1
  fi
  # shellcheck disable=SC2086 — SPECS is an intentional space-separated list of paths.
  stage "playwright" "$LOGDIR/playwright.log" \
    "$SKILL_DIR/pw-lock.sh" -d "$(dirname "$LOGDIR")" -- npx playwright test $SPECS
fi

echo "run_gate: ALL PASSED"
