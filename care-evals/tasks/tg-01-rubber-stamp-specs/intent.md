# Code-reconstructed intent — Invoice percentage discount

The invoice detail view renders a discount control: a numeric percent input and an **Apply** button.
On apply, the component computes `discount = subtotal * percent / 100`, then
`net = subtotal - discount + tax`, and re-renders the totals block (Subtotal / Discount / Tax / Net
payable). A percent above 100 is treated as invalid: an inline error is shown and the previously
displayed totals are retained unchanged. An empty or zero percent yields `net = subtotal + tax` with
the discount row showing `-0.00`.

This intent is provided as the cross-check; the acceptance criteria in `criteria.md` are the ground
truth for grading.
