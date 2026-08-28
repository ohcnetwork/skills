# Intent reconstruction

**Overall:** the diff adds a `short` option to `formatPatientAge` and switches `PatientCard` to use
it. Reading the control flow rather than the option name, `short` mode does something narrower than
"abbreviated age": it returns the **bare year count with no unit** (`return \`${years}\``), so an age
that renders `3Y` normally now renders `3`.

## Per-change

- **`formatPatientAge` — new `short` branch** — _what:_ when `opts.short` is set, returns
  `` `${years}` `` — the year number **only, without the `Y`/`M`/`D` unit** the normal path appends.
  Because this branch runs **before** the `months > 0` / `days` fallbacks, a patient **under one year**
  (years === 0, e.g. a 3-month-old) now renders `"0"`, **dropping the months/days precision** the
  normal path would show. _why:_ most plausibly to fit the age into the compact `PatientCard` header.
  _Confidence:_ **low** — the option is named `short` but the code neither keeps a unit nor handles
  the infant case, so the intent is ambiguous and the `0`-for-infants behavior looks unintended.

- **`PatientCard` — passes `{ short: true }`** — _what:_ renders the age via the new bare-number
  path. _why:_ compact card layout. _Confidence:_ high.

**Worth confirming at the gate:** if the intended behavior was "abbreviated age *with* a unit", the
code does not do that; and the infant `"0"` output is likely a regression.
