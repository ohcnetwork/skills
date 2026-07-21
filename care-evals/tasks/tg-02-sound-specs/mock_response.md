Graded the user-departments pagination spec against the three acceptance criteria.

| AC# | verdict | note |
|---|---|---|
| AC1 | Covered | asserts exactly 10 body rows on first load — a direct, strong count check. |
| AC2 | Weak | awaits the refetch (web-first assertion, no snapshot race) and re-checks the count, but confirms distinctness only via the **first row's** text — not that the whole batch differs. A coincidental first-row match could pass; tighten to compare the full page-2 batch against page 1. |
| AC3 | Covered | asserts the page indicator reads `Page 1`, then `Page 2` after advancing. The criterion's "e.g. Page 2 of N" is illustrative, so asserting the page number faithfully reflects the current page. |

**Fixes**
- AC2: compare the full set of page-2 row texts against page 1 (e.g. collect all row texts on each
  page and assert no overlap), rather than checking only the first row — advisory, not blocking.

**Disposition** — nothing blocks; AC2 (`Weak`) is advisory.
