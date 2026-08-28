## UX Review — static — 1 surface

### Summary
One Broken finding: the KPI row overflows in the **tablet band** (md, 768–1023px) although it looks
fine on both phone and desktop.

### Broken
- [LabResultsSummary] — the grid goes three-up at **`md:grid-cols-3`** (768px), but each card holds a
  `w-44` (176px) chart and a `w-20` (80px) badge, both `shrink-0` — ~256px that can't compress. At the
  **md / tablet band** each column is only ~229px, so the fixed children **overflow the card and
  horizontally scroll the row**. It's fine on mobile (single full-width column) and fine on desktop
  (`lg` columns are ~315px+), so the break is specific to the **middle breakpoint (768–1023, iPad
  portrait)**. Fix: engage the three-up layout at **`lg:grid-cols-3`** instead of `md:` (stay single
  column through tablet), or drop `shrink-0` / shrink the fixed widths so the content can reflow.
  (src/pages/Facility/patient/components/LabResultsSummary.tsx)

### Convention
- none

### Polish
- none
