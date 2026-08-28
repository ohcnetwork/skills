## UX Review — static — 1 surface

### Summary
One Broken overflow finding on the medication row.

### Broken
- [MedicationOrderRow] — the free-text `name` sits in a **fixed `w-64`** flex row with no
  `truncate`/`min-w-0`. A long drug name won't wrap and **escapes the container**, pushing the price
  out. Add `min-w-0` to the flex child and `truncate` (with a `title` for hover) on the name span.
  (src/pages/Facility/billing/invoice/components/MedicationOrderRow.tsx)

### Convention
- none

### Polish
- none
