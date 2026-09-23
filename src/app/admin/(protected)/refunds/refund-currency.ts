import { parseCurrencyProvenance, type CurrencyProvenance } from "@/lib/transaction-money";

// ALL-TXN-CURRENCY-4: the currency of each refund request, read through
// list_refund_request_currencies() (migration 20260923160231, gated on
// refunds.view -- the same permission as the refund_requests read that
// precedes it). refund_requests has no currency column, and its
// authoritative sources -- payments, book_checkout_intents -- are not
// readable by refund staff. The function resolves each request from its
// OWN frozen payment reference and bundle snapshot, never from the
// current purchases row, which a later transaction may have reused.
//
// A failed read, or a request the function does not return, is 'unknown'
// and renders as "Amount unavailable" -- never a guessed currency. The
// page itself stays usable: reviewing and issuing a refund do not depend
// on the displayed amount (executeApprovedRefund never sends one).

type RefundRequestCurrencyRow = {
  refund_request_id: string;
  currency_state: string;
  currency: string | null;
};

type RpcClient = {
  rpc: (
    fn: "list_refund_request_currencies",
    args: { p_refund_request_ids: string[] },
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

export async function loadRefundRequestCurrencies(
  supabase: RpcClient,
  refundRequestIds: string[],
): Promise<Map<string, CurrencyProvenance>> {
  const byId = new Map<string, CurrencyProvenance>();
  if (refundRequestIds.length === 0) {
    return byId;
  }

  const { data, error } = await supabase.rpc("list_refund_request_currencies", {
    p_refund_request_ids: refundRequestIds,
  });

  if (error) {
    console.error("Admin refunds: list_refund_request_currencies RPC failed", { error });
    return byId;
  }

  for (const row of (Array.isArray(data) ? data : []) as RefundRequestCurrencyRow[]) {
    byId.set(row.refund_request_id, parseCurrencyProvenance(row.currency_state, row.currency));
  }
  return byId;
}

export function refundRequestCurrency(
  currencies: Map<string, CurrencyProvenance>,
  refundRequestId: string,
): CurrencyProvenance {
  return currencies.get(refundRequestId) ?? { state: "unknown" };
}
