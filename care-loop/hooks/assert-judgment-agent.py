#!/usr/bin/env python3
"""assert-judgment-agent.py — OPTIONAL care-loop PreToolUse hook (Claude Code only).

Hard gate for the model tiers: denies an Agent/Task spawn whose prompt references a care-loop
judgment role guide unless it is spawned as the matching named care-* agent (whose frontmatter
binds Opus). Ships with the skill but is NOT auto-installed — hooks are user config. Opt in by
adding to ~/.claude/settings.json:

  {"hooks": {"PreToolUse": [{"matcher": "Task|Agent",
    "hooks": [{"type": "command",
      "command": "python3 ~/.claude/skills/care-loop/hooks/assert-judgment-agent.py"}]}]}}

Honest limitation: this is string matching. A rephrased prompt that avoids naming the guide file
slips through; that residual risk is covered by the in-guide model self-check and the mandatory
`Planned by:` line at the human gate. Copilot has no hook layer at all — there the ceiling is
agent frontmatter + attestation (guides/hosts.md).

Contract: reads the tool-call JSON on stdin. Exit 0 = allow, exit 2 = deny (stderr goes back to
the model). Never blocks on unparseable input.
"""
import json
import sys

PAIRS = {
    "01-plan": "care-planner",
    "04a-review": "care-reviewer",
    "04b-test-grade": "care-test-grader",
    "04c-ui-validate": "care-ux-validator",
    "06a-triage": "care-triager",
}

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)  # not our call to break

tool_input = data.get("tool_input") or {}
prompt = str(tool_input.get("prompt") or "")
agent = str(tool_input.get("subagent_type") or "")

for guide, required in PAIRS.items():
    if guide in prompt and agent != required:
        sys.stderr.write(
            f"care-loop: prompt references judgment guide '{guide}' but subagent_type is "
            f"'{agent or 'generic'}' — spawn the named '{required}' agent instead; its "
            f"frontmatter binds the judgment model (SKILL.md 'Model enforcement').\n"
        )
        sys.exit(2)

sys.exit(0)
