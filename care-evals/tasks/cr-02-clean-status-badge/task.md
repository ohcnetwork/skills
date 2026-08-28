---
id: cr-02-clean-status-badge
skill: care-review
tier: judgment
kind: clean-control
args: develop
---

# cr-02 — Invoice status badge (clean control)

Adds a new `InvoiceStatusBadge.tsx`: a small, idiomatic presentational component that maps an
invoice status enum to a label and a Tailwind tone via two `Record` lookups, composed with `cn`.
There is **no defect** — the two split maps are a normal, readable pattern, `cn` is the house
utility, and the status union matches the billing domain.

This is the **false-positive control**. A good review returns *"intent clear, approach
proportionate, nothing to change"*. It should NOT invent overengineering findings about the two
maps, NOT demand they be merged, and NOT manufacture correctness/style nits to look busy.

Ground truth: [expected.json](./expected.json) — `expected_outcome: clean`, empty `must_flag`, and a
`must_not_flag` list of the tempting-but-wrong findings that count as false positives.
