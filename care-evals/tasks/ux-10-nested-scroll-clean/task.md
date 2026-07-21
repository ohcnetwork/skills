---
id: ux-10-nested-scroll-clean
skill: care-ux-review
tier: judgment
kind: clean-control
args: develop
---

# ux-10 — Encounter notes sheet (CLEAN nested-scroll control)

The same scroller-inside-a-scroller shape as ux-09, done correctly: the body `div`, the `section`, and
the inner notes `<ul>` each carry **`min-h-0`** alongside `flex-1 overflow-y-auto`, so every flex child
can shrink below its content height and each `overflow-y-auto` bounds and scrolls. The `SheetContent`
is height-bounded (`flex h-full flex-col`).

Both the body scroller and the nested notes scroller work and are usable — a good review returns a
**clean pass**. This is the false-positive probe for ux-09: a review that claims a scroller "won't
scroll", demands `min-h-0` (already present), or reports clipping / overflow here is wrong.

Ground truth: [expected.json](./expected.json).
