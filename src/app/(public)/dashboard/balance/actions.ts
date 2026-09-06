"use server";

import { createClient } from "@/lib/supabase/server";
import type {
  AuthorFinancialSummaryRow,
  AuthorFinancialActivityRow,
  AuthorPayoutOverviewRow,
  AuthorPayoutHistoryRow,
} from "@/lib/types";

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

// LEDGER-1E-C: same discriminated-result, no-p_author_id-parameter
// pattern as the two ledger primitives above -- get_author_payout_overview()
// (migration 052) is SECURITY DEFINER and derives identity from
// auth.uid() alone, so there is no privilege check to duplicate here
// either.
export type PayoutOverviewResult =
  | { ok: true; data: AuthorPayoutOverviewRow[] }
  | { ok: false; error: string };

export async function getAuthorPayoutOverview(): Promise<PayoutOverviewResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_author_payout_overview");

  if (error) {
    console.error("getAuthorPayoutOverview: RPC failed", { error });
    return { ok: false, error: "Could not load your payout overview. Please try again." };
  }

  return { ok: true, data: (data ?? []) as AuthorPayoutOverviewRow[] };
}

export type PayoutHistoryParams = {
  limit?: number;
  cursorCreatedAt?: string | null;
  cursorId?: string | null;
};

export type PayoutHistoryResult =
  | { ok: true; data: AuthorPayoutHistoryRow[] }
  | { ok: false; error: string };

export async function listAuthorPayoutHistory(
  params: PayoutHistoryParams = {},
): Promise<PayoutHistoryResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_author_payout_history", {
    p_limit: params.limit ?? 25,
    p_cursor_created_at: params.cursorCreatedAt ?? null,
    p_cursor_id: params.cursorId ?? null,
  });

  if (error) {
    console.error("listAuthorPayoutHistory: RPC failed", { error });
    return { ok: false, error: "Could not load your payout history. Please try again." };
  }

  return { ok: true, data: (data ?? []) as AuthorPayoutHistoryRow[] };
}
