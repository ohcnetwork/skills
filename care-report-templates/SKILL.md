---
name: care-report-templates
description: Reference for creating Jinja2 report templates in the CARE EMR system. Use when creating, editing, or debugging report templates. Covers available context variables, nested data, custom filters, globals, and template patterns.
user-invocable: true
argument-hint: "[encounter|patient|account]"
---

# CARE Report Template Reference

Templates are Jinja2 HTML rendered in a **SandboxedEnvironment** with `StrictUndefined` and `autoescape=True`. `trim_blocks` and `lstrip_blocks` are enabled. Each template uses **exactly one** context (`encounter` OR `patient` OR `account` — mutually exclusive). The root variable is determined by the chosen context. `current_user` is always available.

Before creating a template, read the example templates in `~/.claude/skills/care-report-templates/examples/` for real-world patterns.

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
| `encounter.care_team` | `.user.full_name`, `.user.id`, `.role` | No |
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
| `account.primary_encounter` | single | Same fields as encounter (status, encounter_class, start_time, end_time, care_team, current_location, hospitalization, organizations, encounter_tags, extensions, etc.) |
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

**Filter:** status

| Field | Type |
|-------|------|
| `title` | string (from code.display) |
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
| `interpretation` | string |
| `value` | nested: `.value.value`, `.value.unit` |
| `reference_range` | iterable: each has `.min`, `.max`, `.interpretation` |

### Symptoms

**Filter:** clinical_status, verification_status, exclude_clinical_status, exclude_verification_status

| Field | Type |
|-------|------|
| `clinical_status` | string (Active, Resolved, etc.) |
| `verification_status` | string (Confirmed, Refuted, etc.) |
| `name` | string |
| `onset` | date string |
| `note` | string |
| `created_by` | single: `.full_name`, `.id` |
| `updated_by` | single: `.full_name`, `.id` |

### Allergy Intolerances

**Filter:** clinical_status, verification_status, exclude_clinical_status, exclude_verification_status

| Field | Type |
|-------|------|
| `clinical_status` | string (Active, Inactive, Resolved) |
| `verification_status` | string (Unconfirmed, Confirmed, Refuted, etc.) |
| `criticality` | string (Low, High, Unable to Assess) |
| `name` | string |
| `note` | string |
| `last_occurrence` | datetime string |

### Diagnoses

**Filter:** clinical_status, verification_status, exclude_clinical_status, exclude_verification_status

| Field | Type |
|-------|------|
| `clinical_status` | string |
| `verification_status` | string |
| `name` | string (from code.display) |
| `onset` | date string |
| `note` | string |

### Questionnaire Responses

**Filter:** slug **(REQUIRED — will raise ValueError if omitted)**

Each questionnaire response has:

| Field | Type |
|-------|------|
| `title` | string (questionnaire title) |
| `description` | string (questionnaire description) |
| `responses` | iterable — see below |
| `updated_by` | single: `.full_name` |

Each response item has:

| Field | Type / Access |
|-------|--------------|
| `question` | dict or string — use `resp.question.get('text', resp.question)` if mapping, else use directly |
| `answer` | dict — values via `resp.answer.get('values', [resp.answer])`, each value has `.get('value')`. Notes via `resp.answer.get('note')` |

Question dict keys: `text`, `type`, `code` (with `code`, `system`, `display`), `unit` (with `code`, `system`, `display`).

### Medication Prescriptions

**Filter:** status

| Field | Type |
|-------|------|
| `status` | string |
| `note` | string |
| `prescribed_by` | single: `.full_name` |
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
| `category` | string (Laboratory, Imaging, Counselling, Surgical Procedure) |
| `priority` | string (Routine, Urgent, ASAP, Stat) |
| `requester` | single: `.full_name`, `.id` |

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
| `is_credit_note` | boolean string |
| `issuer_type` | string (Patient, Insurer) |
| `outcome` | string (Queued, Complete, Error, Partial) |
| `method` | string (Cash, Credit Card, Check, etc.) |
| `target_invoice` | single: `.title`, `.number` |
| `created_date` | datetime string |

---

## Queryset Filtering

Querysets support `.filter(**kwargs)` which applies Django-filter backends at the database level. Always pipe through `| list` if you need length checks or indexing.

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

| Function | Usage | Default Format |
|----------|-------|----------------|
| `current_date` | `{{ current_date() }}` | `%d/%m/%Y` |
| `current_datetime` | `{{ current_datetime() }}` | `%d/%m/%Y %I:%M %p` |
| `current_time` | `{{ current_time() }}` | `%I:%M %p` |

**Timezone warning:** These return strings in **UTC** (server timezone). To get IST output, pipe through the datetime filter with `%z` to preserve offset:

```jinja2
{{ current_datetime("%Y-%m-%dT%H:%M:%S%z") | datetime }}
```

The `%z` preserves the `+0000` UTC offset so `fromisoformat` parses it as aware UTC, then `localtime()` converts to IST (`settings.TIME_ZONE = "Asia/Kolkata"`).

---

## `current_user`

Always available regardless of context:

```jinja2
{{ current_user.full_name }}
{{ current_user.id }}
```

---

