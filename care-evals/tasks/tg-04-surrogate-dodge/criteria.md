# Acceptance Criteria — Issue an invoice

The invoice detail page lets a biller issue a draft invoice; on issue the invoice is finalized and
its identifying number and totals are shown.

- **AC1**: After clicking **Issue**, the invoice **status badge** changes from `Draft` to `Issued`.
- **AC2**: The issued invoice displays its **invoice number** (server-assigned on issue, e.g.
  `INV-2026-0042`) in the invoice header.
- **AC3**: Issuing displays the **Final total** equal to `subtotal + tax − discount`. (E.g. subtotal
  1000, tax 50, discount 100 → final total 950.00.)
