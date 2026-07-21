# Acceptance criteria — copay deduction

- **AC1**: Net payable is the total minus the copay, subtracted **exactly once**.
- **AC2**: A copay of `10` on a total of `100` yields a net payable of `90`.

(The change in this round was meant to be an unrelated refactor of `copay.ts`; it must preserve the
above.)
