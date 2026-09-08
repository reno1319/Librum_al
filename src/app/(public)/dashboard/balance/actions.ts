"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { PAYOUT_DESTINATION_CURRENCY, isBankPayoutSetupEnabled } from "./balance-logic";
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

// ---------------------------------------------------------------------
// BANK-PAYOUT-1E: bank destination read/write, built entirely on the
// live migration-055 primitives. Writes go exclusively through
// set_author_payout_destination() (never a direct INSERT/UPDATE against
// author_payout_destinations, and no author_id is ever accepted from
// the client -- the RPC derives identity from auth.uid() alone). The
// read is a direct table SELECT rather than a new RPC (this task may
// not add migration 056): author_payout_destinations already carries
// its own "Authors can view their own payout destination" RLS policy
// from migration 055, and the explicit author_id/currency filters below
// are defense-in-depth on top of that RLS scoping, not a substitute for
// it -- matching this codebase's own established convention (e.g.
// dashboard/profile/page.tsx's `.eq("id", user.id)`).
// ---------------------------------------------------------------------

export type AuthorPayoutDestination = {
  beneficiary_name: string;
  iban: string;
  currency: string;
  updated_at: string;
};

export type AuthorPayoutDestinationResult =
  | { ok: true; data: AuthorPayoutDestination | null }
  | { ok: false; error: string };

export async function getAuthorPayoutDestination(): Promise<AuthorPayoutDestinationResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { ok: false, error: "Not authenticated." };
  }

  const { data, error } = await supabase
    .from("author_payout_destinations")
    .select("beneficiary_name, iban, currency, updated_at")
    .eq("author_id", user.id)
    .eq("currency", PAYOUT_DESTINATION_CURRENCY)
    .maybeSingle();

  if (error) {
    // Section 10: never log the beneficiary name or IBAN this query
    // could return -- only the Postgres error code (a fixed,
    // non-data-bearing enum value), never the row itself or the raw
    // error object's own message text.
    console.error("getAuthorPayoutDestination: read failed", { code: error.code });
    return { ok: false, error: "Could not load your bank account details. Please try again." };
  }

  return { ok: true, data: data as AuthorPayoutDestination | null };
}

// Known-safe set_author_payout_destination() exception messages
// (migration 055, Part 11) -- verified against that migration's own
// source: none of the five interpolates the caller's own submitted
// beneficiary name or IBAN value into the message, only static
// guidance text, so rephrasing and returning these to the browser can
// never echo sensitive input back. Currency-format rejection is
// deliberately NOT mapped here: currency is hardcoded to
// PAYOUT_DESTINATION_CURRENCY server-side (never caller-supplied), so
// that branch of the RPC is structurally unreachable from this action.
// Anything that doesn't match one of these falls through to a single
// generic message -- the raw Supabase/Postgres error object is never
// forwarded to the browser.
function mapDestinationRpcError(message: string): string {
  if (message.includes("beneficiary_name is required")) {
    return "Please enter the account holder's name.";
  }
  if (message.includes("iban is required")) {
    return "Please enter your IBAN.";
  }
  if (message.includes("does not match the expected Albanian IBAN format")) {
    return "That doesn't look like a valid Albanian IBAN (it should start with AL, followed by 26 digits or letters).";
  }
  if (message.includes("fails checksum validation")) {
    return "That IBAN doesn't look valid. Please double-check the number and try again.";
  }
  return "We couldn't save your bank details. Please check the information and try again.";
}

// Server Action for the "Add/Change bank account" form (Section 9).
// Requires an authenticated author, accepts only beneficiaryName + iban
// from the submitted form, and hard-codes currency to
// PAYOUT_DESTINATION_CURRENCY -- the client can never select or
// override it (no hidden "currency" field is even read from formData).
// The database RPC remains the sole authority on IBAN structural/
// checksum validity; nothing here reimplements that check.
export async function saveAuthorPayoutDestination(formData: FormData): Promise<void> {
  // BANK-PAYOUT-1E.1 Section 7: fails closed independently of whether
  // the form itself is currently rendered -- Stripe Connect remains
  // the only LIVE author-payout mechanism today (see balance-logic.ts's
  // own comment on isBankPayoutSetupEnabled), so this write path must
  // never be reachable via a direct/crafted POST while the rollout
  // switch is off, regardless of what the page happened to show this
  // request. Checked BEFORE reading the user or touching any bank
  // field -- no destination RPC call, no write of any kind, when
  // disabled.
  if (!isBankPayoutSetupEnabled(process.env.BANK_PAYOUT_SETUP_ENABLED)) {
    redirect(`/dashboard/balance?error=${encodeURIComponent("Bank payout setup isn't available yet.")}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/balance");
  }

  const beneficiaryName = String(formData.get("beneficiaryName") ?? "").trim();
  const iban = String(formData.get("iban") ?? "").trim();

  if (!beneficiaryName || !iban) {
    redirect(
      `/dashboard/balance?editBank=1&error=${encodeURIComponent("Please fill in both the account holder name and IBAN.")}`,
    );
  }

  const { error } = await supabase.rpc("set_author_payout_destination", {
    p_currency: PAYOUT_DESTINATION_CURRENCY,
    p_beneficiary_name: beneficiaryName,
    p_iban: iban,
  });

  if (error) {
    // Section 10: no beneficiary name, no IBAN, no form body, and no
    // raw RPC payload in this log line -- the Postgres error code alone
    // is enough to distinguish "expected validation rejection" from "a
    // genuine unexpected failure" in the server logs without ever
    // risking sensitive data reaching them.
    console.error("saveAuthorPayoutDestination: RPC failed", { code: error.code });
    redirect(`/dashboard/balance?editBank=1&error=${encodeURIComponent(mapDestinationRpcError(error.message))}`);
  }

  revalidatePath("/dashboard/balance");
  redirect(`/dashboard/balance?success=${encodeURIComponent("Bank details saved.")}`);
}
