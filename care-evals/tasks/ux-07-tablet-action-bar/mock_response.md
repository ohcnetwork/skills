## UX Review — static — 1 surface

### Summary
One Broken finding: in the **tablet band** (md, 768–1023px) the four action buttons overrun the header
and clip the patient name, though the layout is fine on phone and desktop.

### Broken
- [PatientHeaderActions] — the header switches to an inline row at **`md:flex-row md:justify-between`**
  and forces the button group **`md:flex-nowrap`**. The four `min-w-[9rem]` (144px) buttons are ~600px
  wide and can't wrap; with a ~200px title that's ~800px against only ~736px usable at 768px. The
  **button group (a sibling of the title) expands past the container and pushes/clips the `<h1>`**,
  which has no `min-w-0` / `truncate`. It's fine on **mobile** (column layout, the group wraps) and
  fine on **desktop** (`lg` has room), so the collision is specific to the **middle / tablet
  breakpoint (768–1023, iPad portrait)**. Fix: keep the header stacked until **`lg:flex-row`**, or let
  the button group keep wrapping through tablet, and add `min-w-0` + `truncate` to the title.
  (src/pages/Facility/patient/components/PatientHeaderActions.tsx)

### Convention
- none

### Polish
- none
