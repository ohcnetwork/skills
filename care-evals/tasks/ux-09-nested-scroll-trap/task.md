---
id: ux-09-nested-scroll-trap
skill: care-ux-review
tier: judgment
kind: seeded-defect
args: develop
---

# ux-09 — Sheet with a scroller inside a scroller (neither scrolls) · GAP PROBE (nested overflow)

A slide-over `Sheet` whose body is meant to scroll, containing a long observations log that gets its
**own** scroll area — a scroller within a scroller, both of which should work.

Both `overflow-y-auto` regions are **declared but non-functional** because of the classic flexbox trap:
a flex child defaults to `min-height: auto`, so a `flex-1 overflow-y-auto` child **grows to its content
height instead of scrolling** unless it (and its flex ancestors) carry **`min-h-0`**.

- Body: `flex flex-1 flex-col overflow-y-auto` with **no `min-h-0`** → the body expands past the sheet
  instead of scrolling.
- Inner `<ul>`: `flex-1 overflow-y-auto` inside a `flex flex-1 flex-col` section, again **no `min-h-0`**
  → the log renders full-height and its scroller never engages.

Result: the sheet overflows / content is clipped and **neither scroller is usable**. The horizontal
analog (`min-w-0`) is in the skill's overflow idioms; the **vertical `min-h-0` / nested-scroll** case is
not — this probes that gap. Generalizes to *"overflow is declared but doesn't actually work → the
component design must be revisited."*

A **hit** requires flagging the **non-functional / nested scroll** specifically (the scroller that can't
scroll, or the missing `min-h-0` / unbounded flex height) — not merely "add overflow" (overflow is
already present). Fix: add `min-h-0` down the flex chain (and/or `overflow-hidden` on the container) so
both scroll areas bound their height. Ground truth: [expected.json](./expected.json).
