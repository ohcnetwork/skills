#!/usr/bin/env bash
# poll-pr.sh — token-free wait for bot reviews + CI on a PR (part of the care-loop skill).
#
# Blocks in the terminal (sleep loop; no model tokens) until:
#   1. every configured bot has responded AFTER the baseline time — a new/edited review or comment,
#      or (for bots like Greptile that EDIT their summary in place) the pushed SHA appearing in it —
#      AND
#   2. CI is terminal (gh pr checks reports nothing pending).
# Exits 0 on both signals, 1 on timeout (prints what never arrived), 2 on usage/gh errors.
#
# Usage: poll-pr.sh [-p PR] [-s SINCE_ISO] [-t TIMEOUT_S] [-i INTERVAL_S] [-b "bot1,bot2"] [-R owner/repo]
#   -p  PR number            (default: PR for current branch via `gh pr view`)
#   -s  baseline ISO-8601 UTC (default: now; pass the push time when invoking after `git push`)
#   -t  timeout seconds      (default: 1800)
#   -i  poll interval        (default: 60)
#   -b  comma-separated bot logins; use | for aliases of the same bot
#       (default: coderabbitai[bot],greptile-apps[bot],copilot-pull-request-reviewer[bot]|Copilot,
#        chatgpt-codex-connector[bot] — Copilot authors reviews as copilot-pull-request-reviewer[bot]
#        but inline comments as Copilot, so both count as one bot)
#   -R  repo                 (default: ohcnetwork/care_fe)
#   -c  pushed commit SHA    (default: current HEAD; matched in bot summary bodies, e.g. Greptile's
#       "Last reviewed commit", to detect in-place-edited reviews that don't advance created_at)
#   -g  CI grace seconds     (default: 120; how long "no checks yet" is treated as CI-not-started
#       rather than "PR has no CI" — closes the zero-checks-right-after-push false-green race)
#
# Design rationale (preserved here so the guide stays slim for model reads):
# - Bot discovery: the `.../installation/repositories` endpoint needs GitHub-App auth, not a user
#   token — use recent-PR authorship as the signal, not installation.
# - Greptile edits its summary comment in place instead of posting a new one, so created_at never
#   advances; a plain timestamp check hangs forever. The -c SHA match catches this.
# - "No checks" is ambiguous right after a push: usually CI hasn't registered yet, occasionally the
#   PR genuinely has no CI. The grace window (-g) treats zero checks as "not started" until it
#   elapses, closing the false-green race.

set -euo pipefail

# Copilot's integrated terminal runs a non-login zsh that often lacks Homebrew on PATH,
# so `gh` (and node/npm) can be missing (`command not found: gh`). Prepend common brew bins.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Wrap gh in a timeout so a hung network call can't stall the token-free wait indefinitely
# (a killed call just reads as "no signal this round" and is retried next interval).
if command -v timeout >/dev/null 2>&1; then GHTO="timeout 30"
elif command -v gtimeout >/dev/null 2>&1; then GHTO="gtimeout 30"
else GHTO=""; fi
ghc() { $GHTO gh "$@"; }

REPO="ohcnetwork/care_fe"
# SINGLE SOURCE OF TRUTH for the default bot set — the guides (05-gate-push.md) point here
# instead of repeating the list. Update THIS default when the repo's reviewer bots change;
# per-round narrowing is done at invocation via -b.
BOTS="coderabbitai[bot],greptile-apps[bot],copilot-pull-request-reviewer[bot]|Copilot,chatgpt-codex-connector[bot]"
TIMEOUT=1800
INTERVAL=60
CI_GRACE=120
PR=""
SINCE=""
SHA=""

while getopts "p:s:t:i:b:R:c:g:" opt; do
  case "$opt" in
    p) PR="$OPTARG" ;;
    s) SINCE="$OPTARG" ;;
    t) TIMEOUT="$OPTARG" ;;
    i) INTERVAL="$OPTARG" ;;
    b) BOTS="$OPTARG" ;;
    R) REPO="$OPTARG" ;;
    c) SHA="$OPTARG" ;;
    g) CI_GRACE="$OPTARG" ;;
    *) echo "usage: see header" >&2; exit 2 ;;
  esac
done

[ -n "$PR" ] || PR=$(gh pr view --json number --jq .number 2>/dev/null) || {
  echo "poll-pr: no PR found for current branch and no -p given" >&2; exit 2; }
[ -n "$SINCE" ] || SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Pushed commit SHA. Some bots (e.g. Greptile) EDIT their summary comment in place instead of
# posting a new one, so created_at never advances and a plain timestamp check hangs forever.
# We also treat a bot as done when the pushed SHA appears in its summary body
# (Greptile: "Last reviewed commit: .../commit/<sha>").
[ -n "$SHA" ] || SHA=$(git rev-parse HEAD 2>/dev/null || echo "")