## Useful Jinja2 Built-ins

| Filter/Function | Usage |
|-----------------|-------|
| `default(val)` / `d` | `{{ x \| default("-") }}` — fallback if undefined or empty |
| `length` | `{{ items \| length }}` |
| `first` / `last` | `{{ items \| first }}` |
| `join(sep)` | `{{ items \| join(", ") }}` |
| `groupby(attr)` | `{% for group in items \| groupby("type") %}` — `.grouper` and `.list` |
| `selectattr` / `rejectattr` | `items \| selectattr("status", "equalto", "Active") \| list` |
| `map(attribute=)` | `items \| map(attribute="name") \| list` |
| `sum` / `min` / `max` | `{{ items \| sum }}` |
| `int` / `float` / `round` | `{{ value \| int }}`, `{{ value \| float }}` |
| `batch(n)` | `{% for row in items \| batch(2) %}` — groups into sublists |
| `capitalize` / `upper` / `lower` / `title` | String casing |
| `replace` | `{{ text \| replace("\\n", "<br>"\|safe) \| safe }}` |
| `tojson` | `{{ data \| tojson }}` |
| `format` | `{{ "%.2f" \| format(value \| float) }}` — printf-style |
| `namespace()` | `{% set ns = namespace(total=0) %}` — mutable state across scopes |

---

## Extensions

Extensions are **dict** fields that vary by facility/plugin configuration. You must know the extension name and field path:

```jinja2
{# Encounter extensions #}
{{ encounter.extensions.encounter_attender.attender_name }}

{# Deep access with safety checks #}
{% if encounter.extensions is mapping and encounter.extensions.get('encounter_attender') is mapping %}
  {% set attender = encounter.extensions['encounter_attender']['attender'] %}
  {{ attender.get('attender_name', '') }}
{% endif %}

{# Patient extensions #}
{{ patient.extensions.patient_demographics.related_person }}
```

Extensions keys are facility-specific and not standardized. Always use `.get()` or `is mapping` checks for safety.

---

## Sandbox Restrictions

- No `import` statements
- No access to Python builtins (`open`, `eval`, `exec`, etc.)
- No dunder attribute access (`__class__`, `__globals__`, etc.)
- No `getattr`/`setattr`
- Templates are pure data rendering — only registered filters, globals, and context data are available

---

## Common Patterns

### Materialize querysets for indexing

```jinja2
{% set items = encounter.diagnoses.filter(clinical_status="active") | list %}
{% if items | length > 0 %}
  {{ items[0].name }}
{% endif %}
```

### Namespace for cross-scope state

```jinja2
{% set ns = namespace(total=0) %}
{% for item in account.category_charge_items_summary.category_charge_items %}
  {% set ns.total = ns.total + (item.total_charge_items_price | float) %}
{% endfor %}
Net Total: {{ ns.total }}
```

### Macros for reusable blocks

```jinja2
{% macro section_header(title) %}
<div style="font-weight: bold; font-size: 12px; margin-bottom: 5px;">{{ title }}</div>
{% endmacro %}

{{ section_header("Diagnoses") }}
```

### Official patient identifiers

```jinja2
{% set official_ids = encounter.patient.instance_identifiers | selectattr('config.use', 'equalto', 'Official') | list %}
{% if official_ids | length > 0 %}
  {{ official_ids[0].config.display }}: {{ official_ids[0].value }}
{% endif %}
```

### Observation reference range matching

```jinja2
{% set matched = observation.reference_range | selectattr("interpretation", "equalto", observation.interpretation) | list %}
{% if matched %}
  {% set range = matched[0] %}
  {% set min_val = range.min | default(0) | float %}
  {% set max_val = range.max | default(0) | float %}
  {% if min_val > 0 and max_val > 0 %}
    {{ min_val }} - {{ max_val }}
  {% elif max_val > 0 %}
    &lt; {{ max_val }}
  {% elif min_val > 0 %}
    &gt; {{ min_val }}
  {% endif %}
  {% if observation.value.unit %}({{ observation.value.unit }}){% endif %}
{% endif %}
```

### Questionnaire response values

```jinja2
{% for resp in qr.responses %}
  {% set label = resp.question.get('text', resp.question) if resp.question is mapping else resp.question %}
  {% for v in resp.answer.get('values', [resp.answer]) %}
    {{ v.get('value', '') }}
  {% endfor %}
  {% if resp.answer.get('note') %}
    Note: {{ resp.answer.note }}
  {% endif %}
{% endfor %}
```

### Medication 3-level nesting

```jinja2
{% for mp in encounter.medication_prescriptions %}
  {% for medication in mp.medications.filter(status="active") %}
    {{ medication.name }}
    {% for di in medication.dosage_instructions %}
      {{ di.dosage }} — {{ di.frequency }} — {{ di.duration }}
    {% endfor %}
  {% endfor %}
{% endfor %}
```

### Groupby on querysets

```jinja2
{% for group in account.payment_reconciliations | groupby("reconciliation_type") %}
  <strong>{{ group.grouper }}</strong>
  {% for pr in group.list %}
    {{ pr.method }}: {{ pr.amount | currency }}
  {% endfor %}
{% endfor %}
```
