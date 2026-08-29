"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { formControlClasses } from "@/lib/form-styles";
import {
  STAFF_ROLE_OPTIONS,
  getRoleChangeConfirmationMessage,
  isRoleChangeSubmittable,
  handleConfirmGatedSubmit,
} from "./staff-management-logic";
import type { StaffRole } from "@/lib/types";

// LIBRUM 2.0 ADMIN-1B PART C: only ever rendered for a row the current
// viewer can manage AND that isn't their own (page.tsx's own
// canManageStaffRow() gate -- this component never re-derives that
// decision itself). Save stays disabled until the selected role
// actually differs from the role this row currently has -- change_
// staff_role() already treats a same-role submission as a harmless,
// audit-free no-op (migration 041), but there is no reason to let the
// UI invite a pointless request the backend would just discard anyway
// (design brief item 14).
function RoleChangeSaveButton({
  disabled,
  confirmMessage,
}: {
  disabled: boolean;
  confirmMessage: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={disabled || pending}
      onClick={(e) => handleConfirmGatedSubmit(confirmMessage, window.confirm, e)}
      className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "Saving…" : "Save"}
    </button>
  );
}

export function RoleChangeRow({
  targetUserId,
  displayName,
  currentRole,
  action,
}: {
  targetUserId: string;
  displayName: string;
  currentRole: StaffRole;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [selectedRole, setSelectedRole] = useState<StaffRole>(currentRole);
  const changed = isRoleChangeSubmittable(selectedRole, currentRole);
  const confirmMessage = getRoleChangeConfirmationMessage(displayName, currentRole, selectedRole);
  const labelId = `role-select-${targetUserId}`;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="targetUserId" value={targetUserId} />
      <label className="sr-only" htmlFor={labelId}>
        Role for {displayName}
      </label>
      <select
        id={labelId}
        name="role"
        value={selectedRole}
        onChange={(e) => setSelectedRole(e.target.value as StaffRole)}
        className={formControlClasses}
      >
        {STAFF_ROLE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <RoleChangeSaveButton disabled={!changed} confirmMessage={confirmMessage} />
    </form>
  );
}
