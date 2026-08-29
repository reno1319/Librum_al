"use server";

import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { mapStaffRpcError, normalizeEmail, isValidStaffRole } from "./staff-management-logic";
import type { StaffListRow, StaffRole } from "@/lib/types";

// LIBRUM 2.0 ADMIN-1B PART B: server-side primitives for staff
// management, built ahead of any UI (explicitly deferred to Part C --
// no /admin/staff page, form, button, or confirmation dialog exists
// yet). These are plain async functions returning a discriminated
// result object, not redirect()-driving Server Actions in the style of
// reviewBookReport()/issueStripeRefund() -- there is no page to
// redirect back to yet, and committing to a specific redirect/
// revalidatePath shape now would be guessing at Part C's own UI
// structure. Part C wires these into real forms and decides the
// redirect/revalidate behavior once the page exists.
//
// requireStaff("staff.view"/"staff.manage") here is defense in depth,
// not the actual security boundary -- same posture every other admin
// Server Action in this codebase already documents (see
// src/app/admin/(protected)/reports/actions.ts's own comment). The real
// authority is each RPC itself (migration 041), which independently
// re-derives auth.uid() and re-checks staff_has_permission() before
// doing anything.
//
// CRITICAL (ADMIN-1B Part A's own audit finding #10/16, and this part's
// explicit instruction #17): every RPC call below goes through the
// normal request-scoped, cookie-bound createClient() -- never
// createAdminClient()/the service-role client. auth.uid() inside each
// RPC must resolve to the real, authenticated human staff member, both
// for authorization (staff_has_permission()) and for audit attribution
// (actor_id). Using the service-role client here would either break
// authorization entirely (auth.uid() resolving to null) or, worse,
// silently misattribute every audit row to no one. There is no
// createAdminClient import anywhere in this file, and none should ever
// be added -- ADMIN-1B application code does not need it: the one place
// that ever reads auth.users (the email -> account lookup) happens
// entirely inside add_staff_member_by_email() itself, server-side in
// Postgres, never in this file.

export type StaffMutationResult = { ok: true } | { ok: false; error: string };
export type StaffListResult =
  | { ok: true; data: StaffListRow[] }
  | { ok: false; error: string };

export async function listStaffMembers(): Promise<StaffListResult> {
  await requireStaff("staff.view");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_staff_members");

  if (error) {
    return { ok: false, error: mapStaffRpcError(error) };
  }
  return { ok: true, data: (data ?? []) as StaffListRow[] };
}

export async function addStaffMemberByEmail(
  email: string,
  role: StaffRole,
): Promise<StaffMutationResult> {
  await requireStaff("staff.manage");

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { ok: false, error: "Enter an email address." };
  }
  if (!isValidStaffRole(role)) {
    return { ok: false, error: "That's not a valid staff role." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("add_staff_member_by_email", {
    target_email: normalizedEmail,
    new_role: role,
  });

  if (error) {
    return { ok: false, error: mapStaffRpcError(error) };
  }
  return { ok: true };
}

export async function changeStaffRole(
  targetUserId: string,
  role: StaffRole,
): Promise<StaffMutationResult> {
  await requireStaff("staff.manage");

  if (!isValidStaffRole(role)) {
    return { ok: false, error: "That's not a valid staff role." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("change_staff_role", {
    target_user_id: targetUserId,
    new_role: role,
  });

  if (error) {
    return { ok: false, error: mapStaffRpcError(error) };
  }
  return { ok: true };
}

export async function removeStaffMember(targetUserId: string): Promise<StaffMutationResult> {
  await requireStaff("staff.manage");

  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_staff_member", {
    target_user_id: targetUserId,
  });

  if (error) {
    return { ok: false, error: mapStaffRpcError(error) };
  }
  return { ok: true };
}
