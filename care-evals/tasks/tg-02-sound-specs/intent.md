# Code-reconstructed intent — User departments list pagination

The departments tab fetches departments with `limit=10&offset=(page-1)*10` and renders them in a
table. A pager shows **Next**/**Previous** controls and a "Page X of N" indicator derived from the
total count. **Next** increments the page, refetches the next offset window, and updates both the
table rows and the indicator; it is disabled on the last page.

In the graded scenario the facility has **23 departments**, so page 1 and page 2 are full at 10
rows each and page 3 holds the remaining 3 — the list exceeds one page, so a full first page is
exactly 10 rows.

Provided as the cross-check; `criteria.md` is the ground truth for grading.
