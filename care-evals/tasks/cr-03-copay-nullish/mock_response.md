**Bottom line** — Not mergeable as-is: one real correctness bug in how the copay falls back.

**Intent** — Show the copay a patient owes for a visit, using the patient's per-patient override and
falling back to the plan default when there's no override.

**Worth deciding**
- **Correctness — `patient.copay || defaultCopay` mishandles a copay of 0.** The comment says a copay
  of `0` means the visit is fully covered — a legitimate value — but `0` is **falsy**, so `||`
  discards it and charges `defaultCopay` instead. Use **nullish coalescing**: `patient.copay ??
  defaultCopay`, so only `undefined`/`null` falls back to the default.

**Optional / FYI** — none.

**Out of scope** — styling, i18n of the "Copay due" label.
