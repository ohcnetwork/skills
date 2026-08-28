## UX Review — static — 1 surface

### Summary
One Broken finding: a scroller-inside-a-scroller where **neither scroller actually works** — the body
and the observations log both declare `overflow-y-auto` but can't scroll.

### Broken
- [PatientDetailSheet] — the body `div` is `flex flex-1 flex-col overflow-y-auto` and the inner
  observations `<ul>` is `flex-1 overflow-y-auto`, but **neither carries `min-h-0`**. Flex children
  default to `min-height: auto`, so each **grows to its content height instead of scrolling** — the
  body expands past the sheet (content clipped / the sheet overflows) and the nested log's scroller
  **never engages**. Both scroll areas are declared but non-functional. Fix: add **`min-h-0`** to the
  flex chain — the body `div`, the `section`, and the `<ul>` — (and/or `overflow-hidden` on the
  container) so each `overflow-y-auto` bounds its height and both scrollers become usable. This is the
  vertical analog of the `min-w-0` idiom already in the rubric.
  (src/pages/Facility/patient/components/PatientDetailSheet.tsx)

### Convention
- none

### Polish
- none
