import { describe, expect, it } from "vitest";
import { excludeLostDisputedRows } from "./revenue-logic";

describe("excludeLostDisputedRows", () => {
  it("excludes a row whose payment intent has a lost dispute", () => {
    const rows = [
      { stripe_payment_intent_id: "pi_clean" },
      { stripe_payment_intent_id: "pi_lost_disputed" },
    ];
    const result = excludeLostDisputedRows(rows, new Set(["pi_lost_disputed"]));
    expect(result).toEqual([{ stripe_payment_intent_id: "pi_clean" }]);
  });

  it("keeps a row with a null payment intent (a free acquisition) regardless of the excluded set", () => {
    const rows = [{ stripe_payment_intent_id: null }];
    const result = excludeLostDisputedRows(rows, new Set(["pi_anything"]));
    expect(result).toEqual(rows);
  });

  it("keeps every row unchanged when the excluded set is empty", () => {
    const rows = [{ stripe_payment_intent_id: "pi_a" }, { stripe_payment_intent_id: "pi_b" }];
    expect(excludeLostDisputedRows(rows, new Set())).toEqual(rows);
  });

  // LAUNCH-1 P1-8: a bundle's purchases rows and its own
  // bundle_checkout_snapshots row always share one payment intent --
  // calling this with the SAME excluded set against both arrays (as
  // the Sales page does) must exclude a disputed bundle transaction
  // consistently across both representations, not just one.
  it("excludes a disputed bundle transaction consistently across both purchases rows and its snapshot row", () => {
    const excluded = new Set(["pi_bundle_disputed"]);
    const purchases = [
      { stripe_payment_intent_id: "pi_bundle_disputed", book_id: "book-a" },
      { stripe_payment_intent_id: "pi_bundle_disputed", book_id: "book-b" },
      { stripe_payment_intent_id: "pi_clean", book_id: "book-c" },
    ];
    const snapshots = [
      { stripe_payment_intent_id: "pi_bundle_disputed", total_amount_cents: 999 },
      { stripe_payment_intent_id: "pi_clean_bundle", total_amount_cents: 500 },
    ];

    expect(excludeLostDisputedRows(purchases, excluded)).toEqual([
      { stripe_payment_intent_id: "pi_clean", book_id: "book-c" },
    ]);
    expect(excludeLostDisputedRows(snapshots, excluded)).toEqual([
      { stripe_payment_intent_id: "pi_clean_bundle", total_amount_cents: 500 },
    ]);
  });
});
