# Acceptance Criteria — Record a partial payment

The invoice detail page lets a biller record a payment against an outstanding invoice and see the
balance recomputed before the next action.

- **AC1**: Recording a payment of amount `P` against an invoice whose **Outstanding balance** is `B`
  updates the displayed **Outstanding balance** to `B − P`. (E.g. balance 800.00, pay 300.00 →
  outstanding 500.00.)
- **AC2**: The recorded payment appears in the **Payments** list showing its amount (e.g. `300.00`)
  and the payment date.
- **AC3**: Recording a payment **greater than the outstanding balance** is rejected with an inline
  validation error, and the **Outstanding balance is left unchanged** (the over-payment is never
  applied).
