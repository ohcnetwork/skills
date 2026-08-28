---
id: ux-06-tablet-stat-overflow
skill: care-ux-review
tier: judgment
kind: seeded-defect
args: develop
---

# ux-06 — Lab-result KPI cards (overflow at TABLET only) · GAP PROBE (tablet band)

A patient-summary KPI row uses `grid grid-cols-1 md:grid-cols-3`. Each card is a flex row holding two
**`shrink-0` fixed-width children** — a `w-44` (176px) trend chart and a `w-20` (80px) delta badge —
so ~256px of content can never compress.

- **Mobile (<768):** single column, card ≈ full width (~327px) → the fixed children fit. **OK.**
- **Tablet (md, 768–1023):** three columns kick in at `md:`, each ≈ 229px < 256px → the fixed
  children **overflow the card / horizontal-scroll the row.** **BROKEN.**
- **Desktop (lg, ≥1024):** three columns each ≈ 315px+ → fits again. **OK.**

Classic "fine on laptop and phone, breaks on tablet": the 3-up layout should have engaged at `lg:`,
not `md:`. A **hit** requires the review to flag the **tablet / md-band** breakage specifically (the
middle breakpoint, ~768–1023) — not merely "overflow" or "fixed width" in the abstract. This probes
whether the static rubric (which emphasizes the 320/375 small end + desktop) reasons about the middle
band, which only live mode's 768×1024 viewport exercises today.

Ground truth: [expected.json](./expected.json).
