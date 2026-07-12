#!/usr/bin/env bash
# write-state.sh — the ONLY way care-loop writes state.json (part of the care-loop skill).
#
# state.json drifted from the documented schema in every live run, even after the guides said
# "exact, not indicative" (care-loop-doctor IMP-3) — prose loses. This script generates it:
# validated keys, canonical types, step vocabulary enforced, git-derived defaults, atomic write.
# Fields not passed are carried forward from the existing state.json, so a step transition is
# just:  write-state.sh -s 6a
#
# Usage: write-state.sh -s STEP [-t TASK] [-T TIER] [-p PR_NUMBER] [-r ROUND] [-H HEAD_SHA]
#                       [-l LAST_REVIEWED_SHA] [-R OWNER/REPO] [-b BRANCH] [-w WORKTREE] [-d RUN_DIR]
#   -s  step (required) — one of the vocabulary below
#   -t  task one-liner        (required on the FIRST write; carried forward after)
#   -T  tier                  trivial|standard|complex
#   -p  PR number             INTEGER only (never a URL)
#   -r  round                 integer
#   -H  head sha              (default: git rev-parse HEAD)
#   -l  last_reviewed_sha
#   -R  repo                  full owner/name (default: existing value, else ohcnetwork/care_fe)
#   -b  branch                (default: current git branch)
#   -w  worktree              (default: git toplevel)
#   -d  run dir               (default: derived <skill-dir>/runs/<repo>-<branch-flat>)
#
# Step vocabulary (settled + -ing in-progress markers + terminal) — the canonical list is the
# STEP_VOCAB var below; print it with `write-state.sh --vocab`:
#   1 2 3 3-implementing 4a 4b 4c 4c-validating 5 5-committing 5-pushing 5-await 5-replying
#   6a 6b 6b-applying 7 merged aborted
#
# updated_at is always set to now. Write is atomic (.state.json.tmp + mv).
# Legacy/pre-schema state carried forward from an existing file is MIGRATED, not rejected (F1):
#   URL/string `pr` -> trailing integer (prefers a legacy `pr_number`), ad-hoc keys dropped,
#   missing `task` synthesized from the branch. Each fix prints a `migrated:` line to stderr.
#   Hard validation still applies to the NEW values passed on this call.
# Exit: 0 written · 2 validation/usage error (message names the offending field).

set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Step vocabulary — the SINGLE source (F2). observability.md and 00-resume.md reference this via
# `write-state.sh --vocab` instead of maintaining their own copies (which had drifted).
STEP_VOCAB="1 2 3 3-implementing 4a 4b 4c 4c-validating 5 5-committing 5-pushing 5-await 5-replying 6a 6b 6b-applying 7 merged aborted"
if [ "${1:-}" = "--vocab" ]; then echo "$STEP_VOCAB"; exit 0; fi

default_run_dir() {
  local common repo branch
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  repo=$(basename "$(dirname "$common")")
  branch=$(git branch --show-current 2>/dev/null)
  [ -n "$branch" ] || branch="detached"
  branch=$(printf '%s' "$branch" | tr '/' '-')
  echo "$SKILL_DIR/runs/$repo-$branch"
}

STEP=""; TASK=""; TIER=""; PR=""; ROUND=""; HEAD=""; LASTREV=""; REPO=""; BRANCH=""; WORKTREE=""; RUN_DIR=""
while getopts "s:t:T:p:r:H:l:R:b:w:d:" o; do case "$o" in
  s) STEP="$OPTARG";; t) TASK="$OPTARG";; T) TIER="$OPTARG";; p) PR="$OPTARG";;
  r) ROUND="$OPTARG";; H) HEAD="$OPTARG";; l) LASTREV="$OPTARG";; R) REPO="$OPTARG";;
  b) BRANCH="$OPTARG";; w) WORKTREE="$OPTARG";; d) RUN_DIR="$OPTARG";;
  *) echo "usage: see write-state.sh header" >&2; exit 2;;
esac; done

[ -n "$STEP" ] || { echo "write-state: -s STEP is required" >&2; exit 2; }
[ -n "$RUN_DIR" ] || RUN_DIR=$(default_run_dir) || {
  echo "write-state: not in a git repo — pass -d RUN_DIR" >&2; exit 2; }
mkdir -p "$RUN_DIR" || { echo "write-state: cannot create $RUN_DIR" >&2; exit 2; }

# git-derived defaults (only used when the field is neither passed nor already present)
GIT_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
GIT_TOP=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

WS_STEP="$STEP" WS_TASK="$TASK" WS_TIER="$TIER" WS_PR="$PR" WS_ROUND="$ROUND" \
WS_HEAD="$HEAD" WS_LASTREV="$LASTREV" WS_REPO="$REPO" WS_BRANCH="$BRANCH" \
WS_WORKTREE="$WORKTREE" WS_RUN_DIR="$RUN_DIR" WS_VOCAB="$STEP_VOCAB" \
WS_GIT_HEAD="$GIT_HEAD" WS_GIT_BRANCH="$GIT_BRANCH" WS_GIT_TOP="$GIT_TOP" \
python3 - <<'PY'
import json, os, sys
from datetime import datetime, timezone

