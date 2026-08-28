# Acceptance Criteria — Invoice percentage discount

The invoice detail page lets a biller apply a whole-number percentage discount to an invoice and
see the recomputed totals before issuing.

- **AC1**: Entering a discount percent and clicking **Apply** updates the displayed **Net payable**
  to `subtotal - (subtotal * percent / 100) + tax`. (E.g. subtotal 1000, tax 50, 10% → net 950.)
- **AC2**: The **Discount** row displays the computed discount amount with a leading minus sign
  (e.g. `-100.00`), not just a placeholder or an empty row.
- **AC3**: A discount percent **greater than 100** is rejected with an inline validation error, and
  the **Net payable is left unchanged** (the invalid discount is never applied).
- **AC4**: With **no discount applied** (percent empty or 0), the **Net payable equals
  `subtotal + tax`**.
