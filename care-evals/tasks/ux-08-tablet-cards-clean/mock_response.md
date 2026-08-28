## UX Review — static — 1 surface

### Summary
Clean pass — no Broken and no Convention findings. The KPI cards are responsive across all
breakpoints, including the tablet band.

### Broken
- none. Three-up engages only at **`lg:grid-cols-3`** (≥1024, where columns are wide enough), so the
  layout stays single column through the tablet band and never squeezes the content. The flex parent
  and the text column both carry **`min-w-0`**, and the label and value use **`truncate` + `title`**,
  so long strings are handled correctly rather than overflowing. The only fixed child is a modest
  `w-16` chart. It renders correctly at mobile, tablet, and desktop — nothing to flag.

### Convention
- none

### Polish
- none
