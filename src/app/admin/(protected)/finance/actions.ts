"use server";

import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import type {
  FinanceRefundReconciliationRow,
  FinanceDisputeRow,
  FinanceCheckoutExceptionRow,
  FinanceRefundEntitlementMismatchRow,
  FinanceSummaryCounts,
  RefundOperationalState,
} from "@/lib/types";

// ADMIN-1D Part B server primitives -- plain async functions, NOT
// redirect-driving, each returning a discriminated result (same shape as
// listAdminAuditEvents() in ../audit/actions.ts). No /admin/finance UI
// exists yet (this is explicitly Part B's own read-primitives-only
// scope); these exist so that later UI work has a stable, already-tested
// read layer ready when it's built.
//
// requireStaff("finance.view") in every function below is defense-in-
// depth, matching every other Part B/C primitive already in this
// codebase -- the real authority is each RPC itself (migration 043),
// which independently re-derives the caller's identity via auth.uid()
// and re-checks staff_has_permission('finance.view'). Uses createClient()
// (the request-scoped, RLS-respecting client) -- never
// createAdminClient(): every one of these RPCs is SECURITY DEFINER and
// needs no service-role privilege to run.
//
// No Stripe call exists anywhere in this file, and none of these
// functions may ever INSERT/UPDATE/DELETE against refund_issuance_
// attempts, payment_disputes, book_checkout_intents, or bundle_checkout_
// snapshots -- every one of them is a read of an existing, already-
// reviewed RPC. See supabase/migrations/043_finance_reconciliation_
// reads.sql for the full design reasoning behind each RPC's shape.

export const GENERIC_FINANCE_ERROR_MESSAGE = "Something went wrong. Please try again.";

// The exact `raise exception '...'` strings every migration-043 RPC can
// produce, mapped to admin-facing copy. Deliberately NOT a passthrough
// of error.message -- anything not in this list falls through to
// GENERIC_FINANCE_ERROR_MESSAGE rather than ever reaching the browser,
// the same discipline mapAuditRpcError/mapReviewRpcError already
// establish in this codebase.
export const FINANCE_RPC_NOT_AUTHENTICATED_MESSAGE = "not authenticated";

const KNOWN_FINANCE_RPC_ERROR_MESSAGES: Record<string, string> = {
  "not authorized": "You don't have permission to view finance data.",
  "invalid operational_state filter": "That's not a valid refund state filter.",
  "invalid cursor": "That pagination link is no longer valid.",
};

export function mapFinanceRpcError(error: { message?: string | null } | null | undefined): string {
  const message = error?.message?.trim();
  if (!message) {
    return GENERIC_FINANCE_ERROR_MESSAGE;
  }
  return KNOWN_FINANCE_RPC_ERROR_MESSAGES[message] ?? GENERIC_FINANCE_ERROR_MESSAGE;
}

export type FinanceListResult<T> = { ok: true; data: T[] } | { ok: false; error: string };
export type FinanceSummaryResult =
  | { ok: true; data: FinanceSummaryCounts }
  | { ok: false; error: string };

export type RefundReconciliationListParams = {
  operationalState?: RefundOperationalState | null;
  needsAttention?: boolean | null;
  cursorRequestedAt?: string | null;
  cursorId?: string | null;
  limit?: number | null;
};

export async function listRefundReconciliationStates(
  params: RefundReconciliationListParams = {},
): Promise<FinanceListResult<FinanceRefundReconciliationRow>> {
  await requireStaff("finance.view");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_refund_reconciliation_states", {
    p_operational_state: params.operationalState ?? null,
    p_needs_attention: params.needsAttention ?? null,
    p_cursor_requested_at: params.cursorRequestedAt ?? null,
    p_cursor_id: params.cursorId ?? null,
    p_limit: params.limit ?? 25,
  });

  if (error) {
    return { ok: false, error: mapFinanceRpcError(error) };
  }

  return { ok: true, data: (data ?? []) as FinanceRefundReconciliationRow[] };
}

export type FinanceDisputeListParams = {
  needsAttention?: boolean | null;
  cursorCreatedAt?: string | null;
  cursorId?: string | null;
  limit?: number | null;
};

export async function listFinanceDisputes(
  params: FinanceDisputeListParams = {},
): Promise<FinanceListResult<FinanceDisputeRow>> {
  await requireStaff("finance.view");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_finance_disputes", {
    p_needs_attention: params.needsAttention ?? null,
    p_cursor_created_at: params.cursorCreatedAt ?? null,
    p_cursor_id: params.cursorId ?? null,
    p_limit: params.limit ?? 25,
  });

  if (error) {
    return { ok: false, error: mapFinanceRpcError(error) };
  }

  return { ok: true, data: (data ?? []) as FinanceDisputeRow[] };
}

export type FinanceCheckoutExceptionListParams = {
  cursorCompletedAt?: string | null;
  cursorId?: string | null;
  limit?: number | null;
};

export async function listFinanceCheckoutExceptions(
  params: FinanceCheckoutExceptionListParams = {},
): Promise<FinanceListResult<FinanceCheckoutExceptionRow>> {
  await requireStaff("finance.view");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_finance_checkout_exceptions", {
    p_cursor_completed_at: params.cursorCompletedAt ?? null,
    p_cursor_id: params.cursorId ?? null,
    p_limit: params.limit ?? 25,
  });

  if (error) {
    return { ok: false, error: mapFinanceRpcError(error) };
  }

  return { ok: true, data: (data ?? []) as FinanceCheckoutExceptionRow[] };
}

export type FinanceRefundEntitlementMismatchListParams = {
  limit?: number | null;
};

export async function listFinanceRefundEntitlementMismatches(
  params: FinanceRefundEntitlementMismatchListParams = {},
): Promise<FinanceListResult<FinanceRefundEntitlementMismatchRow>> {
  await requireStaff("finance.view");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_finance_refund_entitlement_mismatches", {
    p_limit: params.limit ?? 25,
  });

  if (error) {
    return { ok: false, error: mapFinanceRpcError(error) };
  }

  return { ok: true, data: (data ?? []) as FinanceRefundEntitlementMismatchRow[] };
}

export async function getFinanceSummaryCounts(): Promise<FinanceSummaryResult> {
  await requireStaff("finance.view");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_finance_summary_counts");

  if (error) {
    return { ok: false, error: mapFinanceRpcError(error) };
  }

  // get_finance_summary_counts() returns exactly one row (a `returns
  // table (...)` function with a single-row projection, same PostgREST
  // shape as any other RPC of this kind -- the client always hands back
  // an array). A missing/empty result would mean the RPC itself failed
  // to execute at all despite no `error`, which should not be possible
  // given its own implementation always returns one row -- treated as a
  // generic failure rather than fabricating zero counts.
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return { ok: false, error: GENERIC_FINANCE_ERROR_MESSAGE };
  }

  return { ok: true, data: row as FinanceSummaryCounts };
}
