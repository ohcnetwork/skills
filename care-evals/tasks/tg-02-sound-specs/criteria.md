# Acceptance Criteria — User departments list pagination

The facility **Users → Departments** list is paginated at a page size of 10. The graded scenario
has **more than one page** of departments (see intent), so every non-final page is full.

- **AC1**: On first load, with the list exceeding one page, the departments table shows **exactly
  10 rows** — the page-size cap.
- **AC2**: Clicking **Next** advances to **page 2** and shows the next batch of rows (distinct from
  page 1's rows).
- **AC3**: The page indicator reflects the **current page number** (e.g. shows "Page 2 of N" after
  advancing).
