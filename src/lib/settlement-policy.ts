// LIBRUM 2.0 LEDGER-1C: the single named settlement-delay policy for
// author earnings, referenced by this file's own comment inside
// supabase/migrations/049_financial_accounting_primitives.sql. A future
// buyer-payment provider adapter (not yet built -- see that migration's
// own top-of-file comment) is expected to compute available_at once, at
// sale-recording time, using this constant, and pass the RESULT as an
// explicit parameter to record_successful_sale() -- the settlement delay
// is never hardcoded in SQL, so changing this constant later can never
// rewrite an already-recorded sale's own frozen available_at timestamp.
//
// 30 days, not Librum's own 14-day refund window (see
// request_refund()'s own eligibility check, supabase/schema.sql) --
// chosen deliberately LARGER than the refund window: a sale only
// becomes available for payout after the buyer's own refund eligibility
// has already closed, so a payout is never issued for a sale that could
// still be reversed by an ordinary refund request.
export const AUTHOR_EARNINGS_SETTLEMENT_DAYS = 30;

export function computeSaleAvailableAt(saleRecordedAt: Date): Date {
  const availableAt = new Date(saleRecordedAt.getTime());
  availableAt.setUTCDate(availableAt.getUTCDate() + AUTHOR_EARNINGS_SETTLEMENT_DAYS);
  return availableAt;
}
