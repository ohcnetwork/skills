## UX Review — static — 1 surface

### Summary
Clean pass — no Broken and no Convention findings. The nested scroll areas are set up correctly and
both scrollers work.

### Broken
- none. The `SheetContent` is height-bounded (`flex h-full flex-col`), and the body `div`, the
  `section`, and the inner notes `<ul>` each pair `flex-1 overflow-y-auto` with **`min-h-0`**, so every
  flex child can shrink below its content height. Each `overflow-y-auto` therefore bounds and scrolls:
  the body scroller and the nested notes scroller both work and are usable. Long note lists are handled
  correctly rather than clipping or pushing the sheet. Nothing to flag.

### Convention
- none

### Polish
- none
