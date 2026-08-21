"use client";

import { useFormStatus } from "react-dom";
import { getReviewConfirmationMessage } from "../refund-review-logic";

// Two submit buttons sharing one <form> (and therefore one FormData,
// including the adminNotes textarea rendered alongside them) via each
// button's own `formAction` -- a decision-bound server action
// (reviewRefundRequest.bind(null, requestId, "approved"/"rejected"),
// see the parent page) rather than the form's default action. Both
// disable together while either submission is pending, preventing an
// accidental double-submit of either decision -- the same
// duplicate-submit mitigation useFormStatus already provides elsewhere
// in this app (src/app/bundles/[id]/buy-bundle-button.tsx).
//
// Each button is also guarded by window.confirm() before the form ever
// submits -- the same confirm-then-submit pattern already used by
// src/app/dashboard/delete-book-button.tsx and
// src/app/library/cancel-refund-button.tsx, rather than a new modal/
// dialog component. e.preventDefault() inside onClick stops the click
// from ever becoming a form submission at all when the admin cancels --
// reviewRefundRequest() (and therefore review_refund_request()) is
// never invoked in that case, so cancelling performs no mutation.
// getReviewConfirmationMessage() supplies decision-specific wording,
// notably the approval message's explicit "does not issue the Stripe
// refund yet" -- approving here only ever calls review_refund_request(),
// which writes status = 'approved' and nothing else.
export function ReviewButtons({
  onApprove,
  onReject,
}: {
  onApprove: (formData: FormData) => void | Promise<void>;
  onReject: (formData: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();

  return (
    <div className="mt-3 flex gap-2">
      <button
        type="submit"
        formAction={onApprove}
        disabled={pending}
        onClick={(e) => {
          if (!window.confirm(getReviewConfirmationMessage("approved"))) {
            e.preventDefault();
          }
        }}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
      >
        {pending ? "Submitting…" : "Approve"}
      </button>
      <button
        type="submit"
        formAction={onReject}
        disabled={pending}
        onClick={(e) => {
          if (!window.confirm(getReviewConfirmationMessage("rejected"))) {
            e.preventDefault();
          }
        }}
        className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-60"
      >
        {pending ? "Submitting…" : "Reject"}
      </button>
    </div>
  );
}
