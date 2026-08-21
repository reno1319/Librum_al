"use client";

import { useFormStatus } from "react-dom";

// Matches the confirm-then-submit pattern already used by
// src/app/dashboard/delete-book-button.tsx: a plain window.confirm()
// guard on the submit, rather than a second custom dialog component.
export function CancelRefundButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-surface-hover disabled:opacity-60"
      onClick={(e) => {
        const confirmed = window.confirm(
          "Cancel this refund request? You can submit a new one later if you change your mind.",
        );
        if (!confirmed) {
          e.preventDefault();
        }
      }}
    >
      {pending ? "Cancelling…" : "Cancel refund request"}
    </button>
  );
}
