import { describe, expect, it } from "vitest";
import {
  calculateTotalSpentCents,
  deriveTransactionRefundState,
  groupPurchasesByTransaction,
  isWithinRefundEligibilityWindow,
  mapRefundRpcError,
  parseBundleSnapshotItems,
  validateRefundReason,
  GENERIC_REFUND_ERROR_MESSAGE,
  REFUND_REASON_MAX_LENGTH,
  type BundleSnapshotForGrouping,
  type PurchaseForGrouping,
} from "./refund-logic";

function purchase(overrides: Partial<PurchaseForGrouping> = {}): PurchaseForGrouping {
  return {
    book_id: "book-1",
    amount_cents: 500,
    created_at: "2026-01-01T00:00:00.000Z",
    refunded_at: null,
    stripe_payment_intent_id: "pi_default",
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<BundleSnapshotForGrouping> = {},
): BundleSnapshotForGrouping {
  return {
    id: "snapshot-1",
    stripe_payment_intent_id: "pi_default",
    total_amount_cents: 1200,
    fulfilled_at: "2026-01-01T00:00:00.000Z",
    refunded_at: null,
    items: [
      { book_id: "book-1", title: "Book One", price_cents_at_checkout: 500, position: 0 },
      { book_id: "book-2", title: "Book Two", price_cents_at_checkout: 700, position: 1 },
    ],
    ...overrides,
  };
}

describe("parseBundleSnapshotItems", () => {
  it("parses a well-formed items array", () => {
    const items = parseBundleSnapshotItems([
      { book_id: "b1", title: "Book One", price_cents_at_checkout: 500, position: 0 },
    ]);
    expect(items).toEqual([{ bookId: "b1", title: "Book One", priceCentsAtCheckout: 500 }]);
  });

  it("skips malformed entries instead of throwing", () => {
    const items = parseBundleSnapshotItems([
      { book_id: "b1", title: "Book One", price_cents_at_checkout: 500 },
      { title: "missing book_id" },
      "not an object",
      null,
      42,
    ]);
    expect(items).toEqual([{ bookId: "b1", title: "Book One", priceCentsAtCheckout: 500 }]);
  });

  it("returns an empty array for non-array input", () => {
    expect(parseBundleSnapshotItems(null)).toEqual([]);
    expect(parseBundleSnapshotItems(undefined)).toEqual([]);
    expect(parseBundleSnapshotItems("garbage")).toEqual([]);
  });
});

describe("groupPurchasesByTransaction", () => {
  it("groups an ordinary single-book purchase with no snapshot", () => {
    const groups = groupPurchasesByTransaction(
      [purchase({ book_id: "book-1", amount_cents: 999, stripe_payment_intent_id: "pi_single" })],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].hasSnapshot).toBe(false);
    expect(groups[0].bookCount).toBe(1);
    expect(groups[0].totalAmountCents).toBe(999);
    expect(groups[0].unpurchasedSnapshotItems).toEqual([]);
  });

  it("represents a normal bundle (snapshot + all expected purchases) as one fully-covered transaction", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({ book_id: "book-1", amount_cents: 500, stripe_payment_intent_id: "pi_bundle" }),
        purchase({ book_id: "book-2", amount_cents: 700, stripe_payment_intent_id: "pi_bundle" }),
      ],
      [snapshot({ stripe_payment_intent_id: "pi_bundle", total_amount_cents: 1200 })],
    );
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.hasSnapshot).toBe(true);
    expect(group.purchases).toHaveLength(2);
    expect(group.bookCount).toBe(2);
    expect(group.unpurchasedSnapshotItems).toEqual([]);
    expect(group.totalAmountCents).toBe(1200);
  });

  it("represents a partial-eligibility bundle using the snapshot's full item count and total, not just the purchases subset", () => {
    const groups = groupPurchasesByTransaction(
      [purchase({ book_id: "book-1", amount_cents: 200, stripe_payment_intent_id: "pi_partial" })],
      [
        snapshot({
          stripe_payment_intent_id: "pi_partial",
          total_amount_cents: 1500,
          items: [
            { book_id: "book-1", title: "Book One", price_cents_at_checkout: 200, position: 0 },
            { book_id: "book-2", title: "Book Two", price_cents_at_checkout: 1300, position: 1 },
          ],
        }),
      ],
    );
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.purchases).toHaveLength(1);
    expect(group.bookCount).toBe(2);
    expect(group.totalAmountCents).toBe(1500);
    expect(group.unpurchasedSnapshotItems).toEqual([
      { bookId: "book-2", title: "Book Two", priceCentsAtCheckout: 1300 },
    ]);
  });

  it("produces exactly one transaction group for a zero-purchase bundle (snapshot exists, no purchases rows share its payment intent)", () => {
    const groups = groupPurchasesByTransaction(
      [],
      [
        snapshot({
          stripe_payment_intent_id: "pi_zero",
          total_amount_cents: 899,
          items: [
            { book_id: "book-1", title: "Book One", price_cents_at_checkout: 400, position: 0 },
            { book_id: "book-2", title: "Book Two", price_cents_at_checkout: 499, position: 1 },
          ],
        }),
      ],
    );
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.stripePaymentIntentId).toBe("pi_zero");
    expect(group.hasSnapshot).toBe(true);
    expect(group.purchases).toEqual([]);
    expect(group.bookCount).toBe(2);
    expect(group.totalAmountCents).toBe(899);
    expect(group.unpurchasedSnapshotItems).toHaveLength(2);
  });

  it("never manufactures purchase/download ownership from snapshot item data", () => {
    const groups = groupPurchasesByTransaction(
      [],
      [snapshot({ stripe_payment_intent_id: "pi_zero" })],
    );
    // The zero-purchase group's own `purchases` array -- the only thing
    // the Library page ever renders a download control for -- must stay
    // empty even though the snapshot describes two books.
    expect(groups[0].purchases).toEqual([]);
  });

  it("keeps a normal bundle's snapshot total authoritative over the purchases-derived subtotal even when they'd otherwise coincidentally match", () => {
    const groups = groupPurchasesByTransaction(
      [purchase({ book_id: "book-1", amount_cents: 500, stripe_payment_intent_id: "pi_x" })],
      [
        snapshot({
          stripe_payment_intent_id: "pi_x",
          total_amount_cents: 5000, // Stripe's real charge for the whole PaymentIntent
          items: [{ book_id: "book-1", title: "Book One", price_cents_at_checkout: 500, position: 0 }],
        }),
      ],
    );
    // If this were still purchases-only, the total would be 500, not 5000.
    expect(groups[0].totalAmountCents).toBe(5000);
  });

  it("renders exactly one transaction group per payment intent, never one per purchase row", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({ book_id: "book-1", stripe_payment_intent_id: "pi_bundle" }),
        purchase({ book_id: "book-2", stripe_payment_intent_id: "pi_bundle" }),
        purchase({ book_id: "book-3", stripe_payment_intent_id: "pi_bundle" }),
      ],
      [snapshot({ stripe_payment_intent_id: "pi_bundle" })],
    );
    expect(groups).toHaveLength(1);
  });

  it("never merges two different payment intents into one transaction", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({ book_id: "book-1", stripe_payment_intent_id: "pi_a" }),
        purchase({ book_id: "book-2", stripe_payment_intent_id: "pi_b" }),
      ],
      [],
    );
    expect(groups).toHaveLength(2);
  });

  it("never merges free acquisitions (null payment intent) with each other", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({ book_id: "book-1", amount_cents: 0, stripe_payment_intent_id: null }),
        purchase({ book_id: "book-2", amount_cents: 0, stripe_payment_intent_id: null }),
      ],
      [],
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.stripePaymentIntentId === null)).toBe(true);
    expect(groups.every((g) => g.hasSnapshot === false)).toBe(true);
  });

  it("skips a snapshot with no payment intent (a genuinely free bundle) entirely", () => {
    const groups = groupPurchasesByTransaction(
      [],
      [snapshot({ stripe_payment_intent_id: null, total_amount_cents: 0 })],
    );
    expect(groups).toHaveLength(0);
  });

  it("excludes refunded purchases rows from the purchases-only fallback total", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({
          book_id: "book-1",
          amount_cents: 500,
          refunded_at: "2026-01-05T00:00:00.000Z",
          stripe_payment_intent_id: "pi_refunded",
        }),
      ],
      [],
    );
    expect(groups[0].totalAmountCents).toBe(0);
  });

  it("marks a transaction refunded via purchases.refunded_at when purchases rows exist", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({
          book_id: "book-1",
          refunded_at: "2026-01-05T00:00:00.000Z",
          stripe_payment_intent_id: "pi_refunded",
        }),
      ],
      [],
    );
    expect(groups[0].transactionRefunded).toBe(true);
  });

  it("marks a zero-purchase snapshot transaction refunded via bundle_checkout_snapshots.refunded_at", () => {
    const groups = groupPurchasesByTransaction(
      [],
      [
        snapshot({
          stripe_payment_intent_id: "pi_zero_refunded",
          refunded_at: "2026-01-06T00:00:00.000Z",
        }),
      ],
    );
    expect(groups[0].transactionRefunded).toBe(true);
  });

  it("uses fulfilled_at as the eligibility basis date for a zero-purchase snapshot transaction", () => {
    const groups = groupPurchasesByTransaction(
      [],
      [snapshot({ stripe_payment_intent_id: "pi_zero", fulfilled_at: "2026-02-01T00:00:00.000Z" })],
    );
    expect(groups[0].eligibilityBasisDate).toBe("2026-02-01T00:00:00.000Z");
  });

  it("uses the earliest purchases.created_at as the eligibility basis date when purchases rows exist", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({ book_id: "book-1", created_at: "2026-01-03T00:00:00.000Z", stripe_payment_intent_id: "pi_bundle" }),
        purchase({ book_id: "book-2", created_at: "2026-01-01T00:00:00.000Z", stripe_payment_intent_id: "pi_bundle" }),
      ],
      [],
    );
    expect(groups[0].eligibilityBasisDate).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("calculateTotalSpentCents", () => {
  it("counts an ordinary single-book purchase with no snapshot", () => {
    const groups = groupPurchasesByTransaction(
      [purchase({ book_id: "book-1", amount_cents: 999, stripe_payment_intent_id: "pi_single" })],
      [],
    );
    expect(calculateTotalSpentCents(groups)).toBe(999);
  });

  it("counts a normal bundle (purchases + snapshot) exactly once, at the snapshot total", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({ book_id: "book-1", amount_cents: 500, stripe_payment_intent_id: "pi_bundle" }),
        purchase({ book_id: "book-2", amount_cents: 700, stripe_payment_intent_id: "pi_bundle" }),
      ],
      [snapshot({ stripe_payment_intent_id: "pi_bundle", total_amount_cents: 1200 })],
    );
    // If this summed purchases AND snapshots independently, it would be
    // 1200 (purchases) + 1200 (snapshot) = 2400 -- double-counted.
    expect(calculateTotalSpentCents(groups)).toBe(1200);
  });

  it("uses the snapshot total (not the partial purchases sum) for a partial-eligibility bundle", () => {
    const groups = groupPurchasesByTransaction(
      [purchase({ book_id: "book-1", amount_cents: 200, stripe_payment_intent_id: "pi_partial" })],
      [
        snapshot({
          stripe_payment_intent_id: "pi_partial",
          total_amount_cents: 1500,
          items: [
            { book_id: "book-1", title: "Book One", price_cents_at_checkout: 200, position: 0 },
            { book_id: "book-2", title: "Book Two", price_cents_at_checkout: 1300, position: 1 },
          ],
        }),
      ],
    );
    expect(calculateTotalSpentCents(groups)).toBe(1500);
  });

  it("includes a zero-purchase paid bundle transaction", () => {
    const groups = groupPurchasesByTransaction(
      [],
      [snapshot({ stripe_payment_intent_id: "pi_zero", total_amount_cents: 899 })],
    );
    expect(calculateTotalSpentCents(groups)).toBe(899);
  });

  it("excludes a free acquisition (null payment intent)", () => {
    const groups = groupPurchasesByTransaction(
      [purchase({ book_id: "book-1", amount_cents: 0, stripe_payment_intent_id: null })],
      [],
    );
    expect(calculateTotalSpentCents(groups)).toBe(0);
  });

  it("excludes a transaction refunded via purchases.refunded_at", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({
          book_id: "book-1",
          amount_cents: 500,
          refunded_at: "2026-01-05T00:00:00.000Z",
          stripe_payment_intent_id: "pi_refunded",
        }),
      ],
      [],
    );
    expect(calculateTotalSpentCents(groups)).toBe(0);
  });

  it("excludes a zero-purchase snapshot transaction refunded via bundle_checkout_snapshots.refunded_at", () => {
    const groups = groupPurchasesByTransaction(
      [],
      [
        snapshot({
          stripe_payment_intent_id: "pi_zero_refunded",
          total_amount_cents: 899,
          refunded_at: "2026-01-06T00:00:00.000Z",
        }),
      ],
    );
    expect(calculateTotalSpentCents(groups)).toBe(0);
  });

  it("sums multiple distinct transactions correctly", () => {
    const groups = groupPurchasesByTransaction(
      [
        purchase({ book_id: "book-1", amount_cents: 999, stripe_payment_intent_id: "pi_a" }),
        purchase({ book_id: "book-2", amount_cents: 300, stripe_payment_intent_id: "pi_b" }),
        purchase({
          book_id: "book-3",
          amount_cents: 400,
          refunded_at: "2026-01-05T00:00:00.000Z",
          stripe_payment_intent_id: "pi_c",
        }),
      ],
      [snapshot({ stripe_payment_intent_id: "pi_zero", total_amount_cents: 899 })],
    );
    // pi_a (999) + pi_b (300) + pi_zero (899); pi_c excluded (refunded).
    expect(calculateTotalSpentCents(groups)).toBe(999 + 300 + 899);
  });
});

