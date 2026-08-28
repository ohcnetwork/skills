---
id: cr-04-pager-offbyone
skill: care-review
tier: judgment
kind: seeded-defect
args: develop
---

# cr-04 — Invoice pager params (off-by-one)

Adds `invoicePageParams(page, pageSize)` building `{ limit, offset }` for a paginated invoice list.
**One planted defect**:

1. **Correctness (off-by-one offset)** — the JSDoc states `page` is **1-based** (page 1 is the first
   page), but `offset: page * pageSize` yields `offset = pageSize` for page 1 — so **page 1 skips the
   first page** of results and the last page is unreachable. Should be `(page - 1) * pageSize`.

A recall probe for a subtle boundary bug. Otherwise clean. Ground truth: [expected.json](./expected.json).
