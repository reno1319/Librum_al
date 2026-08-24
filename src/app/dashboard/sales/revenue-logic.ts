// LAUNCH-1 P1-8: pure, directly-testable revenue-filtering logic for
// the Sales dashboard, extracted the same way src/app/library/
// refund-logic.ts already separates pure logic from its page.tsx --
// page.tsx has no established Server Component test harness in this
// codebase (it's an async function using createClient()), so the
// actual filtering decision lives here instead, where it can be unit
// tested directly.

export type PaymentIntentBearing = {
  stripe_payment_intent_id: string | null;
};

// A lost-disputed purchase or bundle snapshot must not be represented
// as active author revenue -- refunded_at alone (already filtered by
// both of the Sales page's own queries) never covers this, since a
// dispute never sets refunded_at (see the P1-7A/P1-8 audits). A row
// with no payment intent at all (a free acquisition) can never match a
// dispute (a dispute always has a real payment intent) and is always
// kept. Used identically for both `purchases` rows and
// `bundle_checkout_snapshots` rows -- a bundle's purchases rows and its
// own snapshot row always share one payment intent, so filtering both
// arrays against the SAME lostDisputedPaymentIntentIds set (built once,
// from the union of both arrays' payment intent ids) excludes a
// disputed bundle transaction consistently across both
// representations, not just one.
export function excludeLostDisputedRows<T extends PaymentIntentBearing>(
  rows: T[],
  lostDisputedPaymentIntentIds: ReadonlySet<string>,
): T[] {
  return rows.filter(
    (row) =>
      row.stripe_payment_intent_id === null ||
      !lostDisputedPaymentIntentIds.has(row.stripe_payment_intent_id),
  );
}

// Collects the distinct, non-null payment intent ids present across any
// number of arrays -- used to build the single batched
// lost_disputed_payment_intents() RPC call's input from BOTH the
// purchases and bundle_checkout_snapshots query results at once.
export function collectDistinctPaymentIntentIds(
  ...rowArrays: PaymentIntentBearing[][]
): string[] {
  const ids = new Set<string>();
  for (const rows of rowArrays) {
    for (const row of rows) {
      if (row.stripe_payment_intent_id !== null) {
        ids.add(row.stripe_payment_intent_id);
      }
    }
  }
  return Array.from(ids);
}
