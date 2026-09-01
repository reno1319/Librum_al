"use server";

import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { mapAuditRpcError } from "./audit-log-logic";
import type { AuditEventRow } from "@/lib/types";

// LIBRUM 2.0 ADMIN-1C PART B server primitive -- plain async function,
// NOT redirect-driving, returning a discriminated result (same shape as
// listStaffMembers() in src/app/admin/(protected)/staff/actions.ts). No
// /admin/audit UI exists yet (Part C's own scope); this exists so that
// layer has a stable, tested read primitive ready when it's built.
//
// requireStaff("audit.view") here is defense-in-depth, matching every
// other Part B primitive in this codebase -- the real authority is
// list_admin_audit_events() itself (migration 042), which independently
// re-derives the caller's identity via auth.uid() and re-checks
// staff_has_permission('audit.view'). Uses createClient() (the
// request-scoped, RLS-respecting client) -- never createAdminClient().
export type AuditListParams = {
  action?: string | null;
  actorId?: string | null;
  targetType?: string | null;
  createdAfter?: string | null;
  createdBefore?: string | null;
  cursorCreatedAt?: string | null;
  cursorId?: string | null;
  limit?: number | null;
};

export type AuditListResult =
  | { ok: true; data: AuditEventRow[] }
  | { ok: false; error: string };

export async function listAdminAuditEvents(
  params: AuditListParams = {},
): Promise<AuditListResult> {
  await requireStaff("audit.view");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_admin_audit_events", {
    p_action: params.action ?? null,
    p_actor_id: params.actorId ?? null,
    p_target_type: params.targetType ?? null,
    p_created_after: params.createdAfter ?? null,
    p_created_before: params.createdBefore ?? null,
    p_cursor_created_at: params.cursorCreatedAt ?? null,
    p_cursor_id: params.cursorId ?? null,
    p_limit: params.limit ?? 25,
  });

  if (error) {
    return { ok: false, error: mapAuditRpcError(error) };
  }

  return { ok: true, data: (data ?? []) as AuditEventRow[] };
}
