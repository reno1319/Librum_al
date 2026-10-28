"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { REFUND_REASON_MAX_LENGTH } from "./refund-logic";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-control bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
    >
      {pending ? "Duke dërguar…" : "Dërgoni kërkesën për rimbursim"}
    </button>
  );
}

// Collapsed by default so the Library page isn't cluttered with an open
// form per eligible transaction -- opening it is itself the
// "confirmation UI" this phase requires before a request is ever
// submitted: the reader sees exactly what they're agreeing to (whole
// transaction, all books included, reviewed not instant) before the
// submit button that actually calls request_refund() even exists in the
// DOM.
export function RefundRequestForm({
  action,
  bookCount,
}: {
  action: (formData: FormData) => void | Promise<void>;
  bookCount: number;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-control border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
      >
        Kërkoni rimbursim
      </button>
    );
  }

  return (
    <form
      action={action}
      className="mt-3 w-full rounded-card border border-border bg-surface p-4"
    >
      <p className="text-sm font-medium">
        Të kërkoni rimbursim për këtë blerje?
      </p>
      <p className="mt-1 text-xs text-muted">
        {bookCount > 1
          ? `Kjo ishte një blerje me ${bookCount} libra: kërkesa për rimbursim vlen për të gjithë blerjen, jo për një libër të vetëm.`
          : "Kjo do të kërkojë rimbursim për këtë blerje."}{" "}
        Kërkesa nuk ju rimburson menjëherë: fillimisht do të shqyrtohet.
      </p>
      <label className="mt-3 flex flex-col gap-1 text-sm">
        Arsyeja (nuk është e detyrueshme)
        <textarea
          name="reason"
          rows={3}
          maxLength={REFUND_REASON_MAX_LENGTH}
          className="rounded-control border border-control bg-surface px-3 py-2"
        />
      </label>
      <div className="mt-3 flex gap-2">
        <SubmitButton />
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-control border border-border px-3 py-2 text-sm hover:bg-surface-hover"
        >
          Anuloni
        </button>
      </div>
    </form>
  );
}
