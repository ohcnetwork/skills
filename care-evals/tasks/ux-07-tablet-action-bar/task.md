---
id: ux-07-tablet-action-bar
skill: care-ux-review
tier: judgment
kind: seeded-defect
args: develop
---

# ux-07 — Patient header action bar (siblings collide at TABLET only) · GAP PROBE (tablet band)

A patient header row lays out a title next to **four fixed-width action buttons** (`min-w-[9rem]` =
144px each → ~600px of buttons). The container is `flex-col` on mobile and switches to an inline
`md:flex-row md:justify-between` at the tablet breakpoint; the button group is `flex-wrap md:flex-nowrap`.

- **Mobile (<768):** column layout + the button group **wraps** onto multiple rows → nothing collides.
  **OK.**
- **Tablet (md, 768–1023):** the row goes inline at `md:` and the button group is forced `md:flex-nowrap`.
  Title (~200px) + ~600px of no-wrap buttons ≈ 800px exceeds the ~736px usable width → the **buttons
  (a sibling of the title) expand past the container and push/clip the title**, which has no `min-w-0`
  / `truncate`. **BROKEN.**
- **Desktop (lg, ≥1024):** ~976px usable easily fits title + buttons. **OK.**

The sibling button group takes far too much space **only in the middle band** — it should stay stacked
(`lg:flex-row`) or keep wrapping through tablet, and the title needs `min-w-0` + `truncate`. A **hit**
requires flagging the **tablet / md-band** collision specifically (siblings competing for width at
768–1023), not merely "buttons are wide". Ground truth: [expected.json](./expected.json).
