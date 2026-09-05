import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type AdminAccessDecision =
  | { kind: "allow" }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" };

// Pure authorization decision, deliberately separated from requireAdmin()
// below so it's directly unit-testable without mocking Next.js's
// cookies()/redirect() machinery -- the same extraction technique
// already used for the bundle-checkout link-back decision
// (src/app/bundles/[id]/link-back.ts). Takes exactly the two facts the
// decision depends on, nothing else -- no Supabase client, no request
// context.
export function decideAdminAccess(params: {
  userId: string | null;
  profileRole: string | null | undefined;
}): AdminAccessDecision {
  if (!params.userId) return { kind: "unauthenticated" };
  if (params.profileRole !== "admin") return { kind: "forbidden" };
  return { kind: "allow" };
}

// Durable, server-enforced gate for marketplace-operator surfaces
// (refund administration, content moderation, support tooling, and any
// future admin functionality) -- see migration 028 and the Phase
// REFUND-1A audit. Uses the request-scoped, RLS-respecting client, not
// the admin/service-role client -- this only ever reads the CALLER's
// own row (`.eq("id", user.id)` below), which profiles' "Users can view
// their own full profile" RLS policy (migration 045) already permits
// with no elevated privilege, and there is no reason for this check
// itself to hold service-role credentials. Mirrors the
// exact pattern already used by src/app/dashboard/layout.tsx for
// author-only routes -- unauthenticated and non-admin callers are
// redirected server-side before any admin-only content or data is ever
// touched, never merely hidden client-side.
//
// role === "admin" can only ever be true for a profile promoted
// directly in the database (see migration 028's own comment) -- signup
// and profile-editing can never produce it, confirmed by tracing every
// write path to profiles.role in this codebase.
export async function requireAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = user
    ? await supabase
        .from("profiles")
        .select("id, role, display_name")
        .eq("id", user.id)
        .single()
    : { data: null };

  const decision = decideAdminAccess({
    userId: user?.id ?? null,
    profileRole: profile?.role,
  });

  if (decision.kind === "unauthenticated") {
    redirect("/login");
  }
  if (decision.kind === "forbidden") {
    redirect("/");
  }

  return { user: user!, profile: profile! };
}
