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
      className={`rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60 ${variantClasses}`}
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
      confirmMessage="Publish this article? It will become visible on the public Blog once BLOG-1D ships."
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
      confirmMessage="Unpublish this article? It will disappear from the public Blog once BLOG-1D ships, and return to Draft here."
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
