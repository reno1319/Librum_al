import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// BUILD 3 (Renato 11-23): whether an author's "Të dhënat e pagesës"
// (tax details + bank account) are complete -- required before a PAID
// book is sent for review or approved (sg1 a). Free books never ask.
//
// Only yes/no ever leaves the database here (migration 20261123200000):
// author_payment_details_ready_self() answers about the signed-in
// author only (granted to authenticated); author_payment_details_ready_for()
// answers about a given author and is granted to service_role only
// (the staff Approve action). No NID, tax number, name or IBAN is read
// by this module.

// The bundle publish refusal (a paid bundle sells the author's books).
export const BUNDLE_PAYMENT_DETAILS_MISSING_MESSAGE =
  "Para se të publikoni një paketë me çmim, plotësoni të dhënat e pagesës te Paratë › Të dhënat e pagesës.";

export type PaymentDetailsReadiness = "ready" | "missing" | "unavailable";

function toReadiness(
  where: string,
  { data, error }: { data: unknown; error: { code?: string } | null },
): PaymentDetailsReadiness {
  if (error || typeof data !== "boolean") {
    // The code only: never the row, never the raw message.
    console.error(`${where}: read failed`, { code: error?.code ?? null });
    return "unavailable";
  }
  return data ? "ready" : "missing";
}

// The signed-in author, through their own session client.
export async function readPaymentDetailsReadiness(supabase: SupabaseClient): Promise<PaymentDetailsReadiness> {
  return toReadiness("readPaymentDetailsReadiness", await supabase.rpc("author_payment_details_ready_self"));
}

// Staff only: the book's author, through the service-role client.
export async function readAuthorPaymentDetailsReadinessAsStaff(
  admin: SupabaseClient,
  authorId: string,
): Promise<PaymentDetailsReadiness> {
  return toReadiness(
    "readAuthorPaymentDetailsReadinessAsStaff",
    await admin.rpc("author_payment_details_ready_for", { p_author_id: authorId }),
  );
}

export type OwnPaymentDetailsState =
  | { ok: true; hasTaxDetails: boolean; hasBankAccount: boolean }
  | { ok: false };

// The author's own two parts, as yes/no each (the dashboard card and
// the page's "N nga 2 gati"). Reads only the author_id column through
// the author's own session (RLS: own row only).
export async function readOwnPaymentDetailsState(
  supabase: SupabaseClient,
  authorId: string,
): Promise<OwnPaymentDetailsState> {
  const [tax, bank] = await Promise.all([
    supabase.from("author_tax_details").select("author_id").eq("author_id", authorId).maybeSingle(),
    supabase
      .from("author_payout_destinations")
      .select("author_id")
      .eq("author_id", authorId)
      .eq("currency", "ALL")
      .maybeSingle(),
  ]);
  if (tax.error || bank.error) {
    console.error("readOwnPaymentDetailsState: read failed", {
      taxCode: tax.error?.code ?? null,
      bankCode: bank.error?.code ?? null,
    });
    return { ok: false };
  }
  return { ok: true, hasTaxDetails: tax.data !== null, hasBankAccount: bank.data !== null };
}
