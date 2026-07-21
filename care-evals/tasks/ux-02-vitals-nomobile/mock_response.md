## UX Review — static — 1 surface

### Summary
Broken: the vitals grid has no mobile layout.

### Broken
- [VitalsGrid] — hard-coded **`w-[1100px]`** with **`grid-cols-6`** and **no responsive variants**
  (no `sm:`/`md:` grid, no `useBreakpoints`). At a 375px viewport this causes horizontal overflow and
  is unusable on mobile. Make the width fluid (`w-full`) and collapse the grid to fewer columns at
  small breakpoints. (src/pages/Facility/patient/components/VitalsGrid.tsx)

### Convention
- none

### Polish
- none
