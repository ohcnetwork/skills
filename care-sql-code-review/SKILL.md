---
name: care-sql-code-review
description: >-
  Review raw SQL for the CARE analytics repo (care_analytics_sql) — hand-written
  Postgres queries that power Metabase dashboards and run directly against the CARE
  database's physical tables (emr_*, users_user). Use this whenever reviewing,
  writing, or debugging an analytics SQL query or its diff: new report queries,
  changes to existing ones, reported wrong numbers, or slow dashboards. It checks
  correctness (status-based record validity — excluding entered_in_error and terminal
  statuses — join fan-out inflating money totals, tenant/facility scoping, NULL
  handling), performance (sargability, unindexed JSONB/array access), and
  maintainability (hardcoded magic IDs, parameter docs). CARE-specific: it knows the
  emr_* schema, which columns are indexed, and the traps created because raw SQL
  bypasses the Django ORM's automatic filtering — including that clinical records are
  invalidated by status (entered_in_error), not by the deleted flag. Prefer
  this over the generic sql-code-review skill for anything under care_analytics_sql or
  any SQL querying the CARE database.
---

# CARE Analytics SQL Review

These are **hand-written Postgres queries** in `care_analytics_sql/` that run directly against
the CARE production database's physical tables and feed Metabase dashboards. Generic SQL
best-practice review still applies (sargability, join correctness, `DISTINCT` misuse,
injection) — this skill adds the CARE-schema knowledge and, most importantly, the traps that
appear **because raw SQL bypasses the Django ORM**. The ORM did several things automatically
that the SQL author must now do by hand and can silently forget. Those inversions are where the
real bugs are.

Read `references/care-schema.md` for the model→table name map, the physical index inventory,
and the JSONB/array hotspots — it's the lookup table so this file can stay about *how to think*.

## Orient yourself first

- **Table names are `emr_<lowercased-model-name>`** — `Patient`→`emr_patient`,
  `FacilityLocationEncounter`→`emr_facilitylocationencounter`, `PatientIdentifier`→
  `emr_patientidentifier`. Users live in `users_user`. Full map in the reference.
- **Files follow `TEMPLATE.md`**: description, parameters table, the SQL, output columns, notes.
  A query missing the parameter/notes sections — especially where it has hardcoded IDs — is
  itself a review finding (see maintainability).
- **Metabase templating:** `{{param}}` is a bound parameter and `[[AND {{param}}]]` is an
  *optional* filter (whole clause disappears when the param is empty). These are Metabase field
  filters and are parameterized — don't "fix" them into string literals. Do flag any place a
  `{{text}}` param is concatenated into an identifier or unparameterized position.
- **Deployment suffixes** (`_ssmm`, `_pallium`, `_kc`) mean the query is written for one
  facility/tenant and very likely contains hardcoded IDs for it. That's expected — but it must be
  documented, and it's a signal to check the hardcoded-ID and facility-scoping items below.

## The inversions — what the ORM did for free that raw SQL must do by hand

This is the heart of the review. Every one of these is automatic in the CARE backend and
**manual (and forgettable) here.**

1. **Record validity is a `status` question, not a `deleted` flag — the #1 correctness bug.**
   Every table has a `deleted` column and the ORM's default manager adds `WHERE deleted = FALSE`,
   which raw SQL does not — so include `deleted = FALSE` on each table where it applies. **But
   `deleted` is rarely set: you don't delete health records, you invalidate them by status.** A row
   almost always stays `deleted = FALSE` while being clinically or financially void, so the
   `deleted` filter is low-signal and *not enough on its own.*
   The real "this row doesn't count" axis is the resource's **`status`**:
   - **`entered_in_error` means the record was created by mistake and must be treated as if it never
     existed. Exclude it from essentially every report** — counts, money, clinical rollups. It is
     the single most forgotten filter and appears on most resources (medication, invoice, payment,
     observation, condition, allergy, consent, encounter, …).
   - **Domain terminal/void statuses** depend on what's being counted: `cancelled`, `stopped`,
     `discontinued`, `revoked`, `abandoned`, `not_done`, `retired`, `inactive`, `ended`. A revenue
     report must drop `cancelled` invoices; an active-prescription count must drop
     `stopped`/`completed`/`cancelled`; and so on.
   So for **each** `emr_*` table in the query (every JOIN and CTE, not just the driving table) ask:
   does it have a `status`, and does the report's intent require excluding `entered_in_error` and
   the relevant terminal statuses? A missing `entered_in_error` exclusion silently inflates counts
   and money totals — treat it as Critical. Confirm the exact status strings against the resource
   spec (see the reference); they're free-text `varchar`, not a DB enum.

2. **Tenant/facility scoping is NOT automatic.** The application enforces facility boundaries; a
   raw query does not. A report that omits a `facility_id = …` (or an equivalent join constraint)
   returns or aggregates **across all facilities** — a data-leak and a wrong-number bug at once.
   Confirm the intended facility scope is actually in the predicate, not just implied by the
   filename suffix.

