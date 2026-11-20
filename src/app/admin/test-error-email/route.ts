import { notFound } from "next/navigation";
import { getStaffMember } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { TEST_ERROR_MESSAGE } from "@/lib/error-alerts";

// ALERTS-2 (Renato 11-20, a): a hidden link that proves the error email
// (ALERTS-1) reaches the team. Opening /admin/test-error-email while
// signed in as the staff OWNER throws on purpose, so the error goes
// through the same path as a real crash: onRequestError in
// src/instrumentation.ts -> src/lib/error-alerts.ts -> Resend ->
// support@librum.al. It emails on Production only and obeys the same cap
// (one an hour, three a day per server), like any other error.
//
// Owner only: staff.manage is the one permission only the owner role
// holds (src/lib/staff-permissions.ts). Everyone else, signed in or not,
// gets the normal "not found" page, so the link reveals nothing. Linked
// from nowhere.
export async function GET() {
  const staff = await getStaffMember();
  if (!staff || !roleHasPermission(staff.role, "staff.manage")) notFound();
  throw new Error(TEST_ERROR_MESSAGE);
}
