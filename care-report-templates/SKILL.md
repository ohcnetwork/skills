---
name: care-report-templates
description: Reference for creating Jinja2 report templates in the CARE EMR system. Use when creating, editing, or debugging report templates. Covers available context variables, nested data, custom filters, globals, and template patterns.
user-invocable: true
argument-hint: "[encounter|patient|account]"
---

# CARE Report Template Reference

Templates are Jinja2 HTML rendered in a locked-down **ImmutableSandboxedEnvironment** (`ReportSandbox`) with `StrictUndefined` and `autoescape=True`. `trim_blocks` and `lstrip_blocks` are enabled. Each template uses **exactly one** context (`encounter` OR `patient` OR `account` — mutually exclusive). The root variable is determined by the chosen context. `current_user` is always available. HTML output is then run through an allowlist sanitizer — see [HTML & PDF Output Rules](#html--pdf-output-rules).

Before creating a template, read the example templates in `~/.claude/skills/care-report-templates/examples/` for real-world patterns, and the [Gotchas](#gotchas) — most broken templates hit one of them.

Source of truth: `care/emr/reports/context_builder/data_points/*.py` in the CARE backend (each `Field(...)` is a datapoint; `filterset_class` lists the filters). Field lists below match upstream `develop` as of 2026-11 (ENG-513).

---

## Report Contexts

### `encounter` (slug: `encounter_base`)

Root variable: `encounter`

#### Direct Fields

| Field | Type | Example |
|-------|------|---------|
| `status` | string | Planned, In Progress, Completed, Cancelled, Entered in Error |
| `encounter_class` | string | Inpatient, Outpatient, Observation, Emergency, Virtual, Home Health |
| `start_time` | datetime string | `2026-01-12T10:01:45.088000Z` |
| `end_time` | datetime string or `"Ongoing"` | |
| `priority` | string | ASAP, Emergency, Routine, Urgent, Stat, Elective, etc. |
| `discharge_summary_advice` | string | |
| `external_identifier` | string | |
| `extensions` | dict | `encounter.extensions.encounter_attender.attender_name` |
| `created_date` | datetime string | Always set on a real encounter — doubles as a presence check (see [Gotchas](#gotchas)) |
| `modified_date` | datetime string | |
| `created_by` | single: `.full_name`, `.id` | User who created the encounter |
| `updated_by` | single: `.full_name`, `.id` | User who last updated it |

#### Nested Single Objects

| Access Path | Fields |
|-------------|--------|
| `encounter.patient` | See [Patient Fields](#patient-fields) |
| `encounter.facility` | See [Facility Fields](#facility) |
| `encounter.current_location` | `.name` |
| `encounter.hospitalization` | `.re_admission`, `.admit_source`, `.discharge_disposition`, `.diet_preference` |

#### Nested Iterables

| Access Path | Item Fields | Filterable |
|-------------|-------------|------------|
| `encounter.care_team` | `.user.full_name`, `.user.id`, `.role` (each `.user` access is a DB query) | No (`.filter()` is broken here — iterate) |
| `encounter.organizations` | `.organization` | No |
| `encounter.patient_facility_tags` | `.display` | category, status |
| `encounter.encounter_tags` | `.display` | category, status |
| `encounter.facility_identifiers` | `.config.display`, `.config.use`, `.config.auto_maintained`, `.value` | No |

#### Nested Querysets

| Access Path | Filter Params | Details |
|-------------|---------------|---------|
| `encounter.diagnostic_reports` | status | See [Diagnostic Reports](#diagnostic-reports) |
| `encounter.symptoms` | clinical_status, verification_status, exclude_clinical_status, exclude_verification_status | See [Symptoms](#symptoms) |
| `encounter.allergy_intolerances` | clinical_status, verification_status, exclude_clinical_status, exclude_verification_status | See [Allergy Intolerances](#allergy-intolerances) |
| `encounter.diagnoses` | clinical_status, verification_status, exclude_clinical_status, exclude_verification_status | See [Diagnoses](#diagnoses) |
| `encounter.questionnaire_responses` | **slug (REQUIRED)** | See [Questionnaire Responses](#questionnaire-responses) |
| `encounter.medication_prescriptions` | status | See [Medication Prescriptions](#medication-prescriptions) |
| `encounter.service_requests` | status, intent, category, priority | See [Service Requests](#service-requests) |

---

### `patient` (slug: `patient_base`)

Root variable: `patient`

#### Patient Fields

| Field | Type | Example |
|-------|------|---------|
| `name` | string | John Doe |
| `gender` | string | Male, Female, Non binary, Transgender |
| `age` | string | 45 Y |
| `blood_group` | string | A Positive |
| `address` | string | 123 Main St, Springfield |
| `phone_number` | string | +91 9876543210 |
| `date_of_birth` | date string | 1978-05-15 |
| `deceased_datetime` | datetime string | |
| `extensions` | dict | `patient.extensions.patient_demographics.related_person` |

#### Nested

| Access Path | Item Fields | Filterable |
|-------------|-------------|------------|
| `patient.instance_identifiers` | `.config.display`, `.config.use`, `.config.auto_maintained`, `.value` | No |
| `patient.instance_tags` | `.display` | category, status |

---

### `account` (slug: `account_base`)

Root variable: `account`

#### Direct Fields

| Field | Type | Example |
|-------|------|---------|
| `external_id` | string | UUID |
| `name` | string | General Checkup Account |
| `status` | string | Active, Inactive, Entered in Error, On Hold |
| `billing_status` | string | Open, Billing, Closed Completed, etc. |
| `description` | string | |
| `total_gross` | decimal string | `"180.000000"` — use `\| currency` or `\| float` |
| `total_paid` | decimal string | `"100.000000"` |
| `total_balance` | decimal string | `"80.000000"` |
| `total_billable_charge_items` | decimal string | `"1455.000000"` |
| `created_date` | datetime string | |
| `calculated_at` | datetime string | |

#### Nested

| Access Path | Type | Details |
|-------------|------|---------|
| `account.patient` | single | See [Patient Fields](#patient-fields) |
| `account.facility` | single | See [Facility](#facility) |
| `account.primary_encounter` | single | Same fields as encounter (status, encounter_class, start_time, end_time, care_team, current_location, hospitalization, organizations, encounter_tags, extensions, audit fields, etc.). **Nullable** — guard with `{% if enc.created_date %}`, not `{% if enc %}` (see [Gotchas](#gotchas)) |
| `account.invoices` | queryset | Filter: status, title, number. See [Invoices](#invoices) |
| `account.charge_items` | queryset | Filter: status, title, service_resource. See [Charge Items](#charge-items) |
| `account.category_charge_items_summary` | single | See [Category Summary](#category-charge-items-summary) |
| `account.payment_reconciliations` | queryset | Filter: status, target_invoice, reconciliation_type, is_credit_note, location. See [Payment Reconciliations](#payment-reconciliations) |
| `account.total_price_components` | queryset | See [Monetary Components](#monetary-components) |

---

## Nested Data Point Details

### Facility

| Field | Example |
|-------|---------|
| `name` | City Health Center |
| `description` | A community healthcare center |
| `address` | 123 Main St, Springfield |
| `pincode` | 123456 |
| `phone_number` | +1-555-1234 |

### Diagnostic Reports

**Filter:** status (raw value, case-insensitive: `status="final"`)

| Field | Type |
|-------|------|
| `title` | string (from code.display) |
| `status` | string (Registered, Partial, Preliminary, Modified, Final, …) |
| `category` | string (category.display, e.g. Laboratory, Audiology) |
| `conclusion` | string |
| `note` | string |
| `service_request` | single: `.title` |
| `observations` | queryset — see below |
| `file_uploads` | queryset: `.name`, `.url` (filter: file_category, name) |

#### Observations (within diagnostic_report)

| Field | Type / Access |
|-------|--------------|
| `title` | string |
| `status` | string |
| `effective_datetime` | datetime string |
| `interpretation` | string |
| `value` | nested: `.value.value`, `.value.unit` |
| `reference_range` | iterable: each has `.min`, `.max`, `.interpretation` |
| `component` | iterable — see below |

#### Observation Components (within observation)

| Field | Type / Access |
|-------|--------------|
| `title` | string |
| `interpretation` | string. Undefined (and the render fails when printed) if the component stores interpretation as a plain string instead of a coding, which happens in real data. Print it as `{{ comp.interpretation \| default("-", true) }}` |
| `value` | nested: `.value.value`, `.value.unit` |
| `reference_range` | iterable: each has `.min`, `.max`, `.interpretation`. **Crashes the render** (`TypeError: 'NoneType' object is not iterable`) when the component has no `reference_range` key, which is common in real data. Don't iterate it until the backend returns `[]` there |

### Symptoms

**Filter:** clinical_status, verification_status, exclude_clinical_status, exclude_verification_status

| Field | Type |
|-------|------|
| `clinical_status` | string (Active, Resolved, etc.) |
| `verification_status` | string (Confirmed, Refuted, etc.) |
| `severity` | string (Mild, Moderate, Severe) |
| `name` | string |
| `onset` | datetime string (`onset.onset_datetime`) |
| `note` | string |
| `created_by` | single: `.full_name`, `.id`. **Crashes the render** (`TypeError: Field 'id' expected a number but got <User…>`) for any symptom that has an author: the datapoint passes a User object where it expects an id. Don't use until fixed in the backend |
| `updated_by` | same as `created_by`: crashes, don't use |

### Allergy Intolerances

**Filter:** clinical_status, verification_status, exclude_clinical_status, exclude_verification_status

| Field | Type |
|-------|------|
| `clinical_status` | string (Active, Inactive, Resolved) |
| `verification_status` | string (Unconfirmed, Confirmed, Refuted, etc.) |
| `criticality` | string (Low, High, Unable to Assess) |
| `category` | string (Food, Medication, Environment, Biologic) |
| `allergy_intolerance_type` | string (Allergy, Intolerance) |
| `name` | string |
| `note` | string |
| `last_occurrence` | datetime string |

### Diagnoses

**Filter:** clinical_status, verification_status, exclude_clinical_status, exclude_verification_status

| Field | Type |
|-------|------|
| `clinical_status` | string |
| `verification_status` | string |
| `severity` | string (Mild, Moderate, Severe) |
| `name` | string (from code.display) |
| `onset` | datetime string (`onset.onset_datetime`) |
| `note` | string |

### Questionnaire Responses

**Filter:** slug **(REQUIRED — will raise ValueError if omitted)**

Only **completed** responses are returned, newest first. An unknown slug returns an empty list (no error).

Each questionnaire response has:

| Field | Type |
|-------|------|
| `title` | string (questionnaire title) |
| `description` | string (questionnaire description) |
| `responses` | iterable — see below (rebuilt on every access: bind it or iterate once) |
| `updated_by` | single: `.full_name`, `.id` |

There is no timestamp on a questionnaire response. If the form collects time, use `answer.taken_at` per answer. Otherwise label repeat entries by `loop.index`. A form filled twice in one encounter returns two responses, so pass `limit=1` when you only want the latest.

Each response item has:

| Field | Type / Access |
|-------|--------------|
| `question` | dict (the questionnaire's question) — label via `resp.question.get('text')` |
| `answer` | dict (the stored result) — values via `resp.answer.get('values', [])`, note via `resp.answer.get('note')` |

Question dict keys: `id`, `link_id`, `text`, `type`, `code` (`code`/`system`/`display`), `unit` (`code`/`system`/`display`), `description`, `repeats`, `answer_option`, `questions` (children of a group). Types: `string`, `text`, `integer`, `decimal`, `boolean`, `date`, `dateTime`, `time`, `choice`, `quantity`, `url`, `group`, `display`, `structured`.

**Identify questions by `code` when they're coded, otherwise by normalized label.** `code.code` (LOINC/SNOMED) means the same thing across every form that uses it. Labels get edited and contain typos, punctuation (`"Admission recommended?"`) and Unicode (`SpO₂`), so normalize them once (`| lower | trim`) and match keywords, not exact strings, unless the label is a short fixed term. Don't key on `id`/`link_id`: they're per-form and change whenever a form is rebuilt.

What `qr.responses` does and doesn't contain:

- **Only answered questions.** Empty answers are never saved, so a missing question has no row — fall back at render time (`or "-"`), don't expect an empty row.
- **Groups are flattened.** Each child of a (non-repeating) group is its own row, often with a short label like `Chest` or `CVS`. The group's heading is not in the list, so find these rows by `code`, or by label within a known form slug.
- **Repeating groups** are a single row for the group. `answer.sub_results` is a list of instances, each a list of `{question_id, values, note}`; child labels come from `resp.question.questions` (match on `id`). See [Repeating groups](#repeating-group-answers).
- **Structured questions are absent.** Symptoms, diagnoses, allergies, medications and service requests entered inside a form are saved as their own records. Read them through `encounter.symptoms`, `encounter.diagnoses`, etc.

Answer dict keys: `values` (list), `note`, `body_site`, `method`, `taken_at`, `sub_results`. Each value is `{value, unit, coding}` — free-text/number answers fill `value`, coded answers fill `coding.display` (fall back to `coding.code`). `value` is always a **string**: boolean questions (`question.type == "boolean"`) store `"true"`/`"false"` (`"1"`/`"0"` also pass validation), so `is boolean` never matches. See `answer_text` in [Common Patterns](#questionnaire-response-values).

Use `.get('values')`, never `resp.answer.values` — that resolves to the dict's `.values` **method**, not the key.

### Medication Prescriptions

**Filter:** status

| Field | Type |
|-------|------|
| `name` | string |
| `status` | string (Active, On Hold, Ended, Stopped, Completed, Cancelled, Entered in Error, Draft) |
| `note` | string |
| `prescribed_by` | single: `.full_name`, `.id` |
| `tags` | queryset: `.display` (filter: category, status) |
| `medications` | queryset — see below |

#### Medications (within prescription)

**Filter:** status, exclude_status, intent, priority

| Field | Type |
|-------|------|
| `name` | string |
| `status` | string (Active, On Hold, Cancelled, Completed, etc.) |
| `intent` | string (Proposal, Plan, Order, etc.) |
| `priority` | string (Routine, Urgent, ASAP, STAT) |
| `authored_on` | datetime string |
| `note` | string |
| `dosage_instructions` | iterable — see below |

#### Dosage Instructions (within medication)

| Field | Example |
|-------|---------|
| `dosage` | "2 tablet" |
| `frequency` | "3 times every 1 day" |
| `duration` | "2 d" |
| `site` | string |
| `method` | "Injection" |
| `route` | "Oral" |

### Service Requests

**Filter:** status, intent, category, priority

| Field | Type |
|-------|------|
| `title` | string |
| `status` | string (Draft, Active, On Hold, etc.) |
| `intent` | string (Proposal, Plan, Directive, Order) |
| `category` | string (Laboratory, Imaging, Counselling, Surgical Procedure). Bucket by category at the database with the raw codes `laboratory`, `imaging`, `counselling`, `surgical_procedure`: `.filter(status="active", category="imaging")`. Python-side buckets that miss a category drop those rows silently |
| `priority` | string (Routine, Urgent, ASAP, Stat) |
| `requester` | single: `.full_name`, `.id` |
| `occurance` | datetime string — **spelled `occurance`** (matches the BE model field) |
| `patient_instruction` | string |
| `note` | string |
| `tags` | queryset: `.display` (filter: category, status) |

### Invoices

**Filter:** status, title, number

| Field | Type |
|-------|------|
| `title` | string |
| `status` | string (Draft, Issued, Balanced, Cancelled, Entered in Error) |
| `number` | string |
| `total_net` | decimal string |
| `total_gross` | decimal string |
| `total_price_components` | iterable — see [Monetary Components](#monetary-components) |

### Charge Items

**Filter:** status, title, service_resource

| Field | Type |
|-------|------|
| `title` | string |
| `status` | string (Planned, Billable, Not Billable, Aborted, Billed, Paid, Entered in Error) |
| `service_resource` | string (Service Request, Medication Dispense, Appointment, Bed Association) |
| `quantity` | string (use `\| int` for numeric) |
| `total_price` | decimal string |
| `paid_on` | datetime string |
| `created_date` | datetime string |
| `unit_price_components` | iterable — see [Monetary Components](#monetary-components) |
| `total_price_components` | iterable — see [Monetary Components](#monetary-components) |
| `paid_invoice` | single: `.title`, `.number` |

### Category Charge Items Summary

Access via `account.category_charge_items_summary`.

| Field | Type |
|-------|------|
| `category_charge_items` | iterable — see below |
| `category_returned_charge_items` | iterable — same structure as above, for refunded items |

Each category item:

| Field | Type |
|-------|------|
| `category` | single: `.title`, `.description` |
| `charge_items` | iterable of charge items (same fields as [Charge Items](#charge-items)) |
| `total_charge_items_price` | decimal string |
| `total_paid_charge_items_price` | decimal string |
| `total_billable_charge_items_price` | decimal string |
| `total_billed_charge_items_price` | decimal string |

### Monetary Components

| Field | Type |
|-------|------|
| `monetary_component_type` | string (Base, Surcharge, Discount, Tax, Informational) |
| `code` | string |
| `factor` | decimal string |
| `amount` | decimal string |

### Payment Reconciliations

**Filter:** status, target_invoice, reconciliation_type, is_credit_note, location

| Field | Type |
|-------|------|
| `status` | string (Active, Cancelled, Draft, etc.) |
| `reconciliation_type` | string (Payment, Adjustment, Advance) |
| `amount` | decimal string |
| `reference_number` | string |
| `kind` | string (Deposit, Periodic Payment, Online, Kiosk) |
| `is_credit_note` | `"True"` / `"False"` string — compare with `== "True"` (both strings are truthy) |
| `issuer_type` | string (Patient, Insurer) |
| `outcome` | string (Queued, Complete, Error, Partial) |
| `method` | string (Cash, Credit Card, Check, etc.) |
| `target_invoice` | single: `.title`, `.number` |
| `created_date` | datetime string |

`account.total_paid` = Σ active+complete payments − Σ active+complete credit notes. To list the rows that make up that number, filter `status="active"` and subtract credit notes; prefer printing `account.total_paid` over re-summing in the template.

---

## Queryset Filtering

Querysets support `.filter(**kwargs)` which applies Django-filter backends at the database level. Filter values are the **raw codes** (`"active"`, `"entered_in_error"`), not the display strings the fields return (`"Active"`). Unknown kwargs are ignored; `limit=n` slices. Pipe through `| list` if you need length checks, indexing, or a second pass — every iteration of an unmaterialized queryset re-runs the query.

**Each `.filter()` call currently costs 2 queries:** the context builder first loads the *whole unfiltered* list (`if val and …` in `ContextBuilderBase.__getattribute__` truth-tests the queryset), then runs the filtered query. `questionnaire_responses.filter(slug=…, limit=1)` loads every completed response of the encounter first. So call each `.filter()` once and `| list` the result. Use `.filter()` because it is correct (raw codes, the required `slug`, filters `selectattr` can't express), not because it is faster — for small lists, `| list` once plus `selectattr` costs the same.

```jinja2
{# Basic filter #}
{% set allergies = encounter.allergy_intolerances.filter(exclude_clinical_status="inactive") | list %}

{# Multiple filters #}
{% set active_meds = prescription.medications.filter(status="active") | list %}

{# Exclude filters (symptoms, diagnoses, allergy_intolerances) #}
{% set symptoms = encounter.symptoms.filter(exclude_verification_status="entered_in_error") | list %}

{# REQUIRED slug filter for questionnaires #}
{% set qr = encounter.questionnaire_responses.filter(slug="vitals_form") | list %}

{# Limit results #}
{% set top5 = encounter.diagnoses.filter(clinical_status="active", limit=5) | list %}

{# Filter by title (charge items — uses icontains) #}
{% set items = account.charge_items.filter(title="Admission Charge") | list %}
```

---

## Custom Filters

| Filter | Usage | Default Format | Notes |
|--------|-------|----------------|-------|
| `date` | `{{ value \| date }}` or `{{ value \| date("%Y-%m-%d") }}` | `%d/%m/%Y` | Parses ISO strings or datetime objects. Converts to IST via `localtime()` |
| `datetime` | `{{ value \| datetime }}` or `{{ value \| datetime("%d/%m/%Y %I:%M %p") }}` | `%d/%m/%Y %I:%M %p` | Same parsing + IST conversion |
| `time` | `{{ value \| time }}` | `%I:%M %p` | Same parsing + IST conversion |
| `currency` | `{{ value \| currency }}` or `{{ value \| currency("$") }}` | `₹` | Indian comma grouping: `₹1,23,456.78` |
| `phone` | `{{ value \| phone }}` | — | Formats `+91` or 10-digit Indian numbers |

**Date/time fields from context** (e.g., `encounter.start_time`, `charge_item.created_date`) are aware UTC datetime strings. Piping through `| datetime` or `| date` converts to IST automatically.

---

## Global Functions

| Function | Usage | Output (IST) |
|----------|-------|--------------|
| `current_date` | `{{ current_date() }}` | `18/11/2026` |
| `current_datetime` | `{{ current_datetime() }}` | `18/11/2026 03:45 PM` |
| `current_time` | `{{ current_time() }}` | `03:45 PM` |

They take **no arguments** (ENG-553): the result is already converted to IST (`settings.TIME_ZONE`) and formatted. `current_datetime("%Y…")` raises `TypeError` and fails the whole render — the old `current_datetime("%Y-%m-%dT%H:%M:%S%z") | datetime` workaround is obsolete. A custom format is not possible: `current_date() | date("%d %b %Y")` cannot re-parse `18/11/2026` and returns it unchanged.

---

## `current_user`

Always available regardless of context:

```jinja2
{{ current_user.full_name }}
{{ current_user.id }}
```

In previews (and if the generating user no longer exists) it is the sample user `John Doe` with an empty `id`.

---

## Useful Jinja2 Built-ins

| Filter/Function | Usage |
|-----------------|-------|
| `default(val)` / `d` | `{{ x \| default("-") }}` — fallback **only if undefined**. Datapoints return `""` for null, so use `{{ x or "-" }}`. Use `default("-", true)` where the datapoint itself can fail on bad data (see Gotchas) |
| `length` | `{{ items \| length }}` (materialize querysets with `\| list` first) |
| `first` / `last` | `{{ items \| first }}` — undefined (→ error under StrictUndefined) when empty; use `\| first \| default(none)` or `{% for %}…{% else %}` |
| `join(sep)` | `{{ items \| join(", ") }}` |
| `groupby(attr)` | `{% for group in items \| groupby("type") %}` — `.grouper` and `.list` |
| `selectattr` / `rejectattr` | `items \| selectattr("status", "equalto", "Active") \| list` |
| `map(attribute=)` | `items \| map(attribute="name") \| list` |
| `sum` / `min` / `max` | Decimal strings need converting first: `{{ cats \| map(attribute="total_charge_items_price") \| map("float") \| sum \| currency }}` |
| `int` / `float` / `round` | `{{ value \| int }}`, `{{ value \| float }}` (`"" \| float` → `0.0`) |
| `batch(n)` | `{% for row in items \| batch(2) %}` — groups into sublists (two-column layouts without index math) |
| `capitalize` / `upper` / `lower` / `title` | String casing. Status/enum fields are already display-cased — `capitalize` would turn "Unable to Assess" into "Unable to assess" |
| `for … else` | `{% for t in tags %}…{% else %}-{% endfor %}` — `else` renders when the loop is empty |
| Multiline text | Simplest: CSS `white-space: pre-line` on the container. `replace("\n", "<br>" \| safe)` is also safe — with a Markup replacement Jinja escapes the text first, so a trailing `\| safe` is redundant. **Unsafe:** `replace("\n", "<br>") \| safe` (plain-string replacement), which prints user text unescaped |
| `tojson` | `{{ data \| tojson }}` |
| `format` | `{{ "%.2f" \| format(value \| float) }}` — printf-style |
| `namespace()` | `{% set ns = namespace(total=0) %}` — mutable state across scopes |

---

## Extensions

Extensions are **dict** fields that vary by facility/plugin configuration. You must know the extension name and field path:

```jinja2
{# Encounter extensions #}
{{ encounter.extensions.encounter_attender.attender_name }}

{# Deep access, safe for missing keys AND explicit nulls — resolve once, reuse #}
{% set attender = (encounter.extensions.get('encounter_attender') or {}).get('attender') or {} %}
{{ attender.get('attender_name', '') }}

{# Patient extensions #}
{{ patient.extensions.patient_demographics.related_person }}
```

Extensions keys are facility-specific and not standardized. `extensions` itself is always a dict (`{}` when empty), so `is mapping` on it is redundant; use `.get(...) or {}` for each nested level — dot access on a missing key is undefined, and `or`/`if` on an undefined value raises under StrictUndefined.

---

## Sandbox Restrictions

- No `import`/`include`/`extends` (there is no template loader) — macros must live in the same template
- No access to Python builtins (`open`, `eval`, `exec`, etc.)
- No dunder attribute access (`__class__`, `__globals__`, etc.)
- No `getattr`/`setattr`
- On context objects, only declared datapoints (and `.filter` on querysets) are readable — `encounter.context`, `.is_preview`, `.get_iterable` raise `SecurityError`. `encounter['status']` works the same as `encounter.status`
- Plain lists/dicts the template creates can still be mutated (`{% set _ = items.append(x) %}`), but a filter chain is almost always shorter
- Templates are pure data rendering — only registered filters, globals, and context data are available

---

## Gotchas

Verified against the live engine (2026-11). Each one either crashes the render or silently prints the wrong thing.

| Trap | Why | Do this |
|------|-----|---------|
| `{% if encounter.hospitalization %}`, `{% if account.primary_encounter %}`, `{% if obs.value %}`, `{% if medication.dosage_instructions %}…{% else %}` | Nested objects and querysets are **always truthy** — they're context objects, not values. The `else` branch never runs, so e.g. a medication with no dosage rows silently disappears | Test a field: `{% if enc.created_date %}`, `{% if obs.value.value %}`; for lists, `{% for di in med.dosage_instructions %}…{% else %}<fallback row>{% endfor %}` or `{% set xs = q \| list %}{% if xs %}` |
| Account without a primary encounter | `account.primary_encounter.start_time` / `.current_location` **raise** (UndefinedError) even inside `{% if account.primary_encounter %}` | `{% set enc = account.primary_encounter %}{% if enc.created_date %}…{% endif %}` — `created_date` is `""` only when the encounter is missing |
| `{{ x \| default("-") }}` prints nothing | Every scalar datapoint is a **string**, `""` when null — never undefined | `{{ x or "-" }}` |
| `{% if pr.is_credit_note %}`, `{% if h.re_admission %}` always true | Booleans arrive as `"True"`/`"False"` strings | `{% if pr.is_credit_note == "True" %}` |
| Arithmetic on amounts/quantities | Decimals arrive as strings (`"180.000000"`) | `\| float` / `\| int` before math; `\| currency` accepts the string directly |
| `{{ items \| first }}` on an empty list | Undefined → raises when printed or tested | `\| first \| default(none)`, or `{% for %}…{% else %}-{% endfor %}` |
| `resp.answer.values` | Dict method shadows the key | `resp.answer.get('values', [])` |
| Iterating `comp.reference_range` (observation **component**) | The datapoint returns `None` when a component has no `reference_range` key → `TypeError: 'NoneType' object is not iterable` aborts the whole report. A template can't detect it first (the object is always truthy) | Show ranges for top-level observations only (their `reference_range` is never null). Other list datapoints backed by nullable columns (`dosage_instructions`, charge-item price components, `instance_identifiers`) would fail the same way if the column were null |
| `symptom.created_by` / `symptom.updated_by` | The datapoint looks the user up by id but is given a User object → `TypeError`, report aborts. Happens for every symptom with an author | Don't print symptom authors; `encounter.created_by` and `qr.updated_by` work |
| A datapoint's own mapping raises on unexpected data (e.g. component `interpretation` stored as `"normal"` instead of a coding) | The sandbox turns the error into an **undefined** value, which raises when printed or tested | `{{ x \| default("-", true) }}` — the one place `default` helps, since it catches undefined. Errors raised while *iterating* (the `reference_range` case) can't be caught this way |
| `current_datetime("%…")` | Globals take no args | `{{ current_datetime() }}` (already IST) |
| Filter by display text: `.filter(status="Active")` | Filters take raw codes (some are `iexact`, most aren't) | `.filter(status="active")` |
| Questionnaire answer printed as `v.get('value')` only | Coded/choice answers have no `value` (they're in `coding`) → blank cell, or the row is skipped by an "is it filled?" check | One `answer_text(resp)` macro everywhere ([pattern](#questionnaire-response-values)) |
| `{% if not loop.last %}, {% endif %}` inside a loop that also has an `{% if %}` filter | `loop.last`/`loop.index` count the skipped items → trailing commas, wrong numbering | Filter in the loop header: `{% for x in xs if x.value %}`, or `xs \| map(...) \| select \| join(", ")` |
| Same questionnaire slug listed twice in a config list | Every section that loops the list prints those answers twice | `\| unique` the list |
| `replace('', '2')` (often a `₂`/`²` lost in copy-paste) | Replacing the empty string inserts the text between **every** character: `"spo2"` → `"2s2p2o222"` | Make sure the character survived; compare normalized labels once |

### Performance

Every attribute access on a context **rebuilds** the nested context, and some rebuilds hit the DB:

- `care_team[].user`: one `User` query per access
- identifier `.config`: one `PatientIdentifierConfig` query per access
- any queryset (`encounter.diagnoses`, `account.charge_items`, …): re-queried on every iteration, and every `.filter()` adds an unfiltered fetch (see [Queryset Filtering](#queryset-filtering))
- `account.category_charge_items_summary.category_charge_items`: recomputes the whole category summary each access
- each questionnaire response: `qr.responses` loads its questionnaire, and `qr.updated_by` loads its author — one query each, **per response**

So bind once (`{% set patient = encounter.patient %}`, `{% set u = member.user %}`), `| list` any queryset you touch more than once, and only read `qr.updated_by` if you print it.

Measured on real local data (2026-11, upstream develop). Medians per render over the 20 most questionnaire-heavy encounters (up to 85 responses) and all 92 accounts. Local DB round trips are nearly free, so **query counts** are what carries over to production; times show the relative cost.

| Pattern | Queries | Time |
|---------|---------|------|
| Patient fields via `encounter.patient.X` each time → `{% set p = encounter.patient %}` (+ identifier config bound) | 7 → 4 | 2.1 → 1.2 ms |
| Care team (3 members) `m.user.full_name` + `m.user.id` → `{% set u = m.user %}` | 6 → 3 | 1.8 → 0.9 ms |
| Diagnoses touched 3× → `\| list` once | 3 → 1 | 0.8 → 0.3 ms |
| Category charge summary read twice → bound list | 21 → 11 | 14.3 → 7.8 ms |
| Multi-questionnaire summary, 5 / 20 / 40 sections: re-query and rescan per section | 63 / 220 / 430 | 28 / 92 / 180 ms (worst 448 ms) |
| same, answers materialized once (`qr_cache` dicts or classify-once) | 16 / 16 / 16 | 7–8 / 10–11 / 11–14 ms |
| Classify-once without reading `qr.updated_by` | 16 → 10 | 9.4 → 7.6 ms |

Materializing questionnaire answers once is what makes the difference (12–16× at 40 sections). Classify-once runs at the same speed as a `qr_cache` that is rescanned per section (slightly flatter as sections grow); its real benefit is that section rules can't drift.

Backend fixes that would help every template (measured by patching in-process): checking `isinstance(val, Field)` before truth-testing in `ContextBuilderBase.__getattribute__` removes the extra unfiltered fetch (discharge summary example 26 → 20 queries). `select_related("questionnaire", "updated_by")` in `QuestionnaireContextBuilder.get_context` removes the per-response queries (classify-once 16 → 5).

### Preview vs. real render

The template-editor preview renders **sample data**: every field shows its preview value, and every queryset/`.filter()` yields 1–4 random sample rows **regardless of the filter arguments**. A preview proves the template parses and every path it touches exists — not that filters, empty states, or null objects (no primary encounter, no care team) behave. Reason those through with the Gotchas above.

Questionnaire previews are especially thin: every sample response is the same question (`Systolic Blood Pressure`, type `decimal`, answer `123`). So any section that picks answers by label or code renders **empty** in preview, and only a catch-all section fills.

### Review checklist

When writing, reviewing or debugging a template, go through this list. Each item has caused a real production bug.

1. **Truthiness:** no `{% if <nested object/queryset> %}`, and no `else` branch that depends on one. Presence checks test a field (`enc.created_date`) or a materialized list.
2. **Empty values:** `or "-"` rather than `| default("-")`; `| first` is followed by `| default(none)`; booleans compare against `"True"`/`"False"`.
3. **Questionnaires:**
   - every answer goes through one `answer_text()` (coded and boolean answers included)
   - questions are matched by `code` where coded, otherwise by normalized label (never `id`/`link_id`)
   - slugs are unique
   - nothing assumes structured or empty answers are present
4. **One source of truth:** each "which section does this belong to" rule exists once. A catch-all section should be "rows nobody claimed", not a second copy of every rule.
5. **Queries:**
   - nested contexts used more than once are stored in a variable
   - querysets touched twice are `| list`
   - each `.filter()` is called once and `| list`ed (every call also loads the unfiltered list)
   - category buckets come from `.filter()` (raw codes) rather than `append`-based buckets that can miss a category
6. **Duplication:** repeated table markup becomes a macro (`grid()` + `call`, `pairs()` + `batch(2)`). If observations and components repeat the same row, use one macro for both.
7. **Display values:** status/enum fields are already display-cased (no `capitalize`). Amounts go through `| currency`, dates through `| date`/`| datetime`.
8. **Output:**
   - only allowlisted tags and attributes
   - images, fonts and CSS from `data:` or allowed origins
   - real `<table>`s with `<thead>`
   - no invalid CSS — unknown properties like `line-spacing` are dropped silently
9. **Dead code:** delete macros that are never called, unused variables, and unused CSS classes. The template editor won't warn you.

---

## HTML & PDF Output Rules

Rendered HTML goes to one of two generators:

- **`html`** — passes through an allowlist sanitizer (`care/emr/reports/renderer/html_sanitizer.py`) and is served with a strict CSP.
- **`pdf`** — WeasyPrint 70 (not sanitized, but the same remote-resource policy is enforced by its URL fetcher). Supports flexbox, grid, `position: fixed` running headers, and `@page` margin boxes with `counter(page)`.

Write templates that survive the stricter (HTML) path:

| Area | Allowed | Stripped / blocked |
|------|---------|--------------------|
| Tags | Document, text, list, table, `img`, `a`, semantic sections (`header`, `footer`, `section`, `article`, `figure`, …), `style`, `link rel=stylesheet` | `script`, `svg`, `iframe`, `form`/`input`/`button`, `meta` (charset + CSP are re-inserted for you), `base`, `canvas`, media |
| Attributes | `class id title lang dir style` everywhere; `colspan rowspan width height` on `td`/`th`; `width cellpadding cellspacing border` on `table`; `src alt width height` on `img`; `href` on `a` (`https`, `http`, `mailto`, `tel`, `#`) | `align`, `valign`, `bgcolor`, `data-*`, event handlers → use CSS instead |
| Images, fonts, CSS `url()` / `@import` | `data:` URIs (raster images, fonts), or `https://` origins listed in `REPORT_ALLOWED_RESOURCE_ORIGINS` (defaults to `FACILITY_CDN`) | Any other URL — `img src` is removed. Remote SVG is rejected in PDFs. A `file_uploads[].url` (signed S3 URL) displays only if its origin is allowed |
| CSS functions | Colors, `calc`/`min`/`max`/`clamp`, `var`, `counter(s)`, gradients, transforms, selector pseudo-functions (`nth-child`, `not`, …) | Anything else, e.g. `attr()`, `element()`, `expression()` — the whole declaration is dropped |
| At-rules | `@media`, `@page` (+ margin boxes like `@bottom-center`), `@font-face`, `@supports`, `@layer`, `@container`, `@keyframes` | Others |

PDF generator options (`page_size`, `margin`, `orientation`, `stylesheets`) live on the template; a template's own `@page` rule overrides them. When `stylesheets` is empty, WeasyPrint's default CSS (bordered tables, 12pt DejaVu Sans) applies underneath your `<style>`.

---

## Common Patterns

### Bind nested contexts and materialize querysets once

```jinja2
{% set patient = encounter.patient %}
{% set diagnoses = encounter.diagnoses.filter(clinical_status="active") | list %}
{% if diagnoses %}
  {{ diagnoses[0].name }} (+{{ diagnoses | length - 1 }} more)
{% endif %}
```

### Optional primary encounter (account context)

```jinja2
{% set enc = account.primary_encounter %}
{% if enc.created_date %}  {# "" when the account has no primary encounter #}
  Admitted {{ enc.start_time | datetime }} · {{ enc.current_location.name or "-" }}
{% endif %}
```

### First item or a dash

```jinja2
{{ enc.care_team | map(attribute="user.full_name") | first | default("-") }}

{% for item in account.charge_items.filter(title="Admission Charge", limit=1) %}
  {{ item.total_price | currency }}
{% else %}-{% endfor %}
```

### Totals without a namespace

```jinja2
{% set cats = account.category_charge_items_summary.category_charge_items | list %}
Net Total: {{ cats | map(attribute="total_charge_items_price") | map("float") | sum | currency }}
```

Use `namespace()` only for state a filter chain can't express (e.g. a running total printed on every row).

### Table macro with `call` (one header/markup definition, many sections)

```jinja2
{% macro grid(title, headers) %}
<h3>{{ title }}</h3>
<table>
  <thead><tr>{% for h in headers %}<th>{{ h }}</th>{% endfor %}</tr></thead>
  <tbody>{{ caller() }}</tbody>
</table>
{% endmacro %}

{% set allergies = encounter.allergy_intolerances.filter(exclude_verification_status="entered_in_error") | list %}
{% if allergies %}
{% call grid("Allergies", ["Allergy", "Type", "Category", "Criticality"]) %}
  {% for a in allergies %}
  <tr><td>{{ a.name }}</td><td>{{ a.allergy_intolerance_type }}</td><td>{{ a.category }}</td><td>{{ a.criticality or "-" }}</td></tr>
  {% endfor %}
{% endcall %}
{% endif %}
```

Real `<table>`s beat flex-div grids for reports: `<thead>` repeats on every PDF page and no per-column CSS classes are needed.

### Official patient identifiers

```jinja2
{% set official = patient.instance_identifiers | selectattr('config.use', 'equalto', 'Official') | first | default(none) %}
{% if official %}
  {% set cfg = official.config %}  {# each .config access is a query #}
  {{ cfg.display }}: {{ official.value }}
{% endif %}
```

### Two-column layout

```jinja2
{% for pair in patient.instance_identifiers | list | batch(2) %}
<tr>
  {% for ident in pair %}{% set cfg = ident.config %}<th>{{ cfg.display }}</th><td>{{ ident.value }}</td>{% endfor %}
</tr>
{% endfor %}
```

### Observation reference range

```jinja2
{% macro ref_range(item) -%}
  {%- set r = item.reference_range | selectattr("interpretation", "equalto", item.interpretation) | first | default(none) -%}
  {%- if not r -%}-
  {%- elif r.min and r.max %}{{ r.min }} - {{ r.max }}
  {%- elif r.max %}&lt; {{ r.max }}
  {%- elif r.min %}&gt; {{ r.min }}
  {%- endif %}{% if r and item.value.unit %} ({{ item.value.unit }}){% endif -%}
{%- endmacro %}

{% for obs in report.observations %}
  {{ obs.title }}: {{ obs.value.value }} [{{ ref_range(obs) }}]
  {# not ref_range(comp): a component without a reference_range crashes the render #}
  {% for comp in obs.component %}{{ comp.title }}: {{ comp.value.value }}{% endfor %}
{% endfor %}
```

### Questionnaire response values

```jinja2
{% macro answer_text(resp) -%}
  {%- set is_bool = resp.question.get('type') == 'boolean' -%}
  {%- for v in resp.answer.get('values', []) -%}
    {%- set c = v.get('coding') or {} -%}
    {%- if is_bool -%}{{ "Yes" if (v.get('value') | string | lower) in ["true", "1"] else "No" }}
    {%- else -%}{{ v.get('value') or c.get('display') or c.get('code', '') }}
    {%- endif -%}
    {%- if not loop.last %}, {% endif -%}
  {%- endfor -%}
{%- endmacro %}

{% set qr = encounter.questionnaire_responses.filter(slug="vitals_form", limit=1) | first | default(none) %}
{% if qr %}
  {% for resp in qr.responses %}
    {{ resp.question.get('text') }}: {{ answer_text(resp) or "-" }}
    {% if resp.answer.get('note') %}Note: {{ resp.answer.note }}{% endif %}
  {% endfor %}
{% endif %}
```

### Summaries built from many questionnaires (classify once, render many)

OPD/discharge summaries often pull answers from several department forms and sort them into sections by question text. Don't re-scan every form in every section, or repeat each section's keyword test in a catch-all "is it handled?" macro. Copies of the same test drift apart, and questions then get dropped or printed twice. Instead, flatten every answer into plain data **once**, tag it with its section, and let each section `selectattr` its rows. The catch-all becomes "rows with no section", so it can't drift.

```jinja2
{# needs answer_text() from the previous pattern #}
{% set forms = ["general-med-opd", "cardiology-opd"] | unique | list %}  {# a repeated slug would render every answer twice #}
{# Ordered — first match wins, so put specific rules before broad ones.
   "=x" matches a question code or the exact (lowercased) label; plain "x" is a substring of the label.
   Prefer codes; label keywords are the fallback for uncoded questions. #}
{% set rules = [
  ("investigations", ["previous investigation", "other investigation"]),
  ("history",        ["history"]),
  ("vitals",         ["=8302-2", "=29463-7", "=height", "=weight", "=bmi", "spo2", "blood pressure"]),
  ("advice",         ["other advice", "=note", "=notes"]),
] %}

{% set items = [] %}
{% for slug in forms %}
  {% for qr in encounter.questionnaire_responses.filter(slug=slug) %}
    {% set author = qr.updated_by.full_name %}
    {% for resp in qr.responses %}
      {% set label = resp.question.get('text', '') %}
      {% set q = label | lower | trim %}
      {% set ids = [q, (resp.question.get('code') or {}).get('code')] %}
      {% set ns = namespace(sec="") %}
      {% for sec, keys in rules if not ns.sec %}
        {% for k in keys if ((k[1:] in ids) if k[0] == "=" else (k in q)) %}{% set ns.sec = sec %}{% endfor %}
      {% endfor %}
      {% set text = answer_text(resp) | trim %}
      {% if text %}
        {% set _ = items.append({"label": label, "sec": ns.sec, "text": text, "note": resp.answer.get('note'), "author": author}) %}
      {% endif %}
    {% endfor %}
  {% endfor %}
{% endfor %}

{% macro pairs(title, rows) %}
{% if rows %}
<h3>{{ title }}</h3>
<table>
  {% for pair in rows | batch(2) %}
  <tr>
    {% for r in pair %}<td><b>{{ r.label }}:</b> {{ r.text }}{% if r.note %}<div class="note">{{ r.note }}</div>{% endif %}</td>{% endfor %}
    {% if pair | length == 1 %}<td></td>{% endif %}
  </tr>
  {% endfor %}
</table>
{% endif %}
{% endmacro %}

{{ pairs("History", items | selectattr("sec", "equalto", "history") | list) }}
{{ pairs("Vitals", items | selectattr("sec", "equalto", "vitals") | list) }}
{{ pairs("Other Findings", items | selectattr("sec", "equalto", "") | list) }}
```

This costs one query per form and one `render_responses()` per response, and adding a section means adding one rule plus one `pairs(...)` line. Add `limit=1` to the `.filter(...)` if only each form's latest fill should count. Keep this pass for questionnaire answers only: structured data such as symptoms and diagnoses comes from `encounter.*` datapoints, which render through `grid()`. Use `items | selectattr(...) | first | default(none)` for single-value lookups (LMP, EDD) instead of a search macro. If the questions define a unit, read it from `resp.question.get('unit', {}).get('display')` instead of hard-coding a map from label to unit.

### Repeating group answers

```jinja2
{# needs answer_text() from above. A repeating group is one row whose answer holds sub_results:
   a list of instances, each a list of {question_id, values, note}. Child labels live on the group question. #}
{% set qr = encounter.questionnaire_responses.filter(slug="vitals_form", limit=1) | first | default(none) %}
{% if qr %}
{% for resp in qr.responses if resp.answer.get('sub_results') %}
  {% set children = resp.question.get('questions', []) %}
  <strong>{{ resp.question.get('text') }}</strong>
  {% for instance in resp.answer.sub_results %}
  <div>Entry {{ loop.index }}:
    {% for sub in instance %}
    {% set child = children | selectattr('id', 'equalto', sub.get('question_id')) | first | default({}) %}
    {{ child.get('text', '') }}: {{ answer_text({'question': child, 'answer': sub}) or "-" }}{% if not loop.last %}; {% endif %}
    {% endfor %}
  </div>
  {% endfor %}
{% endfor %}
{% endif %}
```

### Medication 3-level nesting

```jinja2
{% for mp in encounter.medication_prescriptions.filter(status="active") %}
  {% for medication in mp.medications.filter(status="active") %}
    {% for di in medication.dosage_instructions %}
      {{ medication.name }}: {{ di.dosage }} — {{ di.frequency }} — {{ di.duration }}
    {% endfor %}
  {% endfor %}
{% endfor %}
```

### Groupby on querysets

```jinja2
{% for group in account.payment_reconciliations.filter(status="active") | groupby("reconciliation_type") %}
  <strong>{{ group.grouper }}</strong>
  {% for pr in group.list %}
    {{ pr.method }}: {{ "-" if pr.is_credit_note == "True" else "" }}{{ pr.amount | currency }}
  {% endfor %}
{% endfor %}
Total paid: {{ account.total_paid | currency }}
```
