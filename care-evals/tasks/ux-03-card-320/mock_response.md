## UX Review — static — 1 surface

### Summary
Broken on small phones: the card is a fixed 360px wide.

### Broken
- [AppointmentCard] — **`w-[360px]`** plus `px-6` fits a 375px phone but **overflows a 320px small
  device** (iPhone SE-class / older small Android), causing horizontal scroll on the schedule list.
  Use a fluid width (`w-full` with `max-w-[360px]`) so it shrinks below 375px.
  (src/pages/Facility/schedule/components/AppointmentCard.tsx)

### Convention
- none

### Polish
- none
