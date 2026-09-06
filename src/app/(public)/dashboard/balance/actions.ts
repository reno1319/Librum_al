"use server";

import { createClient } from "@/lib/supabase/server";
import type { AuthorFinancialSummaryRow, AuthorFinancialActivityRow } from "@/lib/types";

// LEDGER-1D: plain read primitives for the author-facing Financial
// Balance page, mirroring the exact shape of listAdminAuditEvents()
// (src/app/admin/(protected)/audit/actions.ts) -- a discriminated
// result, the request-scoped RLS-respecting client (never
// createAdminClient()), no redirect here.
//
// Neither RPC takes an author id: both are SECURITY DEFINER functions
// that derive identity from auth.uid() alone (migration 050). There is
// therefore no privilege check to duplicate here -- an unauthenticated
// caller gets rejected by the RPC's own REVOKE ALL / no anon grant (see
// that migration's own EXECUTE grants), and the dashboard layout
// (src/app/(public)/dashboard/layout.tsx) already gates every route
// under here to a logged-in author before this ever runs.

export type FinancialSummaryResult =
  | { ok: true; data: AuthorFinancialSummaryRow[] }
  | { ok: false; error: string };

export async function getAuthorFinancialSummary(): Promise<FinancialSummaryResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_author_financial_summary");

  if (error) {
    console.error("getAuthorFinancialSummary: RPC failed", { error });
    return { ok: false, error: "Could not load your financial summary. Please try again." };
  }

  return { ok: true, data: (data ?? []) as AuthorFinancialSummaryRow[] };
}

export type FinancialActivityParams = {
  limit?: number;
  cursorCreatedAt?: string | null;
  cursorId?: string | null;
};

export type FinancialActivityResult =
  | { ok: true; data: AuthorFinancialActivityRow[] }
  | { ok: false; error: string };

export async function listAuthorFinancialActivity(
  params: FinancialActivityParams = {},
): Promise<FinancialActivityResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_author_financial_activity", {
    p_limit: params.limit ?? 25,
    p_cursor_created_at: params.cursorCreatedAt ?? null,
    p_cursor_id: params.cursorId ?? null,
  });

  if (error) {
    console.error("listAuthorFinancialActivity: RPC failed", { error });
    return { ok: false, error: "Could not load your recent activity. Please try again." };
  }

  return { ok: true, data: (data ?? []) as AuthorFinancialActivityRow[] };
}
