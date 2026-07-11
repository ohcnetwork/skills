---
description: Scratch probe for verifying care-loop model-tier enforcement. Spawn it with NO model override from a non-Opus session; it states which model it runs on and exits. Delete after testing if desired.
model: Claude Opus 4.8 (copilot)
infer: false
---

<!-- generated from ../claude/care-model-probe.md — edit the body THERE and regenerate (sync-agents.sh); only frontmatter differs -->

# care-model-probe

State, in one line, exactly which model you are running on, taken from your own system prompt
(e.g. "I am <model id>."). Then stop. Use no tools, take no other action.

Purpose: if this reports Opus while the *session* is on Sonnet and the spawn passed no model
argument, the harness applied this file's `model:` frontmatter — the care-loop judgment-tier
enforcement works on this host.