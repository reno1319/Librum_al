"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { addStaffMemberByEmail, changeStaffRole, removeStaffMember } from "./actions";
import {
  isValidStaffRole,
  STAFF_ADDED_SUCCESS_MESSAGE,
  STAFF_ROLE_CHANGED_SUCCESS_MESSAGE,
  STAFF_REMOVED_SUCCESS_MESSAGE,
} from "./staff-management-logic";

// LIBRUM 2.0 ADMIN-1B PART C: thin, redirect-driving Server Actions
// wired directly to /admin/staff's forms -- exactly the "Part C wires
// these into real forms and decides the redirect/revalidate behavior"
// role ./actions.ts's own header comment anticipates. Part B's
// committed primitives (addStaffMemberByEmail/changeStaffRole/
// removeStaffMember, imported above, unmodified) do all the actual
// authorization and mutation work; this file only adapts their
// FormData-free, non-redirecting calling convention to the
// <form action={...}> + redirect()-with-query-param pattern every other
// admin page in this codebase already uses (see
// src/app/admin/(protected)/reports/actions.ts's reviewBookReport(), or
// src/app/admin/(protected)/refunds/actions.ts's issueStripeRefund()).
//
// No requireStaff() call here -- each Part B primitive already calls it
// internally (staff.view for listing is irrelevant here since none of
// these three ever list; staff.manage for all three mutations), so a
// second call here would just repeat the same auth.getUser() +
// staff_members round trip for no additional safety.
const STAFF_PAGE_PATH = "/admin/staff";

function redirectWithError(message: string): never {
  redirect(`${STAFF_PAGE_PATH}?error=${encodeURIComponent(message)}`);
}

function redirectWithSuccess(message: string): never {
  redirect(`${STAFF_PAGE_PATH}?success=${encodeURIComponent(message)}`);
}

export async function addStaffMemberByEmailFormAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const roleValue = String(formData.get("role") ?? "");

  if (!isValidStaffRole(roleValue)) {
    redirectWithError("That's not a valid staff role.");
  }

  const result = await addStaffMemberByEmail(email, roleValue);
  if (!result.ok) {
    redirectWithError(result.error);
  }

  revalidatePath(STAFF_PAGE_PATH);
  redirectWithSuccess(STAFF_ADDED_SUCCESS_MESSAGE);
}

export async function changeStaffRoleFormAction(formData: FormData) {
  const targetUserId = String(formData.get("targetUserId") ?? "");
  const roleValue = String(formData.get("role") ?? "");

  if (!isValidStaffRole(roleValue)) {
    redirectWithError("That's not a valid staff role.");
  }

  const result = await changeStaffRole(targetUserId, roleValue);
  if (!result.ok) {
    redirectWithError(result.error);
  }

  revalidatePath(STAFF_PAGE_PATH);
  redirectWithSuccess(STAFF_ROLE_CHANGED_SUCCESS_MESSAGE);
}

export async function removeStaffMemberFormAction(formData: FormData) {
  const targetUserId = String(formData.get("targetUserId") ?? "");

  const result = await removeStaffMember(targetUserId);
  if (!result.ok) {
    redirectWithError(result.error);
  }

  revalidatePath(STAFF_PAGE_PATH);
  redirectWithSuccess(STAFF_REMOVED_SUCCESS_MESSAGE);
}
