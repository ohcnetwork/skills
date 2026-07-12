#!/usr/bin/env bash
# sync-agents.sh — regenerate the Copilot agent variants from the Claude agent bodies (F5).
#
# The named judgment agents are authored once in agents/claude/*.md. Their Copilot twins in
# agents/copilot/*.agent.md are IDENTICAL except for frontmatter (Copilot needs a fully-qualified
# `model:` string, and drops `name:`/`tools:`). They used to be hand-copied — the marker comment
# said "regenerate" but no generator existed, so body drift between hosts would be silent. This is
# that generator.
#
# Usage:
#   sync-agents.sh            regenerate all agents/copilot/*.agent.md from agents/claude/*.md
#   sync-agents.sh --check    verify they're in sync; exit 1 (and list drift) without writing
#
# Model mapping (Claude short name -> Copilot fully-qualified): opus, sonnet. Extend MODEL_MAP for
# new tiers. Exit: 0 in sync / written · 1 --check found drift · 2 usage/parse error.

set -uo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$SKILL_DIR/agents/claude"
COPILOT_DIR="$SKILL_DIR/agents/copilot"

CHECK=0
case "${1:-}" in
  --check) CHECK=1;;
  "") ;;
  *) echo "usage: sync-agents.sh [--check]" >&2; exit 2;;
esac

[ -d "$CLAUDE_DIR" ] || { echo "sync-agents: no $CLAUDE_DIR" >&2; exit 2; }
mkdir -p "$COPILOT_DIR"

drift=0
for src in "$CLAUDE_DIR"/*.md; do
  [ -f "$src" ] || continue
  base=$(basename "$src" .md)
  dst="$COPILOT_DIR/$base.agent.md"

  generated=$(SRC="$src" BASE="$base" python3 - <<'PY'
import os, sys

MODEL_MAP = {
    "opus":   "Claude Opus 4.8 (copilot)",
    "sonnet": "Claude Sonnet 4.6 (copilot)",
}

src = os.environ["SRC"]
base = os.environ["BASE"]
text = open(src).read()
parts = text.split("---\n", 2)
if len(parts) < 3 or parts[0].strip():
    sys.stderr.write(f"sync-agents: {src} has no leading YAML frontmatter\n")
    sys.exit(2)
fm, body = parts[1], parts[2]  # body keeps its leading "\n# ..."

desc = model = None
for line in fm.splitlines():
    if line.startswith("description:"):
        desc = line[len("description:"):].strip()
    elif line.startswith("model:"):
        model = line[len("model:"):].strip()
if not desc or not model:
    sys.stderr.write(f"sync-agents: {src} missing description/model\n")
    sys.exit(2)
mapped = MODEL_MAP.get(model)
if not mapped:
    sys.stderr.write(f"sync-agents: {src} model '{model}' not in MODEL_MAP {list(MODEL_MAP)}\n")
    sys.exit(2)

marker = (f"<!-- generated from ../claude/{base}.md — edit the body THERE and regenerate "
          f"(sync-agents.sh); only frontmatter differs -->")
sys.stdout.write(f"---\ndescription: {desc}\nmodel: {mapped}\n---\n\n{marker}\n{body}")
PY
  ) || exit 2

  if [ "$CHECK" -eq 1 ]; then
    if [ ! -f "$dst" ] || ! diff -q <(printf '%s' "$generated") "$dst" >/dev/null 2>&1; then
      echo "DRIFT: $dst out of sync with $src"
      drift=1
    fi
  else
    printf '%s' "$generated" > "$dst"
    echo "wrote $dst"
  fi
done

if [ "$CHECK" -eq 1 ]; then
  [ "$drift" -eq 0 ] && { echo "sync-agents: all Copilot agents in sync"; exit 0; }
  echo "sync-agents: drift found — run sync-agents.sh to regenerate" >&2
  exit 1
fi
exit 0
