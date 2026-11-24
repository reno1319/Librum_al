"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import { PAYOUT_DESTINATION_CURRENCY } from "../balance/balance-logic";
import {
  BANK_BOTH_REQUIRED_MESSAGE,
  BANK_SAVED_MESSAGE,
  PAYMENT_PAGE_PATH,
  TAX_LOAD_FAILED_MESSAGE,
  TAX_SAVED_MESSAGE,
  mapBankRpcError,
  mapTaxRpcError,
  validateTaxDetails,
} from "./payment-logic";

// BUILD 3 (Renato 11-23): the Payment & tax page's reads and writes.
//
// Privacy rules, the same as the bank form's (balance/actions.ts):
//   * every write goes through a SECURITY DEFINER RPC scoped by
//     auth.uid() -- no author id is ever sent from here;
//   * logs carry the Postgres error code only, never a name, NID, tax
//     number, IBAN or the raw error message;
//   * error messages shown to the author are our own fixed texts.
//
// Unlike the old bank form on Bilanci, saving here is NOT behind
// BANK_PAYOUT_SETUP_ENABLED: Renato's decision (sg1 a) is that the
// details are required before a paid book can be sold, so authors must
// be able to give them now. Payouts themselves stay off.

export type OwnTaxDetails = {
  country_code: string;
  legal_name: string;
  tax_id: string;
  updated_at: string;
};

export type OwnBankAccount = {
  beneficiary_name: string;
  iban: string;
  currency: string;
  updated_at: string;
};

export type PaymentPageData =
  | { ok: true; tax: OwnTaxDetails | null; bank: OwnBankAccount | null }
  | { ok: false; error: string };

export async function getOwnPaymentDetails(): Promise<PaymentPageData> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: TAX_LOAD_FAILED_MESSAGE };

  const [tax, bank] = await Promise.all([
    supabase
      .from("author_tax_details")
      .select("country_code, legal_name, tax_id, updated_at")
      .eq("author_id", user.id)
      .maybeSingle<OwnTaxDetails>(),
    supabase
      .from("author_payout_destinations")
      .select("beneficiary_name, iban, currency, updated_at")
      .eq("author_id", user.id)
      .eq("currency", PAYOUT_DESTINATION_CURRENCY)
      .maybeSingle<OwnBankAccount>(),
  ]);
  if (tax.error || bank.error) {
    console.error("getOwnPaymentDetails: read failed", {
      taxCode: tax.error?.code ?? null,
      bankCode: bank.error?.code ?? null,
    });
    return { ok: false, error: TAX_LOAD_FAILED_MESSAGE };
  }
  return { ok: true, tax: tax.data ?? null, bank: bank.data ?? null };
}

export async function saveTaxDetails(formData: FormData): Promise<void> {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(PAYMENT_PAGE_PATH);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${PAYMENT_PAGE_PATH}`);

  const validation = validateTaxDetails({
    residence: String(formData.get("residence") ?? ""),
    countryCode: String(formData.get("countryCode") ?? ""),
    legalName: String(formData.get("legalName") ?? ""),
    taxId: String(formData.get("taxId") ?? ""),
  });
  if (!validation.ok) {
    redirect(`/dashboard/payment?editTax=1&error=${encodeURIComponent(validation.message)}`);
  }

  const { error } = await supabase.rpc("set_author_tax_details", {
    p_country_code: validation.countryCode,
    p_legal_name: validation.legalName,
    p_tax_id: validation.taxId,
  });
  if (error) {
    console.error("saveTaxDetails: RPC failed", { code: error.code });
    redirect(`/dashboard/payment?editTax=1&error=${encodeURIComponent(mapTaxRpcError(error.message))}`);
  }

  revalidatePath(PAYMENT_PAGE_PATH);
  revalidatePath("/dashboard");
  redirect(`/dashboard/payment?success=${encodeURIComponent(TAX_SAVED_MESSAGE)}`);
}

export async function savePaymentBankAccount(formData: FormData): Promise<void> {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(PAYMENT_PAGE_PATH);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${PAYMENT_PAGE_PATH}`);

  const beneficiaryName = String(formData.get("beneficiaryName") ?? "").trim();
  const iban = String(formData.get("iban") ?? "").trim();
  if (!beneficiaryName || !iban) {
    redirect(`/dashboard/payment?editBank=1&error=${encodeURIComponent(BANK_BOTH_REQUIRED_MESSAGE)}`);
  }

  // Currency is fixed server-side (t3 a: everything stays in lek).
  const { error } = await supabase.rpc("set_author_payout_destination", {
    p_currency: PAYOUT_DESTINATION_CURRENCY,
    p_beneficiary_name: beneficiaryName,
    p_iban: iban,
  });
  if (error) {
    console.error("savePaymentBankAccount: RPC failed", { code: error.code });
    redirect(`/dashboard/payment?editBank=1&error=${encodeURIComponent(mapBankRpcError(error.message))}`);
  }

  revalidatePath(PAYMENT_PAGE_PATH);
  revalidatePath("/dashboard");
  redirect(`/dashboard/payment?success=${encodeURIComponent(BANK_SAVED_MESSAGE)}`);
}
