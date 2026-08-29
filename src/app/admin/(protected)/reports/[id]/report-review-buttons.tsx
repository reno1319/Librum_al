"use client";

import { useFormStatus } from "react-dom";
import { getReviewConfirmationMessage } from "../report-review-logic";

// Exact mirror of ReviewButtons (src/app/admin/refunds/[id]/
// review-buttons.tsx) for the same reasons -- see that file's own
// comment. Two submit buttons sharing one <form> (and therefore one
// FormData, including the adminNotes textarea rendered alongside them)
// via each button's own `formAction` -- a decision-bound server action
// (reviewBookReport.bind(null, reportId, "resolved"/"dismissed"), see
// the parent page) rather than the form's default action. Both disable
// together while either submission is pending. Each button is also
// guarded by window.confirm() before the form ever submits --
// e.preventDefault() inside onClick stops the click from ever becoming
// a form submission when the admin cancels, so reviewBookReport() (and
// therefore review_book_report()) is never invoked in that case.
export function ReportReviewButtons({
  onResolve,
  onDismiss,
}: {
  onResolve: (formData: FormData) => void | Promise<void>;
  onDismiss: (formData: FormData) => void | Promise<void>;
}) {
  const { pending } = useFormStatus();

  return (
    <div className="mt-3 flex gap-2">
      <button
        type="submit"
        formAction={onResolve}
        disabled={pending}
        onClick={(e) => {
          if (!window.confirm(getReviewConfirmationMessage("resolved"))) {
            e.preventDefault();
          }
        }}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
      >
        {pending ? "Submitting…" : "Resolve report"}
      </button>
      <button
        type="submit"
        formAction={onDismiss}
        disabled={pending}
        onClick={(e) => {
          if (!window.confirm(getReviewConfirmationMessage("dismissed"))) {
            e.preventDefault();
          }
        }}
        className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover disabled:opacity-60"
      >
        {pending ? "Submitting…" : "Dismiss report"}
      </button>
    </div>
  );
}
