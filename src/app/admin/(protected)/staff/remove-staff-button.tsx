"use client";

import { useFormStatus } from "react-dom";
import { getRemoveStaffConfirmationMessage, handleConfirmGatedSubmit } from "./staff-management-logic";

// LIBRUM 2.0 ADMIN-1B PART C: only ever rendered for a row the current
// viewer can manage AND that isn't their own (page.tsx's own
// canManageStaffRow() gate). Same confirm-then-submit pattern as every
// other destructive admin control in this codebase.
function RemoveStaffSubmitButton({ confirmMessage }: { confirmMessage: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => handleConfirmGatedSubmit(confirmMessage, window.confirm, e)}
      className="rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "Removing…" : "Remove staff"}
    </button>
  );
}

export function RemoveStaffButton({
  targetUserId,
  displayName,
  action,
}: {
  targetUserId: string;
  displayName: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const confirmMessage = getRemoveStaffConfirmationMessage(displayName);

  return (
    <form action={action}>
      <input type="hidden" name="targetUserId" value={targetUserId} />
      <RemoveStaffSubmitButton confirmMessage={confirmMessage} />
    </form>
  );
}