3. **Indexes still exist, but only if you don't defeat them.** The physical tables keep every
   index the ORM relies on: `external_id`, `created_date`, `modified_date`, `deleted`, and a
   B-tree on **every `*_id` foreign key**. So joins on `*_id` and filters on those columns are
   indexed. What breaks it:
   - **Wrapping an indexed column in a function** — `DATE(fle.start_datetime) <= {{d}}`,
     `TRIM(...)`, `LOWER(email)` — makes the index unusable (not sargable). Rewrite as a range:
     `start_datetime >= {{d}} AND start_datetime < {{d}} + INTERVAL '1 day'`.
   - **JSONB access** (`meta ->> 'x'`, `history #>> …`) and **array containment**
     (`organization_cache @> …`) have **no GIN index anywhere in CARE** — on a big table these are
     sequential scans. Flag on any hot/large-table query. See the reference for which columns.

4. **`id` vs `external_id`, and hardcoded magic IDs.** Inside the DB, joins correctly use internal
   `*_id` bigints — that's fine and fast. The trap is **hardcoded integer IDs**: `config_id = 21`,
   `root_location_id != 300`, `parent_id NOT IN (19, 44)`. These are internal, environment-specific
   PKs that mean nothing in another deployment and break silently when data changes. They must be
   (a) explained in the Notes section, and ideally (b) lifted into a parameter or a lookup by a
   stable business key (e.g. an identifier config's name, not its id). Treat an undocumented magic
   number as a finding.

## What to look for (in priority order)

### Correctness — wrong numbers are worse than slow numbers
- **Status validity on every table** (inversion 1) — is `entered_in_error` excluded, plus the
  terminal statuses the report's intent requires? Then `deleted = FALSE` where it applies. Check
  each JOIN/CTE, not just the driving table.
- **Facility scoping present** (inversion 2).
- **Join fan-out inflating aggregates.** A one-to-many join before a `SUM`/`COUNT` multiplies rows
  — a patient with 3 identifiers makes their invoice amount count 3×. This is the classic money-
  report bug. Look for `SUM(...)`/`COUNT(...)` downstream of a join that isn't one-to-one; the fix
  is pre-aggregating in a CTE, `COUNT(DISTINCT …)`, or a `LATERAL`/scalar subquery. The
  `DISTINCT ON` in the bed-occupancy query exists for exactly this reason.
- **`INNER` where `LEFT` was meant** (or vice-versa) — an inner join to an optional table
  (identifier, encounter, user) silently drops rows that should appear with NULLs.
- **NULL handling in money/text concatenation** — `a || b` is NULL if either side is NULL;
  CARE queries use `COALESCE(...)` around name parts and amounts for this reason. Missing
  `COALESCE` on a nullable column corrupts the row.
- **`status` string filters** match CARE's exact values (`'active'`, `'issued'`, `'completed'`,
  `'reserved'`…) — free-text `varchar`, so a typo'd or stale status silently returns nothing or the
  wrong slice. This is also the invalidation axis from inversion 1 (`entered_in_error` et al.).

### Performance
- **Sargability** — no functions on indexed/filtered columns (inversion 3).
- **JSONB / array access on large tables** — unindexed, call it out (inversion 3).
- **CTE materialization** — in older Postgres a CTE is an optimization fence; a CTE scanned
  multiple times or filtered after the fact may be better inlined or filtered inside.
- **`SELECT *`** in a report/drill-down pulls the fat `meta`/`history` JSONB for no reason — list
  the needed columns.
- **`ORDER BY` without `LIMIT`** on a dashboard tile that only shows a few rows.

### Maintainability
- **Hardcoded magic IDs documented or parameterized** (inversion 4).
- **Parameters and Notes sections present and accurate** per `TEMPLATE.md`; hardcoded values
  called out in Notes; `Last updated` touched.
- **Consistent, qualified column references** (`emr_invoice.status`, not bare `status`) in
  multi-table queries — avoids ambiguity when a column exists on several tables.

### Money & decimals (accounting/inventory queries)
- Amounts are `numeric` — watch integer division, rounding, and tax/GST math; keep currency in
  `numeric`, never `float`. Verify the aggregation grain matches the report (per-invoice vs
  per-line-item vs per-charge-item) — mixing grains double-counts revenue.

## Output format

Group by severity, lead with correctness (wrong numbers), and for each finding give:

```
### [SEVERITY] <short title>
**Where:** <file · which CTE / join / line>
**Issue:** <what's wrong in SQL terms>
**Why it matters here:** <tie to a CARE inversion or a concrete wrong-number/perf cost>
**Fix:** <the corrected SQL snippet — the added deleted filter, the range rewrite,
          the DISTINCT/pre-aggregation, the parameterized id>
```

Severities: **Critical** (wrong numbers or data leak — missing `deleted = FALSE`, join fan-out on
a money total, missing facility scope), **High** (sargability killing a dashboard, wrong join
type, undocumented magic ID that will break on data change), **Medium** (`SELECT *`, missing
`COALESCE`, missing param docs), **Low** (naming, qualification, formatting).

Close with a one-line verdict: are the numbers trustworthy and is it safe to publish to the
dashboard, plus the top 1–3 fixes. If the query correctly filters soft-deletes, scopes to
facility, and its aggregates are grain-correct, say so plainly — don't manufacture findings.
