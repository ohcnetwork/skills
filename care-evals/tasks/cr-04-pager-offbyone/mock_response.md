**Bottom line** — Not mergeable: an off-by-one in the offset makes page 1 skip the first page.

**Intent** — Build `{ limit, offset }` query params for a 1-based paginated invoice list.

**Worth deciding**
- **Correctness — off-by-one offset.** The JSDoc says `page` is **1-based**, but `offset: page *
  pageSize` gives `offset = pageSize` for page 1, so the first page of rows is skipped and the final
  page is unreachable. Should be `offset: (page - 1) * pageSize`.

**Optional / FYI** — none.

**Out of scope** — validation of negative/zero `page` inputs.
