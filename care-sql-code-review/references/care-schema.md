# CARE Physical Schema Reference (for raw SQL)

Lookup facts for reviewing raw Postgres against the CARE database. The *how to think* lives in
`SKILL.md`; this is the *what* — table-name map, physical indexes, JSONB/array hotspots, and the
hub/join map. Column and table names drift as models change, so verify against the live schema
(`\d emr_<table>` in psql, or the model source in the `care` repo) before trusting a detail here.

## Table of contents
1. [Table naming & the model→table map](#1-table-naming)
2. [Physical indexes — what's fast, what isn't](#2-physical-indexes)
3. [Record validity: status first, deleted second](#3-record-validity-status-first-deleted-second)
4. [JSONB & array columns (unindexed hotspots)](#4-jsonb--array-columns)
5. [Hub/join map](#5-hubjoin-map)
6. [Common columns & gotchas](#6-common-columns--gotchas)

---

## 1. Table naming

Django names tables `emr_<lowercased-model-class>` — words are concatenated, no underscores
inside a model name. Users are in `users_user` (app `users`). Junction/history models get their
own tables, e.g. `emr_organizationuser`, `emr_facilitylocationencounter`.

**Frequently-queried tables:**

| Table | Model | Notes |
|-------|-------|-------|
| `emr_patient` | Patient | demographics; has `organization_cache`, `users_cache` arrays |
| `emr_patientidentifier` | PatientIdentifier | `value` (indexed), `config_id` → identifier type |
| `emr_patientidentifierconfig` | PatientIdentifierConfig | the "type" behind a magic `config_id` |
| `emr_encounter` | Encounter | `patient_id`, `facility_id`, `status` |
| `emr_facilitylocation` | FacilityLocation | tree via `parent_id`, `root_location_id`; `form`, `status` |
| `emr_facilitylocationencounter` | FacilityLocationEncounter | bed/location occupancy: `location_id`, `encounter_id`, `status`, `start_datetime`, `end_datetime` |
| `emr_invoice` | Invoice | `number`, `total_gross`, `status`, `patient_id`, `account_id` |
| `emr_chargeitem` | ChargeItem | `account_id`, `patient_id`, `encounter_id`, `tags` array |
| `emr_account` | Account | billing spine (`PROTECT`ed) |
| `emr_paymentreconciliation` | PaymentReconciliation | payments against invoices |
| `emr_medicationrequest` / `emr_medicationdispense` | … | pharmacy |
| `emr_observation` | Observation | ~10 JSONB columns |
| `emr_organization` / `emr_facilityorganization` | … | hierarchy via `parent_id`, `parent_cache` |
| `users_user` | users.User | `first_name`, `last_name`, `prefix`; join via `updated_by_id`/`created_by_id` |

Full model list (derive the table as `emr_` + lowercase): see the `care/emr/models/` source.

## 2. Physical indexes

Every `emr_*` table inherits these indexes from the base model — **present on the physical table**,
so filtering/joining on them is fast:

| Column | Type | Indexed | Use in SQL |
|--------|------|---------|-----------|
| `id` | bigint PK | yes (PK) | internal join key — join on `*_id` |
| `external_id` | uuid | yes (unique) | stable public key; use when an id must survive across environments |
| `created_date` | timestamptz | yes | time-range filters / ordering |
| `modified_date` | timestamptz | yes | time-range filters / ordering |
| `deleted` | boolean | yes | **must be filtered explicitly — see §3** |

Plus a B-tree on **every foreign-key column** (`patient_id`, `encounter_id`, `facility_id`,
`account_id`, `location_id`, `config_id`, `updated_by_id`, …). Joining on these is indexed.

**Hand-declared extra indexes (the only ones beyond the above):**
- `emr_patientidentifier.value` — B-tree
- `emr_specimen.accession_identifier` — B-tree
- `emr_valueset.slug` — unique
- `emr_resourcecategory (slug, facility_id)` — composite
- `emr_metaartifact (associating_type, associating_external_id)` — composite

**What defeats these indexes:** wrapping the column in a function (`DATE(created_date)`,
`TRIM(...)`, `LOWER(...)`), leading-wildcard `LIKE '%x'`, or a type mismatch. Rewrite function-
on-column filters as sargable ranges.

## 3. Record validity: `status` first, `deleted` second

Two separate "does this row count?" mechanisms — and the important one is **not** `deleted`.

**`deleted` (the weaker one).** Every table has it and the ORM auto-adds `WHERE deleted = FALSE`,
which raw SQL does not — so include it per table where it applies (it's indexed, cheap). **But
health records are almost never deleted** (you don't hard/soft-delete clinical data), so `deleted`
is seldom `TRUE` and this filter, while correct to include, catches very little on its own.

**`status` (the one that actually matters).** Records are invalidated by lifecycle status while
staying `deleted = FALSE`:
- **`entered_in_error`** — created by mistake, treat as if it never existed. **Exclude from
  essentially every report.** Present on most resources (27 status enums reference it): medication
  request/dispense/administration, invoice, payment_reconciliation, observation, condition,
  allergy, consent, encounter, slot, questionnaire_response, inventory product/item, supply
  request/delivery, form_submission, and more.
- **Terminal / void statuses** — exclude depending on report intent. Seen across resources:
  `cancelled` (10), `inactive` (10), `retired` (8), `stopped` (5), `abandoned` (4), `ended` (3),
  `not_done` (2), `revoked` (1), `discontinued` (1). Example: `MedicationRequestStatus` =
  `active, on_hold, stopped, completed, cancelled, entered_in_error, draft`
  (`care/emr/resources/medication/request/spec.py:39`).

For each table ask: does it have `status`, and does the report require excluding `entered_in_error`
(almost always yes) and the relevant terminal statuses? Status is free-text `varchar` (no DB enum);
confirm exact strings in `care/emr/resources/<domain>/spec.py`.

## 4. JSONB & array columns

No GIN index exists anywhere in CARE, so `->>`/`#>>` key access and `@>`/`&&` containment are
**sequential scans**. Fine for small/definition tables; flag on large transactional tables.

**Universal JSONB (every `emr_*` table):** `meta`, `history`. Don't `SELECT *` when you don't need
them — they can be large.

**Heavy domain JSONB:** `emr_observation` (~10), `emr_encounter` (~6), `emr_questionnaire*` (~6),
`emr_productknowledge` (~5), `emr_patient` (~5), `emr_chargeitem` (~5), `emr_specimen` (~4),
`emr_medicationadministration` (~4).

**`ArrayField(integer[])` caches — queried by containment, unindexed:**

| Column | Table | Meaning |
|--------|-------|---------|
| `organization_cache` | `emr_patient` | orgs the patient belongs to |
| `users_cache` | `emr_patient` | users with access |
| `parent_cache` | `emr_organization`, `emr_resourcecategory` | ancestor ids (hierarchy) |
| `managing_organizations` | `emr_facilityorganization` | managing org ids |
| `tags` | `emr_chargeitem` | tag ids |

## 5. Hub/join map

Almost every clinical row carries **`patient_id` and `encounter_id`**, and most tables carry
**`facility_id`** (the tenant boundary). Secondary hubs: `account_id` (billing:
`emr_chargeitem`, `emr_invoice`, `emr_paymentreconciliation`), and the organization tables (auth
& hierarchy). User attribution is `created_by_id` / `updated_by_id` → `users_user.id`.

Common joins seen in the repo:
- Invoice → patient → identifier: `emr_invoice.patient_id = emr_patient.id`, then
  `emr_patientidentifier.patient_id = emr_patient.id AND config_id = <type>` (LEFT — a patient may
  lack that identifier). Beware fan-out: multiple identifiers multiply invoice rows.
- Location tree: `emr_facilitylocation` self-joined via `parent_id` for floor/ward rollups.
- Occupancy: `emr_facilitylocationencounter` → `emr_encounter` → `emr_patient`, with
  `DISTINCT ON (patient_id)` to avoid double-counting.

## 6. Common columns & gotchas

- **`status`** is a free-text `varchar` (no DB enum) and the **primary record-validity axis** (see
  §3) — not just a filter dimension. Values come from the resource spec, e.g. invoice
  `'issued'`/`'balanced'`/`'cancelled'`, location/encounter `'active'`, occupancy
  `'active'`/`'reserved'`, questionnaire response `'completed'`. Almost every report should exclude
  `'entered_in_error'`. Confirm exact strings against the model/spec — a wrong literal silently
  returns nothing.
- **Money** (`total_gross`, charge/price fields) is `numeric` — never cast to float; watch integer
  division and tax rounding; keep the aggregation grain consistent (invoice vs line item).
- **Name display**: users/patients need `COALESCE` around nullable name parts and `prefix`;
  `a || NULL` is NULL.
- **Magic integer IDs** (`config_id = 21`, `root_location_id = 300`, `parent_id IN (…)`) are
  internal PKs, per-deployment. Prefer a lookup by a stable key (e.g. join
  `emr_patientidentifierconfig` by name) or a parameter; at minimum document them in Notes.
- **`external_id` (uuid)** is the value the API and front-end use; if a query must be portable
  across environments or joined to app-exported data, key on `external_id`, not `id`.