describe("deriveTransactionRefundState", () => {
  it("shows the request button and no cancel button when there has never been a request", () => {
    const state = deriveTransactionRefundState({
      transactionRefunded: false,
      latestRequestStatus: null,
    });
    expect(state).toEqual({
      statusLabel: null,
      showRequestButton: true,
      showCancelButton: false,
    });
  });

  it("exposes Request refund (not Cancel) for an otherwise-eligible snapshot-only transaction with no prior request", () => {
    const state = deriveTransactionRefundState({
      transactionRefunded: false,
      latestRequestStatus: null,
    });
    expect(state.showRequestButton).toBe(true);
    expect(state.showCancelButton).toBe(false);
  });

  it("exposes Cancel (not Request) once a snapshot-only transaction has an open request", () => {
    const state = deriveTransactionRefundState({
      transactionRefunded: false,
      latestRequestStatus: "requested",
    });
    expect(state.statusLabel).toBe("requested");
    expect(state.showRequestButton).toBe(false);
    expect(state.showCancelButton).toBe(true);
  });

  it("shows no reader action once a request has been approved", () => {
    const state = deriveTransactionRefundState({
      transactionRefunded: false,
      latestRequestStatus: "approved",
    });
    expect(state.statusLabel).toBe("approved");
    expect(state.showRequestButton).toBe(false);
    expect(state.showCancelButton).toBe(false);
  });

  it("allows requesting again after a rejection, with no cancel action", () => {
    const state = deriveTransactionRefundState({
      transactionRefunded: false,
      latestRequestStatus: "rejected",
    });
    expect(state.statusLabel).toBe("rejected");
    expect(state.showRequestButton).toBe(true);
    expect(state.showCancelButton).toBe(false);
  });

  it("allows requesting again after a cancellation, with no cancel action", () => {
    const state = deriveTransactionRefundState({
      transactionRefunded: false,
      latestRequestStatus: "cancelled",
    });
    expect(state.statusLabel).toBe("cancelled");
    expect(state.showRequestButton).toBe(true);
    expect(state.showCancelButton).toBe(false);
  });

  it("shows the refunded state with no actions once the transaction is actually refunded, regardless of request status", () => {
    const state = deriveTransactionRefundState({
      transactionRefunded: true,
      latestRequestStatus: "requested",
    });
    expect(state).toEqual({
      statusLabel: "refunded",
      showRequestButton: false,
      showCancelButton: false,
    });
  });

  it("shows the refunded state when the request row itself says refunded even if transactionRefunded lags", () => {
    const state = deriveTransactionRefundState({
      transactionRefunded: false,
      latestRequestStatus: "refunded",
    });
    expect(state.statusLabel).toBe("refunded");
    expect(state.showRequestButton).toBe(false);
    expect(state.showCancelButton).toBe(false);
  });
});