IFS=',' read -r -a BOT_ARR <<<"$BOTS"
deadline=$(( $(date +%s) + TIMEOUT ))
# "No checks" is ambiguous right after a push: usually CI hasn't registered yet, occasionally
# the PR genuinely has no CI. Treat it as "not started" until this window elapses, then accept it.
ci_grace_until=$(( $(date +%s) + CI_GRACE ))
echo "poll-pr: PR #$PR on $REPO — waiting for [${BOTS}] after $SINCE + CI terminal (timeout ${TIMEOUT}s)"

# One bot "arrived" if ANY of its aliases (|-separated) has, since SINCE: a new review, a
# new-or-edited review-comment or issue-comment (updated_at catches in-place edits like Greptile's),
# OR an issue-comment whose body references the pushed SHA (Greptile's "Last reviewed commit").
bot_arrived() {
  local aliases="$1" alias
  IFS='|' read -r -a alias_arr <<<"$aliases"
  for alias in "${alias_arr[@]}"; do
    ghc api "repos/$REPO/pulls/$PR/reviews" --paginate \
      --jq "[.[] | select(.user.login==\"$alias\" and .submitted_at > \"$SINCE\")] | length" \
      | awk '{s+=$1} END {exit !(s>0)}' && return 0
    ghc api "repos/$REPO/pulls/$PR/comments" --paginate \
      --jq "[.[] | select(.user.login==\"$alias\" and ((.created_at > \"$SINCE\") or (.updated_at > \"$SINCE\")))] | length" \
      | awk '{s+=$1} END {exit !(s>0)}' && return 0
    ghc api "repos/$REPO/issues/$PR/comments" --paginate \
      --jq "[.[] | select(.user.login==\"$alias\" and ((.created_at > \"$SINCE\") or (.updated_at > \"$SINCE\") or (\"$SHA\" != \"\" and (.body | contains(\"$SHA\")))))] | length" \
      | awk '{s+=$1} END {exit !(s>0)}' && return 0
  done
  return 1
}

ci_terminal() {
  # No pending buckets => terminal (pass OR fail — the loop handles failures).
  # `gh pr checks` exits nonzero when checks are pending/failing but still emits the count, so
  # `|| true` keeps that count; a truly empty result means gh errored OR no checks are registered.
  local pending
  pending=$(ghc pr checks "$PR" --repo "$REPO" --json bucket \
    --jq '[.[] | select(.bucket=="pending")] | length' 2>/dev/null || true)
  if [ -z "$pending" ]; then
    # No checks reported yet. Right after a push this usually means CI hasn't been created —
    # NOT that the PR has no CI — so only accept zero-checks as terminal past the grace window.
    [ "$(date +%s)" -ge "$ci_grace_until" ]
    return
  fi
  [ "$pending" -eq 0 ]
}

# Exit digest — a 3-4 line summary printed on return so the orchestrator skips a round of `gh`
# re-fetch (rider 7): each waited bot -> responded/skipped, the CI conclusion, and the head SHA.
exit_digest() {
  local missing_csv="$1"
  echo "poll-pr: --- exit digest ---"
  for bot in "${BOT_ARR[@]}"; do
    if [[ ",$missing_csv," == *",$bot,"* ]]; then echo "poll-pr:   bot $bot -> skipped/no-response"
    else echo "poll-pr:   bot $bot -> responded"; fi
  done
  local concl
  concl=$(ghc pr checks "$PR" --repo "$REPO" --json bucket \
    --jq 'if any(.[];.bucket=="fail") then "fail" elif any(.[];.bucket=="pending") then "pending" elif length==0 then "none" else "pass" end' \
    2>/dev/null || echo "unknown")
  echo "poll-pr:   CI -> ${concl:-unknown}"
  echo "poll-pr:   head SHA -> ${SHA:-unknown}"
}

while :; do
  missing=()
  for bot in "${BOT_ARR[@]}"; do
    bot_arrived "$bot" || missing+=("$bot")
  done
  ci_ok=false
  ci_terminal && ci_ok=true

  if [ ${#missing[@]} -eq 0 ] && $ci_ok; then
    echo "poll-pr: all bots reported and CI terminal — done"
    exit_digest ""
    exit 0
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "poll-pr: TIMEOUT — missing bots: [${missing[*]:-none}]; CI terminal: $ci_ok" >&2
    exit_digest "$(IFS=,; echo "${missing[*]:-}")"
    exit 1
  fi

  echo "poll-pr: waiting — missing bots: [${missing[*]:-none}]; CI terminal: $ci_ok"
  sleep "$INTERVAL"
done
