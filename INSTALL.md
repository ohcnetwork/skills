# Installing skills

> **Agent instructions.** If a user asks you to install skills from this repo, follow these steps yourself using terminal commands — don't just describe them.

## How skills are discovered

Agents auto-discover skills from well-known directories in the user's home folder:

| Agent | Discovery directory |
| --- | --- |
| VS Code Copilot | `~/.agents/skills/` |
| Claude Code | `~/.claude/skills/` |

To "install" a skill, make it appear inside one of those directories. Instead of copying, we **symlink** each skill back to this repo — that way `git pull` updates every installed skill in place, with no re-install.

## Steps

1. Determine the repo root (the directory containing this file). Call it `$REPO`.
2. Find every installable skill — each is a top-level directory containing a `SKILL.md`:
   ```bash
   cd "$REPO"
   for d in */; do [ -f "$d/SKILL.md" ] && echo "${d%/}"; done
   ```
3. Ask the user whether they want **all** skills or a **subset**. If they don't care or say "all", install everything.
4. Ensure the target directory exists (default to VS Code Copilot's `~/.agents/skills/`; use `~/.claude/skills/` for Claude Code):
   ```bash
   mkdir -p ~/.agents/skills
   ```
5. Create a symlink for each selected skill. Use `ln -sfn` so re-running is safe (it replaces stale links without error):
   ```bash
   ln -sfn "$REPO/<skill-name>" ~/.agents/skills/<skill-name>
   ```
6. Verify the links resolve:
   ```bash
   ls -l ~/.agents/skills/
   ```

## Install all skills in one shot

```bash
REPO="$(pwd)"                 # run from the repo root
TARGET=~/.agents/skills       # or ~/.claude/skills for Claude Code
mkdir -p "$TARGET"
for d in "$REPO"/*/; do
  [ -f "$d/SKILL.md" ] || continue
  name="$(basename "$d")"
  ln -sfn "$d" "$TARGET/$name"
  echo "linked $name"
done
```

## Staying up to date

Because installed skills are symlinks, keeping them current is just:

```bash
git pull
```

## Uninstall

Remove the symlink only — this never touches the repo:

```bash
rm ~/.agents/skills/<skill-name>
```
