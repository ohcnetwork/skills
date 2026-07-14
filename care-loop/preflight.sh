#!/usr/bin/env bash
# preflight.sh — Playwright pre-flight for care-loop in one round-trip (part of the care-loop skill).
#
# Folds the Step-3 backend-readiness probe AND the DB-snapshot pre-flight into one script with the
# same compact PASS/FAIL output as run_gate.sh, so 03-implement.md / 05-gate-push.md shrink to a
# single invocation line. Run it once before the first Playwright spec run of a session.
#
#   backend :9000 (bounded, never spin)  →  DB snapshot present? (seed if missing)
#
# Usage: preflight.sh [-P] [-B] [-r] [-d DUMP]
#   -P  skip the backend-readiness probe (assume BE already checked)
#   -B  backend probe ONLY — skip the DB stages (used by run_gate.sh to reuse this probe)
#   -r  if no snapshot, reset the DB (`playwright:db-reset`) instead of restore+snapshot
#   -d  local dump to seed from (sets PLAYWRIGHT_DB_SNAPSHOT for restore); default: $PLAYWRIGHT_DB_SNAPSHOT
#   (-L is internal: "lock already held, run DB stages only" — see below.)
#
# Concurrency: the DB stages touch the shared Playwright snapshot/DB (singletons across concurrent
# worktree loops), so they run under pw-lock.sh. preflight re-execs itself under the lock with -L.
# It passes pw-lock's -S (skip restore-on-acquire): this IS the snapshot-management path, so a
# restore before the snapshot exists would fail. The -B probe is read-only and stays lock-free.
#
# Exit: 0 backend up and DB snapshot ready · 1 backend down or seeding needed input · 2 usage error.
#
# Notes: the repo's DB tooling is `playwright-db.sh` via npm scripts (db-status/db-restore/
# db-snapshot/db-reset). Personal dumps stay local — never assume a colleague has one; if no
# snapshot and no dump, this stops and tells the user how to seed rather than guessing.

set -uo pipefail

# Copilot's integrated terminal is a non-login zsh that often lacks Homebrew on PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Stage logs go under the run dir (<skill-dir>/runs/<repo>-<branch>/gate/) like run_gate.sh's —
# a long db-reset writing there also counts as run-dir activity.
# Repo name from the MAIN .git (git-common-dir, absolute) so it's stable from inside a worktree;
# branch '/' flattened so the slug stays flat. Falls back to /tmp when not inside a git repo.
common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && {
  branch=$(git branch --show-current 2>/dev/null); [ -n "$branch" ] || branch="detached"
  branch=$(printf '%s' "$branch" | tr '/' '-')
  RUNDIR="$SKILL_DIR/runs/$(basename "$(dirname "$common")")-$branch"
} || RUNDIR=""
[ -n "$RUNDIR" ] && PLOG="$RUNDIR/gate" || PLOG="/tmp"
mkdir -p "$PLOG" 2>/dev/null || PLOG="/tmp"

PROBE_BE=1
PROBE_ONLY=0
DO_RESET=0
DB_LOCKED=0
DUMP="${PLAYWRIGHT_DB_SNAPSHOT:-}"

while getopts "PBrLd:" opt; do
  case "$opt" in
    P) PROBE_BE=0 ;;
    B) PROBE_ONLY=1 ;;
    r) DO_RESET=1 ;;
    L) DB_LOCKED=1 ;;
    d) DUMP="$OPTARG" ;;
    *) echo "usage: preflight.sh [-P] [-B] [-r] [-d DUMP]" >&2; exit 2 ;;
  esac
done

# Bounded backend probe — mirrors Step 3's readiness check; never an infinite spin. Skipped in the
# -L (lock-held) re-exec: the parent invocation already probed.
if [ "$PROBE_BE" = 1 ] && [ "$DB_LOCKED" = 0 ]; then
  printf 'preflight: %-18s ' "backend :9000…"
  up=0
  for _ in $(seq 1 10); do
    curl -s --max-time 3 -o /dev/null http://127.0.0.1:9000/ && { up=1; break; }
    sleep 2
  done
  if [ "$up" = 1 ]; then echo "UP"; else
    echo "DOWN"
    echo "preflight: backend not up on :9000 — start it (see CLAUDE.md), then rerun" >&2
    exit 1
  fi
fi

if [ "$PROBE_ONLY" = 1 ]; then
  echo "preflight: ALL PASSED"
  exit 0
fi

# Acquire the shared DB lock for the DB stages by re-execing under pw-lock (-S: skip its
# restore-on-acquire, since this path manages the snapshot itself). The child runs with -L.
if [ "$DB_LOCKED" = 0 ]; then
  set -- -L
  [ "$DO_RESET" = 1 ] && set -- "$@" -r
  [ -n "$DUMP" ] && set -- "$@" -d "$DUMP"
  exec "$SKILL_DIR/pw-lock.sh" -S -d "$RUNDIR" -- "$SKILL_DIR/preflight.sh" "$@"
fi

# --- DB stages (reached only with the lock held, via the -L re-exec) ---

# DB snapshot status. `playwright:db-status` exits 0 when a snapshot exists.
printf 'preflight: %-18s ' "db snapshot…"
if npm run --silent playwright:db-status >"$PLOG/preflight-dbstatus.log" 2>&1; then
  echo "PRESENT"
  echo "preflight: ALL PASSED"
  exit 0
fi

echo "MISSING"

if [ "$DO_RESET" = 1 ]; then
  printf 'preflight: %-18s ' "db reset…"
  if npm run --silent playwright:db-reset >"$PLOG/preflight-dbreset.log" 2>&1; then
    echo "DONE"; echo "preflight: ALL PASSED"; exit 0
  fi
  echo "FAIL"; tail -20 "$PLOG/preflight-dbreset.log" >&2; exit 1
fi

if [ -n "$DUMP" ]; then
  printf 'preflight: %-18s ' "db seed…"
  if PLAYWRIGHT_DB_SNAPSHOT="$DUMP" npm run --silent playwright:db-restore >"$PLOG/preflight-dbseed.log" 2>&1 \
     && npm run --silent playwright:db-snapshot >>"$PLOG/preflight-dbseed.log" 2>&1; then
    echo "DONE"; echo "preflight: ALL PASSED"; exit 0
  fi
  echo "FAIL"; tail -20 "$PLOG/preflight-dbseed.log" >&2; exit 1
fi

# No snapshot and nothing to seed from — stop and prompt, don't guess.
echo "preflight: no DB snapshot and no dump to seed from." >&2
echo "preflight: seed with  -d <local-dump>  (restore+snapshot)  or  -r  (playwright:db-reset)." >&2
exit 1