describe("validateRefundReason", () => {
  it("accepts a null reason", () => {
    expect(validateRefundReason(null)).toEqual({ ok: true, value: null });
  });

  it("treats an empty/whitespace-only reason as no reason", () => {
    expect(validateRefundReason("   ")).toEqual({ ok: true, value: null });
  });

  it("trims and accepts a reason within the limit", () => {
    expect(validateRefundReason("  wrong edition  ")).toEqual({
      ok: true,
      value: "wrong edition",
    });
  });

  it("rejects a reason over the 2000-character limit", () => {
    const tooLong = "a".repeat(REFUND_REASON_MAX_LENGTH + 1);
    const result = validateRefundReason(tooLong);
    expect(result.ok).toBe(false);
  });

  it("accepts a reason at exactly the 2000-character limit", () => {
    const exact = "a".repeat(REFUND_REASON_MAX_LENGTH);
    expect(validateRefundReason(exact)).toEqual({ ok: true, value: exact });
  });
});

describe("mapRefundRpcError", () => {
  it("maps a known RPC exception message to reader-facing copy", () => {
    expect(
      mapRefundRpcError({ message: "a refund request for this purchase is already open" }),
    ).toBe("You already have an open refund request for this purchase.");
  });

  it("maps the 14-day window exception to reader-facing copy", () => {
    expect(
      mapRefundRpcError({ message: "this purchase is outside the refund request window" }),
    ).toContain("14 days");
  });

  it("falls back to a generic message for an unrecognized error, never leaking raw Postgres text", () => {
    expect(
      mapRefundRpcError({
        message: 'duplicate key value violates unique constraint "refund_requests_pkey"',
      }),
    ).toBe(GENERIC_REFUND_ERROR_MESSAGE);
  });

  it("falls back to a generic message for a null/empty error", () => {
    expect(mapRefundRpcError(null)).toBe(GENERIC_REFUND_ERROR_MESSAGE);
    expect(mapRefundRpcError({ message: "" })).toBe(GENERIC_REFUND_ERROR_MESSAGE);
  });
});

