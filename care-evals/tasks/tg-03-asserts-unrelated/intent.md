# Code-reconstructed intent — Record a partial payment

The invoice detail view renders a **Record payment** control: a numeric amount input and a **Record**
button. On record, the component posts the payment, then recomputes `outstanding = balance − amount`
and re-renders the balance line and the Payments list (each row: amount + date). A success toast
("Payment recorded") is shown on the successful post. An amount greater than the current outstanding
balance is treated as invalid: an inline error is shown, no payment is posted, and the balance line
is retained unchanged.

This intent is provided as the cross-check; the acceptance criteria in `criteria.md` are the ground
truth for grading.
