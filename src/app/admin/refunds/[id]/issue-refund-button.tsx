"use client";

import { useFormStatus } from "react-dom";
import { getIssueRefundConfirmationMessage } from "../refund-review-logic";

// Same confirm-then-submit pattern as ReviewButtons/CancelRefundButton
// in this app (window.confirm guard on the submit, no modal/dialog
// library) -- e.preventDefault() inside onClick stops the click from
// ever becoming a form submission when the admin cancels, so
// issueStripeRefund() (and therefore any Stripe call) is never invoked
// in that case. disabled={pending} is UX protection only, reducing
// accidental double-submission -- the real duplicate-execution
// protection is Stripe's own idempotency-key enforcement (see
// issue-refund.ts's buildRefundIdempotencyKey), which holds even if
// this client-side guard is bypassed entirely (e.g. two separate
// browser tabs).
export function IssueRefundButton({ amountCents }: { amountCents: number }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(getIssueRefundConfirmationMessage(amountCents))) {
          e.preventDefault();
        }
      }}
      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
    >
      {pending ? "Submitting…" : "Issue refund"}
    </button>
  );
}
