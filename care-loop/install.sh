#!/usr/bin/env bash
# install.sh — wire the care-loop skill (and its companion doctor) into the host agent dirs (F6).
#
# The skill's install story was prose-only, and IMP-3's follow-up bug (write-state.sh shipped
# non-executable) is exactly the class a scripted install/check catches. This script makes the
# installed-homes contract from SKILL.md executable and verifiable.
#
# Invariants it establishes / checks:
#   1. skill folders symlinked into ~/.claude/skills/ and ~/.agents/skills/
#   2. Claude agent variants (agents/claude/*.md)    symlinked into ~/.claude/agents/
#   3. Copilot agent variants (agents/copilot/*.agent.md) symlinked into ~/.copilot/agents/
#   4. every bundled *.sh script + hooks/*.py is executable
#   5. the Copilot agent variants are in sync with their Claude sources (sync-agents.sh --check)
#
# Usage:
#   install.sh            create/refresh the symlinks + chmod (idempotent)
#   install.sh --check    verify only; exit 1 (listing gaps) without mutating anything
#
# Exit: 0 installed / all invariants hold · 1 --check found a gap · 2 usage/setup error.

set -uo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"      # …/care-loop
REPO_ROOT="$(cd "$SKILL_DIR/.." && pwd)"                        # …/skills
DOCTOR_DIR="$REPO_ROOT/care-loop-doctor"

CHECK=0
case "${1:-}" in
  --check) CHECK=1;;
  "") ;;
  *) echo "usage: install.sh [--check]" >&2; exit 2;;
esac

gaps=0
note() { echo "$1"; }
gap()  { echo "GAP: $1"; gaps=1; }

# link SRC -> DST, idempotently; in --check mode only report.
link() {
  local src="$1" dst="$2"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    return 0                                   # already correct
  fi
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    gap "$dst exists and is NOT a symlink — refusing to clobber real file/dir (resolve by hand)"
    return 0
  fi
  if [ "$CHECK" -eq 1 ]; then
    gap "missing/incorrect symlink: $dst -> $src"
  else
    mkdir -p "$(dirname "$dst")"
    ln -sfn "$src" "$dst" && note "linked $dst -> $src"
  fi
}

# 1. skill folders into both skill homes
for home in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
  link "$SKILL_DIR" "$home/care-loop"
  [ -d "$DOCTOR_DIR" ] && link "$DOCTOR_DIR" "$home/care-loop-doctor"
done

# 2/3. per-file agent variants into the host agent dirs
for src in "$SKILL_DIR"/agents/claude/*.md; do
  [ -f "$src" ] && link "$src" "$HOME/.claude/agents/$(basename "$src")"
done
for src in "$SKILL_DIR"/agents/copilot/*.agent.md; do
  [ -f "$src" ] && link "$src" "$HOME/.copilot/agents/$(basename "$src")"
done

# 4. executable bits on the bundled scripts + hooks (the IMP-3 chmod class of bug)
for f in "$SKILL_DIR"/*.sh "$SKILL_DIR"/hooks/*.py \
         "$DOCTOR_DIR"/*.sh "$DOCTOR_DIR"/*.py; do
  [ -f "$f" ] || continue
  if [ ! -x "$f" ]; then
    if [ "$CHECK" -eq 1 ]; then gap "not executable: $f"
    else chmod +x "$f" && note "chmod +x $f"; fi
  fi
done

# 5. Copilot agents in sync with their Claude sources
if [ -x "$SKILL_DIR/sync-agents.sh" ]; then
  if ! "$SKILL_DIR/sync-agents.sh" --check >/dev/null 2>&1; then
    if [ "$CHECK" -eq 1 ]; then gap "Copilot agents drifted from Claude sources (sync-agents.sh)"
    else "$SKILL_DIR/sync-agents.sh" >/dev/null && note "regenerated Copilot agents (were drifted)"; fi
  fi
fi

if [ "$CHECK" -eq 1 ]; then
  [ "$gaps" -eq 0 ] && { echo "install-check: all invariants hold"; exit 0; }
  echo "install-check: gaps found — run install.sh to fix" >&2
  exit 1
fi

echo
echo "care-loop installed. First run on a new machine: set the session picker to Sonnet, spawn the"
echo "'care-model-probe' agent by name, and confirm it self-reports Opus (verifies frontmatter"
echo "model-binding — see guides/hosts.md). If it reports Sonnet, use the explicit-model fallback."
exit 0
