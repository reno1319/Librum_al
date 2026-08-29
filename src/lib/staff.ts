import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { roleHasPermission } from "@/lib/staff-permissions";
import { ADMIN_LOGIN_PATH, resolveSafeAdminPath } from "@/lib/admin-safe-redirect";
import { INTERNAL_PATHNAME_HEADER } from "@/lib/internal-headers";
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
// than deleted in this same pass.
//
// ADMIN-1A.5: the unauthenticated redirect target changed from /login to
// /admin/login, with the caller's own destination preserved as a safe
// ?next= where possible -- the "ADMIN REDIRECT CONTRACT" -- implemented
// exactly once, here, rather than duplicated in every /admin/* page or
// Server Action, since every one of them already calls this same
// function. Uses the same INTERNAL_PATHNAME_HEADER mechanism
// src/app/dashboard/layout.tsx already established for the equivalent
// author-only case (Proxy forwards the real, request-derived pathname;
// this never trusts client input for it), re-validated here through
// resolveSafeAdminPath() rather than trusted blindly, same as that
// layout's own precedent. Works identically whether requireStaff() is
// called from a page render or from a Server Action invocation -- a
// Server Action's own POST targets "the route where it's used" (Next.js's
// own docs), so the forwarded pathname is still the calling admin page's
// own path either way. next is omitted entirely when it would just be
// "/admin" -- that's already the plain fallback below, so there's
// nothing worth preserving in that one case.
//
// The forbidden (authenticated, but lacking this specific permission)
// case is UNCHANGED -- still redirects to "/", exactly as requireAdmin()
// always did. This is deliberate, not an oversight: /admin/login's own
// "authenticated but not staff" access-denied state is specifically for
// someone who just came THROUGH that login flow (see
// src/app/admin/login/page.tsx) -- a user who reaches an /admin/* page
// directly, already signed in from an ordinary session, without the
// required permission gets sent home exactly as before. Never assume a
// user is authorized merely because they came through /admin/login (or
// any other route) -- this permission re-check is the actual boundary
// either way.
export async function requireStaff(permission: Permission) {
  const { userId, staffRole } = await loadStaffContext();
  const decision = decideStaffAccess({ userId, staffRole, permission });

  if (decision.kind === "unauthenticated") {
    const headerList = await headers();
    const currentPath = resolveSafeAdminPath(headerList.get(INTERNAL_PATHNAME_HEADER));
    const next = currentPath && currentPath !== "/admin" ? currentPath : null;
    redirect(next ? `${ADMIN_LOGIN_PATH}?next=${encodeURIComponent(next)}` : ADMIN_LOGIN_PATH);
  }
  if (decision.kind === "forbidden") {
    redirect("/");
  }

  return { userId: userId!, role: staffRole! };
}
