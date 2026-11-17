#!/usr/bin/env python3
"""Reflect changes made to public/locale/en.json into the other locale files.

Compares en.json between two git refs and, for every other locale file:
  * moves translations of renamed keys to their new key,
  * deletes translations of removed keys,
  * (optionally) deletes any key that is not in en.json at all (--purge-stale).

Rename detection: a removed key and an added key with an identical value are
treated as a rename (one-to-one). Everything else that was added/removed is
reported but never invented, and reworded values are only reported, because the
existing translation may or may not still be accurate.

Run from the repo root (or pass --repo). Standard library only.

  python3 -I sync_locales.py                     # dry run vs HEAD~1..HEAD
  python3 -I sync_locales.py --apply
  python3 -I sync_locales.py --base abc123 --head WORKTREE --apply --purge-stale
"""
import argparse, glob, json, os, subprocess, sys
from collections import defaultdict

EN = "public/locale/en.json"


def load_en(repo, ref):
    if ref == "WORKTREE":
        with open(os.path.join(repo, EN), encoding="utf-8") as f:
            return json.load(f)
    out = subprocess.run(["git", "-C", repo, "show", f"{ref}:{EN}"],
                         capture_output=True, text=True, encoding="utf-8")
    if out.returncode:
        sys.exit(f"git show {ref}:{EN} failed: {out.stderr.strip()}")
    return json.loads(out.stdout)


def dump(d, trailing_newline):
    # Matches the repo's format: 2-space indent, real unicode, no key re-sorting.
    return json.dumps(d, indent=2, ensure_ascii=False) + ("\n" if trailing_newline else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--base", default="HEAD~1", help="ref before the en.json change")
    ap.add_argument("--head", default="HEAD", help="ref after the change, or WORKTREE")
    ap.add_argument("--apply", action="store_true", help="write files (default: dry run)")
    ap.add_argument("--purge-stale", action="store_true",
                    help="also drop keys absent from en.json even if removed before --base")
    a = ap.parse_args()

    old, new = load_en(a.repo, a.base), load_en(a.repo, a.head)
    removed = [k for k in old if k not in new]
    added = [k for k in new if k not in old]
    changed = [k for k in new if k in old and old[k] != new[k]]

    # One-to-one rename detection by identical value.
    pool = defaultdict(list)
    for k in removed:
        pool[json.dumps(old[k], sort_keys=True)].append(k)
    renames = {}
    for k in added:
        cands = pool.get(json.dumps(new[k], sort_keys=True), [])
        if cands:
            renames[cands.pop(0)] = k

    print(f"en.json {a.base}..{a.head}: {len(old)} -> {len(new)} keys | "
          f"removed {len(removed)} (of which renamed {len(renames)}) | "
          f"added {len(added) - len(renames)} | reworded {len(changed)}")
    for o, n in renames.items():
        print(f"  rename  {o} -> {n}")
    for k in added:
        if k not in renames.values():
            print(f"  added   {k}  (no translation is created)")
    if changed:
        print("  reworded values (translations untouched; review if meaning changed):")
        for k in changed:
            print(f"    {k}: {old[k]!r} => {new[k]!r}")

    files = sorted(p for p in glob.glob(os.path.join(a.repo, "public/locale/*.json"))
                   if os.path.basename(p) != "en.json")
    removed_set = set(removed)
    for p in files:
        with open(p, encoding="utf-8") as f:
            raw = f.read()
        d = json.loads(raw)
        out, moved, dropped, stale = {}, 0, 0, 0
        for k, v in d.items():
            if k in renames:
                moved += 1
                if renames[k] not in d:  # never clobber an existing translation
                    out[renames[k]] = v
                continue
            if k in removed_set:
                dropped += 1
                continue
            if a.purge_stale and k not in new:
                stale += 1
                continue
            out[k] = v
        name = os.path.basename(p)
        left = sum(k not in new for k in out)
        print(f"{name}: {len(d)} -> {len(out)} | renamed {moved} | removed {dropped}"
              f" | stale purged {stale} | stale remaining {left}"
              f" | untranslated {sum(k not in out for k in new)}")
        if a.apply:
            with open(p, "w", encoding="utf-8") as f:
                f.write(dump(out, raw.endswith("\n")))
    if not a.apply:
        print("\nDry run only. Re-run with --apply to write.")


if __name__ == "__main__":
    main()