ALLOWED_STEPS = set(os.environ.get("WS_VOCAB", "").split())
ALLOWED_TIERS = {"trivial", "standard", "complex"}
KEY_ORDER = ["task", "repo", "branch", "worktree", "tier", "pr", "round",
             "step", "head_sha", "last_reviewed_sha", "updated_at"]

e = os.environ.get
run_dir = e("WS_RUN_DIR")
path = os.path.join(run_dir, "state.json")

state = {}
file_existed = os.path.exists(path)
if file_existed:
    try:
        with open(path) as f:
            state = json.load(f)
    except Exception:
        print(f"write-state: existing {path} is not valid JSON — fix or remove it first", file=sys.stderr)
        sys.exit(2)

def fail(msg):
    print(f"write-state: {msg}", file=sys.stderr)
    sys.exit(2)

# Migrate legacy / pre-schema state carried forward from an existing file (F1). A resumed run's
# state.json may predate write-state.sh (URL `pr`, ad-hoc `pr_number`, unknown keys, missing
# `task`) — legacy state is data to rescue, not reject. Hard validation still applies to the
# NEW values passed on this call; only carried-forward fields are migrated.
import re
migrations = []
if file_existed:
    # salvage the PR number: prefer a clean legacy `pr_number`, else trailing digits of a URL `pr`
    if not isinstance(state.get("pr"), int):
        salvaged = None
        if str(state.get("pr_number", "")).isdigit():
            salvaged = int(state["pr_number"])
        elif isinstance(state.get("pr"), str):
            m = re.search(r"(\d+)\s*$", state["pr"]) or re.search(r"(\d+)", state["pr"])
            if m:
                salvaged = int(m.group(1))
        if salvaged is not None and state.get("pr") not in (None, salvaged):
            migrations.append(f"pr {state.get('pr')!r} -> {salvaged}")
            state["pr"] = salvaged
        elif isinstance(state.get("pr"), str):
            migrations.append(f"pr {state['pr']!r} unparseable -> null")
            state["pr"] = None
    # drop unknown keys instead of failing (schema drift in a legacy file is not a fatal error)
    dropped = [k for k in list(state) if k not in KEY_ORDER]
    for k in dropped:
        state.pop(k, None)
    if dropped:
        migrations.append("dropped ad-hoc key(s): " + ",".join(dropped))
    # legacy `step` in the stored file is always overwritten by the required -s below, so an
    # out-of-vocabulary stored step needs no migration.

step = e("WS_STEP")
if step not in ALLOWED_STEPS:
    fail(f"step '{step}' not in vocabulary: {' '.join(sorted(ALLOWED_STEPS))}")
state["step"] = step

if e("WS_TASK"):
    state["task"] = e("WS_TASK")
if not state.get("task"):
    if file_existed:
        # legacy file with no task — synthesize a placeholder from the branch rather than block resume
        state["task"] = e("WS_BRANCH") or state.get("branch") or e("WS_GIT_BRANCH") or "migrated-run"
        migrations.append(f"task synthesized -> {state['task']!r} (pass -t to correct)")
    else:
        fail("first write needs -t TASK (schema requires it)")

if e("WS_TIER"):
    if e("WS_TIER") not in ALLOWED_TIERS:
        fail(f"tier '{e('WS_TIER')}' not in {sorted(ALLOWED_TIERS)}")
    state["tier"] = e("WS_TIER")

if e("WS_PR"):
    if not e("WS_PR").isdigit():
        fail(f"-p must be the integer PR number, got '{e('WS_PR')}' (never a URL)")
    state["pr"] = int(e("WS_PR"))

if e("WS_ROUND"):
    if not e("WS_ROUND").isdigit():
        fail(f"-r must be an integer, got '{e('WS_ROUND')}'")
    state["round"] = int(e("WS_ROUND"))

repo = e("WS_REPO") or state.get("repo") or "ohcnetwork/care_fe"
if "/" not in repo:
    if not e("WS_REPO") and file_existed:
        # legacy carried-forward bare repo name — assume the standard owner rather than block resume
        migrations.append(f"repo {repo!r} -> ohcnetwork/{repo}")
        repo = f"ohcnetwork/{repo}"
    else:
        fail(f"repo '{repo}' must be full owner/name")
state["repo"] = repo

state["branch"] = e("WS_BRANCH") or state.get("branch") or e("WS_GIT_BRANCH") or "unknown"
state["worktree"] = e("WS_WORKTREE") or state.get("worktree") or e("WS_GIT_TOP") or "unknown"
state["head_sha"] = e("WS_HEAD") or e("WS_GIT_HEAD") or state.get("head_sha") or "unknown"
if e("WS_LASTREV"):
    state["last_reviewed_sha"] = e("WS_LASTREV")
state.setdefault("last_reviewed_sha", "")
state.setdefault("round", 1)
state.setdefault("tier", "standard")
state.setdefault("pr", None)
state["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

extra = [k for k in state if k not in KEY_ORDER]
if extra:
    fail(f"ad-hoc keys not in schema: {extra} (schema drift — remove them)")

ordered = {k: state[k] for k in KEY_ORDER if k in state}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(ordered, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
for note in migrations:
    print(f"write-state: migrated {note}", file=sys.stderr)
print(f"write-state: {path} ← step={ordered['step']} round={ordered.get('round')} pr={ordered.get('pr')}")
PY
