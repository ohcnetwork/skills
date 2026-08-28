**Bottom line** — Sound and mergeable; nothing to change.

**Intent** — Group invoice lines by category, subtotal each, and show a grand total. Amounts are
integer minor units, divided by 100 only for display.

**Worth deciding** — none. Money is kept in integer minor units and only divided for display (no
float accumulation), the map accumulator seeds correctly with `?? 0`, and the `useMemo` is keyed on
`lines`. Behavior looks correct.

**Optional / FYI** — none worth raising.

**Out of scope** — n/a.