describe("isWithinRefundEligibilityWindow", () => {
  it("is true just under 14 days after purchase", () => {
    const now = new Date("2026-01-15T00:00:00.000Z");
    const created = "2026-01-01T01:00:00.000Z";
    expect(isWithinRefundEligibilityWindow(created, now)).toBe(true);
  });

  it("is false once 14 days have fully elapsed", () => {
    const now = new Date("2026-01-16T00:00:00.000Z");
    const created = "2026-01-01T00:00:00.000Z";
    expect(isWithinRefundEligibilityWindow(created, now)).toBe(false);
  });

  it("is false for an unparseable date", () => {
    expect(isWithinRefundEligibilityWindow("not-a-date", new Date())).toBe(false);
  });

  it("works against a snapshot-only transaction's fulfilled_at basis date", () => {
    const now = new Date("2026-01-10T00:00:00.000Z");
    const groups = groupPurchasesByTransaction(
      [],
      [snapshot({ stripe_payment_intent_id: "pi_zero", fulfilled_at: "2026-01-05T00:00:00.000Z" })],
    );
    expect(isWithinRefundEligibilityWindow(groups[0].eligibilityBasisDate, now)).toBe(true);
  });
});

describe("free acquisitions remain non-refundable", () => {
  it("a free acquisition (null payment intent) never surfaces refund UI at the page level", () => {
    // The Library page only renders refund state when
    // group.stripePaymentIntentId is non-null (see page.tsx) -- this
    // asserts the grouping layer's contract that a free acquisition's
    // group always has a null stripePaymentIntentId, which is what
    // page.tsx relies on to skip rendering any refund action for it.
    const groups = groupPurchasesByTransaction(
      [purchase({ book_id: "book-1", amount_cents: 0, stripe_payment_intent_id: null })],
      [],
    );
    expect(groups[0].stripePaymentIntentId).toBeNull();
  });
});
