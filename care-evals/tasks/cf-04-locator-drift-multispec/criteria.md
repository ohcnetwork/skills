# Acceptance criteria — patient age display (eng-747)

- **AC1**: The patient age renders in the spelled-out form `<n> years` (e.g. `25 years`), replacing the
  previous abbreviated `<n>Y`. This is the intended change.
- **AC2**: Display-only — no data-model or API change.
- **AC3**: The same age string is surfaced in the patient card's accessible name (`<age>, <gender>`),
  so the card label changes with it. This is expected — consumers that match the old label must follow.
