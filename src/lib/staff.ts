import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { roleHasPermission } from "@/lib/staff-permissions";
import type { Permission, StaffRole } from "@/lib/types";

export type StaffAccessDecision =
  | { kind: "allow" }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

// Pure authorization decision, deliberately separated from requireStaff()
// below so it's directly unit-testable without mocking Next.js's
// cookies()/redirect() machinery -- same extraction technique already
// used for decideAdminAccess() in src/lib/auth.ts, which this supersedes
// as the canonical staff-authorization decision. Never trusts a
// client-supplied role or permission -- both arguments here are always
// derived server-side, from staff_members via the authenticated user's
// own id, never from a request body/form/query param.
export function decideStaffAccess(params: {
  userId: string | null;
  staffRole: StaffRole | null;
  permission: Permission;
}): StaffAccessDecision {
  if (!params.userId) return { kind: "unauthenticated" };
  if (!params.staffRole) return { kind: "forbidden" };
  if (!roleHasPermission(params.staffRole, params.permission)) return { kind: "forbidden" };
  return { kind: "allow" };
}

type StaffContext = { userId: string | null; staffRole: StaffRole | null };

// Internal, shared by every helper below so a single call site never pays
// for two separate auth.getUser() + staff_members round trips. Uses the
// request-scoped, RLS-respecting client, not the admin/service-role
// client -- staff_members' own "Staff can view their own staff_members
// row" policy (migration 040) is exactly what makes this legal without
// any elevated privilege, the same pattern requireAdmin() already
// established for reading profiles.role.
async function loadStaffContext(): Promise<StaffContext> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { userId: null, staffRole: null };
  }

  const { data } = await supabase
    .from("staff_members")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  return { userId: user.id, staffRole: (data?.role as StaffRole | undefined) ?? null };
}

// Fails safe: no staff row, no matching id, or any query error all
// resolve to `null` here -- never an assumed role.
export async function getStaffMember(): Promise<{ userId: string; role: StaffRole } | null> {
  const { userId, staffRole } = await loadStaffContext();
  if (!userId || !staffRole) return null;
  return { userId, role: staffRole };
}

export async function hasPermission(permission: Permission): Promise<boolean> {
  const staff = await getStaffMember();
  return staff !== null && roleHasPermission(staff.role, permission);
}

// Durable, server-enforced gate for every staff-only surface (admin
// landing, book-report moderation, refund review, and any future admin
// functionality) -- the direct successor to requireAdmin() in
// src/lib/auth.ts, which is kept in place, unused, as a temporary
// compatibility wrapper (see migration 040's own header comment) rather
// than deleted in this same pass. Same redirect contract as
// requireAdmin() for continuity of the existing admin UX: unauthenticated
// -> /login, authenticated-but-lacking-the-permission -> / (never a raw
// 403/500, and never merely hidden client-side -- the redirect happens
// before any staff-only content or data is touched).
export async function requireStaff(permission: Permission) {
  const { userId, staffRole } = await loadStaffContext();
  const decision = decideStaffAccess({ userId, staffRole, permission });

  if (decision.kind === "unauthenticated") {
    redirect("/login");
  }
  if (decision.kind === "forbidden") {
    redirect("/");
  }

  return { userId: userId!, role: staffRole! };
}
