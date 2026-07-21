# Code-reconstructed intent — Issue an invoice

The invoice detail view renders an **Issue** button on a draft invoice. On issue, the component posts
the finalize request; the server assigns an invoice number and returns the issued invoice. The view
then re-renders: the status badge flips `Draft` → `Issued`, the header shows the returned invoice
number, and the totals block shows the final total (`subtotal + tax − discount`).

Fixture note: the local Playwright backend finalizes the invoice but assigns **no** invoice number
(the numbering service isn't seeded), so the number element renders empty in the local fixture. The
real backend populates it.

This intent is provided as the cross-check; the acceptance criteria in `criteria.md` are the ground
truth for grading.
