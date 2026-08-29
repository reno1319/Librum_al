"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { formControlClasses } from "@/lib/form-styles";
import { buttonClasses } from "@/components/ui/button";
import {
  STAFF_ROLE_OPTIONS,
  EDITOR_ROLE_HELP_TEXT,
  getAddStaffConfirmationMessage,
  handleConfirmGatedSubmit,
} from "./staff-management-logic";
import type { StaffRole } from "@/lib/types";

// LIBRUM 2.0 ADMIN-1B PART C: manage-mode only (the caller, page.tsx,
// never renders this for a staff.view-only viewer). Same confirm-then-
// submit pattern as every other admin mutation in this codebase
// (window.confirm() inside the submit button's onClick,
// e.preventDefault() stops the click from ever becoming a submission
// when cancelled -- see src/app/admin/(protected)/reports/[id]/
// report-review-buttons.tsx's own comment) -- no modal/dialog library
// introduced solely for this. Uncontrolled email input (read via
// FormData by the server action, exactly like every other form in this
// app); the role <select> is the one controlled value here, since the
// confirmation copy and the Editor help text both need to react to it
// live, before submission.
//
// "Form clears on success" (design brief item 11) is not implemented as
// explicit reset logic: addStaffMemberByEmailFormAction (./page-actions.ts)
// redirects back to /admin/staff on success, which is a full navigation
// -- this component's instance (along with its uncontrolled email input
// and this local role state) is unmounted and a fresh one mounts in its
// place, exactly like every other form in this codebase already clears
// itself after a successful redirect-driving Server Action.
function AddStaffSubmitButton({ confirmMessage }: { confirmMessage: string | null }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      onClick={(e) => handleConfirmGatedSubmit(confirmMessage, window.confirm, e)}
      className={buttonClasses("primary", "md")}
    >
      {pending ? "Adding…" : "Add staff member"}
    </button>
  );
}

export function AddStaffForm({
  action,
}: {
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [role, setRole] = useState<StaffRole>("support");
  const confirmMessage = getAddStaffConfirmationMessage(role);

  return (
    <form action={action} className="mt-4 flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="off"
            required
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Role
          <select
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as StaffRole)}
            className={formControlClasses}
          >
            {STAFF_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <AddStaffSubmitButton confirmMessage={confirmMessage} />
      </div>

      {role === "editor" && <p className="text-xs text-muted">{EDITOR_ROLE_HELP_TEXT}</p>}
    </form>
  );
}
