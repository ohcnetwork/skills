---
name: sync-locales
description: Reflect changes made to CARE's public/locale/en.json (removed keys, renamed keys, spelling fixes) into the other locale files (hi, kn, ml, mr, ta). Use whenever en.json was edited or committed and the other locales need to follow, e.g. "purge removed translations from other locales", "reflect en.json changes in other locales", "sync locales", "we removed unused translations, clean up the rest", or after running check-locale / lint:locale --fix. Also use when asked what is still pending for other locales after an en.json change.
user-invocable: true
argument-hint: "[<base-ref>] [--purge-stale]"
---

# Sync locales with en.json

`public/locale/en.json` is the source of truth. The other locale files are filled by
Crowdin, so they drift whenever en.json loses or renames a key: they keep dead keys and
orphaned translations. This skill replays an en.json change onto them mechanically.
It never writes new translations. That stays with Crowdin and translators.

## Steps

1. **Find the change.** Default is the last commit (`HEAD~1..HEAD`). If the user names a
   commit or range, use `--base`/`--head`. If the en.json edit is uncommitted, use
   `--head WORKTREE`. Check `git log -3 --oneline -- public/locale/en.json` if unsure.
2. **If `scripts/check-locale.mjs` exists** (only on some branches, e.g. 3.1) and the user
   just removed keys, run `npm run lint:locale` first. It reports en.json keys that no longer
   appear in `src/`. Don't pass `--fix` unless the user asked for en.json to be pruned, since
   that edits the source of truth. Do not look for or run it if the file is missing.
3. **Dry run** from the repo root and read the report:
   ```bash
   python3 -I <skill-dir>/scripts/sync_locales.py
   ```
   It lists renames (a removed and an added key with identical values), additions, reworded
   values, and per-locale counts.
4. **Apply** with `--apply`. Add `--purge-stale` only if the user wants keys purged that were
   already missing from en.json before the base ref. Ask when unsure, because this is a
   bigger deletion than the change itself (it removed 40 to 257 extra keys per locale
   the first time it was used).
5. **Verify**: `npx prettier --check public/locale/*.json`, then `git diff --stat -- public/locale`.
   Diffs should contain only deletions plus the renamed lines. Any other churn means the
   file's format wasn't preserved, so investigate before moving on. The script keeps each
   file's trailing-newline state because they differ (`mr.json` has none).
6. **Report** per-locale counts, then the things that remain pending (below). Do not commit
   unless asked.

## What the script deliberately does not do

- **Reworded values** (typo and grammar fixes) leave translations alone: the English
  typo didn't change the meaning. Only call out rewrites that change meaning, such as
  "Reason of Request" to "Reason for Request" or singular to plural. Those are for translator review.
- **Added keys** get no translation entry. Untranslated keys fall back to English at runtime.
- **Source code references.** Renames must already be applied in `src/` and `tests/`. Grep
  for the old key names if the user's commit didn't include that.

## Pending-work checklist to give the user

1. Stale keys older than the change (only if `--purge-stale` was not used).
2. Reworded values whose meaning changed, for translators.
3. Untranslated keys per locale (the script prints the count). This is a Crowdin concern;
   AGENTS.md says non-English files shouldn't be hand-edited. Warn that Crowdin may re-add
   purged keys if its project still has them, so en.json and Crowdin must be pushed in sync.
4. Leftover references to purged keys in `src/`.
