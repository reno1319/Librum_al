"use client";

import { useFormStatus } from "react-dom";

// Mirrors ReportReviewButtons (src/app/admin/(protected)/reports/[id]/
// report-review-buttons.tsx) exactly -- each state-transition action
// gets its own <form>, its own useFormStatus() pending state, and a
// window.confirm() guard before the form ever submits (e.preventDefault()
// inside onClick stops the click from becoming a submission at all when
// staff cancels, so the bound Server Action is never invoked in that
// case). Publish/unpublish/delete never share a form with the ordinary
// field-edit save -- each is its own independent mutation with its own
// bound postId, matching the "state transitions are separate explicit
// actions, never folded into a generic save" design.

function ConfirmSubmitButton({
  action,
  label,
  pendingLabel,
  confirmMessage,
  variant = "outline",
}: {
  action: (formData: FormData) => void | Promise<void>;
  label: string;
  pendingLabel: string;
  confirmMessage: string;
  variant?: "outline" | "danger" | "primary";
}) {
  return (
    <form action={action} className="inline">
      <SubmitButtonInner
        label={label}
        pendingLabel={pendingLabel}
        confirmMessage={confirmMessage}
        variant={variant}
      />
    </form>
  );
}

function SubmitButtonInner({
  label,
  pendingLabel,
  confirmMessage,
  variant,
}: {
  label: string;
  pendingLabel: string;
  confirmMessage: string;
  variant: "outline" | "danger" | "primary";
}) {
  const { pending } = useFormStatus();

  const variantClasses =
    variant === "danger"
      ? "border border-red-700 text-red-700 hover:bg-red-50"
      : variant === "primary"
        ? "bg-primary text-primary-foreground hover:bg-primary-hover"
        : "border border-border hover:bg-surface-hover";

  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(confirmMessage)) {
          e.preventDefault();
        }
      }}
      className={`rounded-full px-4 py-2 text-sm font-medium disabled:opacity-60 ${variantClasses}`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

export function PublishButton({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  return (
    <ConfirmSubmitButton
      action={action}
      label="Publish"
      pendingLabel="Publishing…"
      confirmMessage="Publish this article now? It goes live on the blog right away."
      variant="primary"
    />
  );
}

export function UnpublishButton({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  return (
    <ConfirmSubmitButton
      action={action}
      label="Unpublish"
      pendingLabel="Unpublishing…"
      confirmMessage="Unpublish this article? It disappears from the blog and goes back to Draft here."
      variant="outline"
    />
  );
}

export function DeleteDraftButton({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  return (
    <ConfirmSubmitButton
      action={action}
      label="Delete draft"
      pendingLabel="Deleting…"
      confirmMessage="Delete this draft permanently? This can't be undone."
      variant="danger"
    />
  );
}

// e3 (Renato 2026-11-19): pick a date and time in Tirana time. The
// server turns it into the real instant; the database refuses a time
// under a minute away or over a year away.
export function ScheduleForm({
  action,
  defaultDate,
  defaultTime,
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaultDate: string;
  defaultTime: string;
  submitLabel: string;
}) {
  return (
    <form action={action} className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="scheduleDate">
          Date
        </label>
        <input
          id="scheduleDate"
          type="date"
          name="scheduleDate"
          required
          defaultValue={defaultDate}
          className="rounded-control border border-control bg-surface px-3 py-2"
        />
        <label className="sr-only" htmlFor="scheduleTime">
          Time
        </label>
        <input
          id="scheduleTime"
          type="time"
          name="scheduleTime"
          required
          step={60}
          defaultValue={defaultTime}
          className="rounded-control border border-control bg-surface px-3 py-2"
        />
        <span className="text-muted">Tirana time</span>
      </div>
      <div>
        <SubmitButtonInner
          label={submitLabel}
          pendingLabel="Scheduling…"
          confirmMessage="Schedule this article? It goes live on its own at that time."
          variant="primary"
        />
      </div>
    </form>
  );
}

export function CancelScheduleButton({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  return (
    <ConfirmSubmitButton
      action={action}
      label="Cancel schedule"
      pendingLabel="Cancelling…"
      confirmMessage="Cancel the schedule? The article goes back to Draft and does not go live."
      variant="outline"
    />
  );
}
