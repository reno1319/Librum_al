import { describe, expect, it, vi, beforeEach } from "vitest";
import type Stripe from "stripe";
import type { NextResponse } from "next/server";

// fulfillBundleSnapshot sends purchase/sale emails on a successful,
// winning fulfillment -- the real implementation looks up reader/author
// emails via the Supabase auth admin API and calls Resend, neither of
// which exists in this in-memory test double. Stubbed out entirely;
// these tests assert on database rows, not on emails sent.
vi.mock("@/lib/email", () => ({
  sendPurchaseEmails: vi.fn().mockResolvedValue(undefined),
  sendBundlePurchaseEmails: vi.fn().mockResolvedValue(undefined),
  sendSnapshotBundlePurchaseEmails: vi.fn().mockResolvedValue(undefined),
}));

const {
  fulfillBundleSnapshot,
  fulfillLegacyBundle,
  fulfillSingleBookPurchase,
  processChargeRefund,
  processRefundLifecycleEvent,
  processChargeRefundedEvent,
  processDisputeEvent,
} = await import("./route");

// ---------------------------------------------------------------------
// A minimal, in-memory fake of the Supabase query builder -- just
// enough of the fluent chain (.select/.eq/.is/.in/.update/.upsert/
// .delete/.maybeSingle, and plain `await` on the builder itself) to
// exercise every Supabase call fulfillBundleSnapshot and
// processChargeRefund actually make against `bundle_checkout_snapshots`,
// `purchases`, and `refund_requests`. Not a general-purpose Supabase
// mock -- deliberately scoped to these functions' call shapes, since
// that's what these tests drive. `.in()` and the errorOnUpdate injection
// hook (both used only by the processChargeRefund tests below) were
// added for Phase REFUND-1B Step 4 -- everything else is unchanged from
// the original fulfillBundleSnapshot test suite.
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; val: unknown; op: "eq" | "in" }[] = [];
  private op: "select" | "update" | "upsert" | "delete" = "select";
  private payload: Row | undefined;
  private upsertOnConflict: string | undefined;
  private wantReturnRows = false;

  constructor(
    private tables: Tables,
    private table: string,
    private errorOnUpdate: Partial<Record<string, unknown>> = {},
  ) {}

  select() {
    if (this.op !== "select") this.wantReturnRows = true;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, val, op: "eq" });
    return this;
  }

  is(col: string, val: unknown) {
    this.filters.push({ col, val, op: "eq" });
    return this;
  }

  in(col: string, vals: unknown[]) {
    this.filters.push({ col, val: vals, op: "in" });
    return this;
  }

  // Real Supabase's .returns<T>() is a type-only cast with no runtime
  // effect -- fulfillLegacyBundle's bundle_books query is the first in
  // this test file to call it, since every other select() here already
  // gets its shape from a maybeSingle() or a plain await instead.
  returns<T>() {
    return this as unknown as PromiseLike<{ data: T; error: unknown }>;
  }

  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }

  upsert(payload: Row, options?: { onConflict: string }) {
    this.op = "upsert";
    this.payload = payload;
    this.upsertOnConflict = options?.onConflict;
    return this;
  }

  delete() {
    this.op = "delete";
    return this;
  }

  private rows(): Row[] {
    return (this.tables[this.table] ??= []);
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) =>
      f.op === "in" ? (f.val as unknown[]).includes(row[f.col]) : row[f.col] === f.val,
    );
  }

  private execute(): { data: unknown; error: unknown } {
    const rows = this.rows();

    if (this.op === "select") {
      return { data: rows.filter((r) => this.matches(r)), error: null };
    }

    if (this.op === "update") {
      // Injected failure simulation (Phase REFUND-1B Step 4's error-path
      // tests) -- returns a Postgres-shaped error without touching any
      // row, exactly like a real failed UPDATE would leave the table
      // unchanged.
      if (this.table in this.errorOnUpdate) {
        return { data: null, error: this.errorOnUpdate[this.table] };
      }
      const matched = rows.filter((r) => this.matches(r));
      for (const row of matched) Object.assign(row, this.payload);
      return { data: this.wantReturnRows ? matched : null, error: null };
    }

    if (this.op === "delete") {
      this.tables[this.table] = rows.filter((r) => !this.matches(r));
      return { data: null, error: null };
    }

    // upsert
    // Same injected-failure mechanism as the update branch above (LAUNCH-1
    // P1-4's fulfillSingleBookPurchase write-failure test is the first to
    // need it on an upsert rather than an update).
    if (this.table in this.errorOnUpdate) {
      return { data: null, error: this.errorOnUpdate[this.table] };
    }
    const conflictCols = (this.upsertOnConflict ?? "").split(",").map((s) => s.trim());
    const existingIndex = rows.findIndex((r) =>
      conflictCols.every((c) => r[c] === this.payload![c]),
    );
    if (existingIndex >= 0) {
      rows[existingIndex] = { ...rows[existingIndex], ...this.payload };
    } else {
      rows.push({ ...this.payload });
    }
    return { data: null, error: null };
  }

  maybeSingle() {
    const { data, error } = this.execute();
    const arr = data as Row[];
    return Promise.resolve({ data: arr?.[0] ?? null, error });
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

function makeFakeSupabase(tables: Tables, errorOnUpdate: Partial<Record<string, unknown>> = {}) {
  return {
    from: (table: string) => new FakeQuery(tables, table, errorOnUpdate),
  };
}

// ---------------------------------------------------------------------
// Fixture: the exact scenario manually verified in production --
// reader already owns book A (a completely unrelated, earlier
// transaction), does not own book B, and buys a 2-book bundle
// containing both for 599 cents.
// ---------------------------------------------------------------------
const READER_ID = "reader-1";
const SNAPSHOT_ID = "snap-1";
const BUNDLE_ID = "bundle-1";
const NEW_SESSION_ID = "cs_test_new_599";
const NEW_PAYMENT_INTENT_ID = "pi_test_new_599";
const OLD_SESSION_ID = "cs_test_old_unrelated";
const OLD_PAYMENT_INTENT_ID = "pi_test_old_unrelated";
const BOOK_A = "book-a"; // already owned (Great God Pan)
const BOOK_B = "book-b"; // not yet owned (War of the Worlds)

function freshTables(): Tables {
  return {
    bundle_checkout_snapshots: [
      {
        id: SNAPSHOT_ID,
        reader_id: READER_ID,
        author_id: "author-1",
        bundle_id: BUNDLE_ID,
        bundle_title: "Integrity Test Bundle",
        bundle_price_cents_at_checkout: 599,
        items: [
          { book_id: BOOK_A, title: "The Great God Pan", price_cents_at_checkout: 300, position: 0 },
          { book_id: BOOK_B, title: "The War of the Worlds", price_cents_at_checkout: 299, position: 1 },
        ],
        protection_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        fulfilled_at: null,
        stripe_checkout_session_id: null,
        total_amount_cents: null,
        stripe_payment_intent_id: null,
        refunded_at: null,
      },
    ],
    purchases: [
      {
        id: "purchase-a-1",
        book_id: BOOK_A,
        reader_id: READER_ID,
        stripe_checkout_session_id: OLD_SESSION_ID,
        stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID,
        amount_cents: 999,
        bundle_id: null,
        refunded_at: null,
        created_at: "2020-01-01T00:00:00.000Z",
      },
    ],
    bundle_checkout_reservations: [],
    bundle_checkout_reader_holds: [],
  };
}

function fakeFailWebhook(): NextResponse {
  return { status: 500 } as unknown as NextResponse;
}

describe("fulfillBundleSnapshot: partially-owned bundle transaction integrity", () => {
  let tables: Tables;

  beforeEach(() => {
    tables = freshTables();
  });

  it("leaves the already-owned book's purchase row completely untouched", async () => {
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillBundleSnapshot(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      { id: NEW_SESSION_ID } as Stripe.Checkout.Session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();

    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A);
    expect(bookARow).toEqual({
      id: "purchase-a-1",
      book_id: BOOK_A,
      reader_id: READER_ID,
      stripe_checkout_session_id: OLD_SESSION_ID,
      stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID,
      amount_cents: 999,
      bundle_id: null,
      refunded_at: null,
      created_at: "2020-01-01T00:00:00.000Z",
    });
  });

  it("grants the not-yet-owned book a new entitlement for the full transaction amount", async () => {
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    await fulfillBundleSnapshot(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      { id: NEW_SESSION_ID } as Stripe.Checkout.Session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();

    const bookBRows = tables.purchases.filter((r) => r.book_id === BOOK_B);
    expect(bookBRows).toHaveLength(1);
    expect(bookBRows[0]).toMatchObject({
      book_id: BOOK_B,
      reader_id: READER_ID,
      stripe_checkout_session_id: NEW_SESSION_ID,
      stripe_payment_intent_id: NEW_PAYMENT_INTENT_ID,
      amount_cents: 599,
      bundle_id: BUNDLE_ID,
      refunded_at: null,
    });
  });

  it("marks the snapshot fulfilled with consistent transaction metadata", async () => {
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    await fulfillBundleSnapshot(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      { id: NEW_SESSION_ID } as Stripe.Checkout.Session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );

    const snapshot = tables.bundle_checkout_snapshots[0];
    expect(snapshot.fulfilled_at).not.toBeNull();
    expect(snapshot.total_amount_cents).toBe(599);
    expect(snapshot.stripe_payment_intent_id).toBe(NEW_PAYMENT_INTENT_ID);
    expect(snapshot.refunded_at).toBeNull();

    // Transaction-metadata consistency: the sum of every purchases row
    // that belongs to THIS Stripe session (not the reader's unrelated
    // prior purchase) equals both the snapshot's own recorded total and
    // the amount the webhook was told Stripe actually charged.
    const thisSessionCents = tables.purchases
      .filter((r) => r.stripe_checkout_session_id === NEW_SESSION_ID)
      .reduce((sum, r) => sum + (r.amount_cents as number), 0);
    expect(thisSessionCents).toBe(599);
    expect(thisSessionCents).toBe(snapshot.total_amount_cents);
  });

  it("is idempotent: a duplicate webhook delivery creates no duplicate entitlement and does not re-fulfill", async () => {
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);
    const event = { id: "evt_1" } as Stripe.Event;
    const session = { id: NEW_SESSION_ID } as Stripe.Checkout.Session;

    const firstResult = await fulfillBundleSnapshot(
      supabase as never,
      event,
      session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );
    expect(firstResult).toBeNull();

    const purchaseCountAfterFirst = tables.purchases.length;
    const fulfilledAtAfterFirst = tables.bundle_checkout_snapshots[0].fulfilled_at;
    expect(purchaseCountAfterFirst).toBe(2); // book A (pre-existing) + book B (new)
    expect(fulfilledAtAfterFirst).not.toBeNull();

    // Stripe redelivers the same event -- same event, same session, same
    // snapshot, same amount.
    const secondResult = await fulfillBundleSnapshot(
      supabase as never,
      event,
      session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );

    // The snapshot.fulfilled_at fast-path (checked BEFORE any
    // classification or write is attempted) short-circuits the entire
    // redelivery.
    expect(secondResult).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.purchases).toHaveLength(purchaseCountAfterFirst);
    expect(tables.bundle_checkout_snapshots[0].fulfilled_at).toBe(fulfilledAtAfterFirst);

    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A);
    const bookBRow = tables.purchases.find((r) => r.book_id === BOOK_B);
    expect(bookARow?.amount_cents).toBe(999);
    expect(bookARow?.stripe_checkout_session_id).toBe(OLD_SESSION_ID);
    expect(bookBRow?.amount_cents).toBe(599);
    expect(bookBRow?.stripe_checkout_session_id).toBe(NEW_SESSION_ID);
  });
});

// ---------------------------------------------------------------------
// LAUNCH-1 P1-7A: the bundle-path dispute-before-fulfillment guard.
// Mirrors finalize_book_checkout_intent's own SQL-level guard
// (migration 035) at the Node layer, since fulfillBundleSnapshot is not
// itself a locked RPC. Scoped by stripe_payment_intent_id, exactly like
// every other lookup in this function.
// ---------------------------------------------------------------------
describe("fulfillBundleSnapshot: dispute-before-fulfillment guard", () => {
  let tables: Tables;

  beforeEach(() => {
    tables = freshTables();
  });

  it("a 'lost' dispute on this payment intent blocks entitlement entirely -- no purchases written, snapshot left unclaimed", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-row-1",
        stripe_dispute_id: "dp_test_1",
        stripe_payment_intent_id: NEW_PAYMENT_INTENT_ID,
        status: "lost",
        reason: "fraudulent",
        amount_cents: 599,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fulfillBundleSnapshot(
      supabase as never,
      { id: "evt_disputed" } as Stripe.Event,
      { id: NEW_SESSION_ID } as Stripe.Checkout.Session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.purchases.find((r) => r.book_id === BOOK_B)).toBeUndefined();
    expect(tables.bundle_checkout_snapshots[0].fulfilled_at).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("blocked by an already-lost dispute"),
      expect.objectContaining({ paymentIntentId: NEW_PAYMENT_INTENT_ID, snapshotId: SNAPSHOT_ID }),
    );
    errorSpy.mockRestore();
  });

  it("a non-'lost' dispute status (e.g. under_review) does not block entitlement", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-row-2",
        stripe_dispute_id: "dp_test_2",
        stripe_payment_intent_id: NEW_PAYMENT_INTENT_ID,
        status: "under_review",
        reason: "fraudulent",
        amount_cents: 599,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillBundleSnapshot(
      supabase as never,
      { id: "evt_under_review" } as Stripe.Event,
      { id: NEW_SESSION_ID } as Stripe.Checkout.Session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.purchases.find((r) => r.book_id === BOOK_B)).toBeDefined();
    expect(tables.bundle_checkout_snapshots[0].fulfilled_at).not.toBeNull();
  });

  it("no payment intent (a genuinely free bundle) skips the dispute check entirely", async () => {
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillBundleSnapshot(
      supabase as never,
      { id: "evt_free" } as Stripe.Event,
      { id: NEW_SESSION_ID } as Stripe.Checkout.Session,
      SNAPSHOT_ID,
      null,
      0,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------
// LAUNCH-1 P1-7A pre-production correction: "active_other_session" must
// not match a reader's own OLD purchase row when that row's payment
// intent has a 'lost' dispute (a dispute never sets refunded_at, so the
// original classification test alone would wrongly treat it as still
// active). Reuses freshTables()'s existing fixture: BOOK_A is already
// "owned" by READER_ID via OLD_SESSION_ID/OLD_PAYMENT_INTENT_ID.
// ---------------------------------------------------------------------
describe("fulfillBundleSnapshot: active_other_session must exclude a lost-disputed existing purchase", () => {
  let tables: Tables;

  beforeEach(() => {
    tables = freshTables();
  });

  it("a lost dispute on the OLD purchase's payment intent reclassifies it eligible -- the reader is granted fresh entitlement via this new transaction", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-row-old",
        stripe_dispute_id: "dp_test_old",
        stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID,
        status: "lost",
        reason: "fraudulent",
        amount_cents: 999,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillBundleSnapshot(
      supabase as never,
      { id: "evt_repurchase" } as Stripe.Event,
      { id: NEW_SESSION_ID } as Stripe.Checkout.Session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();

    // Same row (unique(book_id, reader_id)), now updated to reflect the
    // NEW, legitimate repurchase transaction -- no longer the stale old
    // session/payment intent.
    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A);
    expect(bookARow?.stripe_checkout_session_id).toBe(NEW_SESSION_ID);
    expect(bookARow?.stripe_payment_intent_id).toBe(NEW_PAYMENT_INTENT_ID);
    expect(bookARow?.refunded_at).toBeNull();
  });

  it("a non-lost dispute (e.g. won) on the OLD purchase's payment intent leaves active_other_session classification unchanged -- regression check", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-row-old-won",
        stripe_dispute_id: "dp_test_old_won",
        stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID,
        status: "won",
        reason: "fraudulent",
        amount_cents: 999,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillBundleSnapshot(
      supabase as never,
      { id: "evt_still_active" } as Stripe.Event,
      { id: NEW_SESSION_ID } as Stripe.Checkout.Session,
      SNAPSHOT_ID,
      NEW_PAYMENT_INTENT_ID,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();

    // Untouched -- still the OLD transaction's own values, exactly as
    // active_other_session has always guaranteed.
    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A);
    expect(bookARow?.stripe_checkout_session_id).toBe(OLD_SESSION_ID);
    expect(bookARow?.stripe_payment_intent_id).toBe(OLD_PAYMENT_INTENT_ID);
  });
});

// ---------------------------------------------------------------------
// LAUNCH-1 P1-7A remediation: fulfillLegacyBundle -- the pre-migration-
// 025 checkout.session.completed shape (metadata.bundle_id + reader_id,
// no snapshot_id), extracted out of POST() for direct testability, the
// same reason as every other handler in this file. The audit that led
// to this section found this branch had received the exact same
// active_other_session-vs-lost-dispute reclassification fix as
// fulfillBundleSnapshot (both already tested above), but NOT the
// standalone pre-fulfillment "block entirely if THIS transaction's own
// payment intent is already lost" guard fulfillBundleSnapshot has. These
// tests cover that guard, plus a baseline/regression pass over the
// reclassification fix now that this branch is independently callable.
// Uses its own fixture (freshLegacyTables), deliberately disjoint from
// freshTables()'s ids, since bundle_books/books is a different table
// shape than bundle_checkout_snapshots.items.
// ---------------------------------------------------------------------
const READER_ID_LEGACY = "reader-legacy-1";
const BUNDLE_ID_LEGACY = "bundle-legacy-1";
const NEW_SESSION_ID_LEGACY = "cs_test_legacy_new_599";
const NEW_PAYMENT_INTENT_ID_LEGACY = "pi_test_legacy_new_599";
const OLD_SESSION_ID_LEGACY = "cs_test_legacy_old_unrelated";
const OLD_PAYMENT_INTENT_ID_LEGACY = "pi_test_legacy_old_unrelated";
const BOOK_A_LEGACY = "book-legacy-a"; // already owned, unrelated old transaction
const BOOK_B_LEGACY = "book-legacy-b"; // not yet owned

function freshLegacyTables(): Tables {
  return {
    bundle_books: [
      { book_id: BOOK_A_LEGACY, bundle_id: BUNDLE_ID_LEGACY, books: { price_cents: 300 } },
      { book_id: BOOK_B_LEGACY, bundle_id: BUNDLE_ID_LEGACY, books: { price_cents: 299 } },
    ],
    purchases: [
      {
        id: "purchase-legacy-a-1",
        book_id: BOOK_A_LEGACY,
        reader_id: READER_ID_LEGACY,
        stripe_checkout_session_id: OLD_SESSION_ID_LEGACY,
        stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID_LEGACY,
        amount_cents: 999,
        bundle_id: null,
        refunded_at: null,
        created_at: "2020-01-01T00:00:00.000Z",
      },
    ],
    payment_disputes: [],
  };
}

describe("fulfillLegacyBundle: dispute-before-fulfillment guard", () => {
  let tables: Tables;

  beforeEach(() => {
    tables = freshLegacyTables();
  });

  it("a 'lost' dispute on this transaction's payment intent blocks entitlement entirely -- zero purchases written for every book in the bundle, nothing overwritten", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-legacy-row-1",
        stripe_dispute_id: "dp_test_legacy_1",
        stripe_payment_intent_id: NEW_PAYMENT_INTENT_ID_LEGACY,
        status: "lost",
        reason: "fraudulent",
        amount_cents: 599,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_legacy_disputed" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();

    // Book B (not previously owned) must not have been granted -- the
    // guard runs before the book list is even read, so this proves it
    // blocks every book in the bundle, not just one.
    expect(tables.purchases.find((r) => r.book_id === BOOK_B_LEGACY)).toBeUndefined();

    // Book A's pre-existing, unrelated purchase row must be completely
    // untouched -- still the OLD transaction's own values, not
    // overwritten with this blocked transaction's session/payment intent.
    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A_LEGACY);
    expect(bookARow?.stripe_checkout_session_id).toBe(OLD_SESSION_ID_LEGACY);
    expect(bookARow?.stripe_payment_intent_id).toBe(OLD_PAYMENT_INTENT_ID_LEGACY);
    expect(tables.purchases).toHaveLength(1);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("blocked by an already-lost dispute"),
      expect.objectContaining({
        paymentIntentId: NEW_PAYMENT_INTENT_ID_LEGACY,
        bundleId: BUNDLE_ID_LEGACY,
        readerId: READER_ID_LEGACY,
      }),
    );
    errorSpy.mockRestore();
  });

  it("a replayed/duplicate webhook delivery for an already-lost-disputed payment intent remains safe -- still zero writes, still no error, on every delivery", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-legacy-row-replay",
        stripe_dispute_id: "dp_test_legacy_replay",
        stripe_payment_intent_id: NEW_PAYMENT_INTENT_ID_LEGACY,
        status: "lost",
        reason: "fraudulent",
        amount_cents: 599,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const event = { id: "evt_legacy_disputed_replay" } as Stripe.Event;
    const session = { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session;

    const first = await fulfillLegacyBundle(
      supabase as never,
      event,
      session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );
    const second = await fulfillLegacyBundle(
      supabase as never,
      event,
      session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.purchases).toHaveLength(1); // unchanged pre-existing row only, both times
    errorSpy.mockRestore();
  });

  it("a non-'lost' dispute status (e.g. under_review) on this transaction's payment intent does not block fulfillment", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-legacy-row-2",
        stripe_dispute_id: "dp_test_legacy_2",
        stripe_payment_intent_id: NEW_PAYMENT_INTENT_ID_LEGACY,
        status: "under_review",
        reason: "fraudulent",
        amount_cents: 599,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_legacy_under_review" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const bookBRow = tables.purchases.find((r) => r.book_id === BOOK_B_LEGACY);
    expect(bookBRow).toBeDefined();
    expect(bookBRow?.stripe_checkout_session_id).toBe(NEW_SESSION_ID_LEGACY);
    expect(bookBRow?.stripe_payment_intent_id).toBe(NEW_PAYMENT_INTENT_ID_LEGACY);
  });

  it("no payment intent (a genuinely free legacy bundle) skips the dispute check entirely and fulfills normally", async () => {
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_legacy_free" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      null,
      0,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.purchases.find((r) => r.book_id === BOOK_B_LEGACY)).toBeDefined();
  });
});

describe("fulfillLegacyBundle: active_other_session must exclude a lost-disputed existing purchase", () => {
  let tables: Tables;

  beforeEach(() => {
    tables = freshLegacyTables();
  });

  it("a lost dispute on the OLD purchase's payment intent reclassifies it eligible -- the reader is granted fresh entitlement via this new legacy transaction", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-legacy-row-old",
        stripe_dispute_id: "dp_test_legacy_old",
        stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID_LEGACY,
        status: "lost",
        reason: "fraudulent",
        amount_cents: 999,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_legacy_repurchase" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();

    // Same row (unique(book_id, reader_id)), now updated to reflect the
    // NEW, legitimate repurchase transaction -- no longer the stale old
    // session/payment intent.
    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A_LEGACY);
    expect(bookARow?.stripe_checkout_session_id).toBe(NEW_SESSION_ID_LEGACY);
    expect(bookARow?.stripe_payment_intent_id).toBe(NEW_PAYMENT_INTENT_ID_LEGACY);
    expect(bookARow?.refunded_at).toBeNull();
  });

  it("a non-lost dispute (e.g. won) on the OLD purchase's payment intent leaves active_other_session classification unchanged -- regression check", async () => {
    tables.payment_disputes = [
      {
        id: "dispute-legacy-row-old-won",
        stripe_dispute_id: "dp_test_legacy_old_won",
        stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID_LEGACY,
        status: "won",
        reason: "fraudulent",
        amount_cents: 999,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_legacy_still_active" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();

    // Untouched -- still the OLD transaction's own values, exactly as
    // active_other_session has always guaranteed.
    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A_LEGACY);
    expect(bookARow?.stripe_checkout_session_id).toBe(OLD_SESSION_ID_LEGACY);
    expect(bookARow?.stripe_payment_intent_id).toBe(OLD_PAYMENT_INTENT_ID_LEGACY);
  });
});

// ---------------------------------------------------------------------
// LAUNCH-1 P1-4: fulfillSingleBookPurchase is now a thin wrapper around
// finalize_book_checkout_intent (migration 032) -- a SECURITY DEFINER
// SQL RPC that does the classification, the purchases write, and the
// intent's own state transition as one atomic, advisory-lock-serialized
// Postgres transaction. That logic no longer exists in TypeScript at
// all, so these tests mock the RPC call itself and assert only what
// remains this function's own job: which arguments it sends, and how it
// maps each returned outcome to sending (or not sending) the purchase
// email and to logging for reconciliation. The RPC's own concurrency/
// classification correctness is covered by the committed SQL regression
// suite in supabase/tests/032_book_checkout_intents.test.sql and
// supabase/tests/032_advisory_lock_contention.sh, not here.
// ---------------------------------------------------------------------
const SB_INTENT_ID = "intent-sb-1";
const SB_BOOK_ID = "book-sb-1";
const SB_READER_ID = "reader-sb-1";
const SB_SESSION_ID = "cs_test_sb_new";
const SB_PAYMENT_INTENT_ID = "pi_test_sb_new";

function makeRpcSupabase(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { rpc };
}

describe("fulfillSingleBookPurchase: finalize_book_checkout_intent wrapper", () => {
  it("calls finalize_book_checkout_intent with exactly the expected arguments", async () => {
    const supabase = makeRpcSupabase({
      data: [{ outcome: "eligible_fulfilled", out_book_id: SB_BOOK_ID, out_reader_id: SB_READER_ID }],
      error: null,
    });
    const failWebhook = vi.fn(fakeFailWebhook);

    await fulfillSingleBookPurchase(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      { id: SB_SESSION_ID, metadata: {} } as unknown as Stripe.Checkout.Session,
      SB_INTENT_ID,
      SB_PAYMENT_INTENT_ID,
      500,
      failWebhook,
    );

    expect(supabase.rpc).toHaveBeenCalledWith("finalize_book_checkout_intent", {
      p_intent_id: SB_INTENT_ID,
      p_stripe_checkout_session_id: SB_SESSION_ID,
      p_stripe_payment_intent_id: SB_PAYMENT_INTENT_ID,
      p_amount_cents: 500,
    });
  });

  it("eligible_fulfilled: sends the purchase email with the RPC's own book_id/reader_id", async () => {
    const supabase = makeRpcSupabase({
      data: [{ outcome: "eligible_fulfilled", out_book_id: SB_BOOK_ID, out_reader_id: SB_READER_ID }],
      error: null,
    });
    const failWebhook = vi.fn(fakeFailWebhook);
    vi.mocked((await import("@/lib/email")).sendPurchaseEmails).mockClear();

    const result = await fulfillSingleBookPurchase(
      supabase as never,
      { id: "evt_2" } as Stripe.Event,
      { id: SB_SESSION_ID, metadata: {} } as unknown as Stripe.Checkout.Session,
      SB_INTENT_ID,
      SB_PAYMENT_INTENT_ID,
      500,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const { sendPurchaseEmails } = await import("@/lib/email");
    expect(sendPurchaseEmails).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ bookId: SB_BOOK_ID, readerId: SB_READER_ID, amountCents: 500 }),
    );
  });

  it("active_other_session: sends no email, logs for reconciliation, still 200s", async () => {
    const supabase = makeRpcSupabase({
      data: [{ outcome: "active_other_session", out_book_id: SB_BOOK_ID, out_reader_id: SB_READER_ID }],
      error: null,
    });
    const failWebhook = vi.fn(fakeFailWebhook);
    vi.mocked((await import("@/lib/email")).sendPurchaseEmails).mockClear();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fulfillSingleBookPurchase(
      supabase as never,
      { id: "evt_3" } as Stripe.Event,
      { id: SB_SESSION_ID, metadata: {} } as unknown as Stripe.Checkout.Session,
      SB_INTENT_ID,
      SB_PAYMENT_INTENT_ID,
      500,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const { sendPurchaseEmails } = await import("@/lib/email");
    expect(sendPurchaseEmails).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("needs manual reconciliation"),
      expect.objectContaining({ outcome: "active_other_session" }),
    );
    errorSpy.mockRestore();
  });

  it("blocked_book_or_reader_deleted: sends no email, logs for reconciliation, still 200s", async () => {
    const supabase = makeRpcSupabase({
      data: [{ outcome: "blocked_book_or_reader_deleted", out_book_id: null, out_reader_id: null }],
      error: null,
    });
    const failWebhook = vi.fn(fakeFailWebhook);
    vi.mocked((await import("@/lib/email")).sendPurchaseEmails).mockClear();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fulfillSingleBookPurchase(
      supabase as never,
      { id: "evt_4" } as Stripe.Event,
      { id: SB_SESSION_ID, metadata: {} } as unknown as Stripe.Checkout.Session,
      SB_INTENT_ID,
      SB_PAYMENT_INTENT_ID,
      500,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const { sendPurchaseEmails } = await import("@/lib/email");
    expect(sendPurchaseEmails).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("blocked_disputed_lost (LAUNCH-1 P1-7A): sends no email, logs for reconciliation, still 200s", async () => {
    const supabase = makeRpcSupabase({
      data: [{ outcome: "blocked_disputed_lost", out_book_id: SB_BOOK_ID, out_reader_id: SB_READER_ID }],
      error: null,
    });
    const failWebhook = vi.fn(fakeFailWebhook);
    vi.mocked((await import("@/lib/email")).sendPurchaseEmails).mockClear();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fulfillSingleBookPurchase(
      supabase as never,
      { id: "evt_disputed" } as Stripe.Event,
      { id: SB_SESSION_ID, metadata: {} } as unknown as Stripe.Checkout.Session,
      SB_INTENT_ID,
      SB_PAYMENT_INTENT_ID,
      500,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const { sendPurchaseEmails } = await import("@/lib/email");
    expect(sendPurchaseEmails).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("needs manual reconciliation"),
      expect.objectContaining({ outcome: "blocked_disputed_lost" }),
    );
    errorSpy.mockRestore();
  });

  it("already_finalized (duplicate webhook delivery): complete no-op, no email, no error log", async () => {
    const supabase = makeRpcSupabase({
      data: [{ outcome: "already_finalized", out_book_id: SB_BOOK_ID, out_reader_id: SB_READER_ID }],
      error: null,
    });
    const failWebhook = vi.fn(fakeFailWebhook);
    vi.mocked((await import("@/lib/email")).sendPurchaseEmails).mockClear();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fulfillSingleBookPurchase(
      supabase as never,
      { id: "evt_5" } as Stripe.Event,
      { id: SB_SESSION_ID, metadata: {} } as unknown as Stripe.Checkout.Session,
      SB_INTENT_ID,
      SB_PAYMENT_INTENT_ID,
      500,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const { sendPurchaseEmails } = await import("@/lib/email");
    expect(sendPurchaseEmails).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("RPC error: fails the webhook via failWebhook, sends no email", async () => {
    const supabase = makeRpcSupabase({ data: null, error: { message: "connection reset" } });
    const failWebhook = vi.fn(fakeFailWebhook);
    vi.mocked((await import("@/lib/email")).sendPurchaseEmails).mockClear();

    const result = await fulfillSingleBookPurchase(
      supabase as never,
      { id: "evt_6" } as Stripe.Event,
      { id: SB_SESSION_ID, metadata: {} } as unknown as Stripe.Checkout.Session,
      SB_INTENT_ID,
      SB_PAYMENT_INTENT_ID,
      500,
      failWebhook,
    );

    expect(result).not.toBeNull();
    expect(failWebhook).toHaveBeenCalledOnce();
    const { sendPurchaseEmails } = await import("@/lib/email");
    expect(sendPurchaseEmails).not.toHaveBeenCalled();
  });

  it("RPC returns no row (defensive): fails the webhook rather than silently succeeding", async () => {
    const supabase = makeRpcSupabase({ data: [], error: null });
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillSingleBookPurchase(
      supabase as never,
      { id: "evt_7" } as Stripe.Event,
      { id: SB_SESSION_ID, metadata: {} } as unknown as Stripe.Checkout.Session,
      SB_INTENT_ID,
      SB_PAYMENT_INTENT_ID,
      500,
      failWebhook,
    );

    expect(result).not.toBeNull();
    expect(failWebhook).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------
// Phase REFUND-1B Step 4: processChargeRefund's refund_requests sync,
// alongside the pre-existing purchases/snapshot refund behavior it was
// extracted from (unchanged by this phase -- see route.ts's own
// comment on processChargeRefund for the extraction rationale).
// ---------------------------------------------------------------------
describe("processChargeRefund: refund_requests synchronization", () => {
  const PAYMENT_INTENT_ID = "pi_test_refund_sync";
  const OTHER_PAYMENT_INTENT_ID = "pi_test_unrelated";
  const REQUEST_ID = "refund-request-1";
  const READER_ID = "reader-1";
  const ADMIN_ID = "admin-1";

  function refundTables(overrides: { refund_requests?: Row[] } = {}): Tables {
    return {
      purchases: [
        {
          id: "purchase-1",
          book_id: "book-1",
          reader_id: READER_ID,
          stripe_checkout_session_id: "cs_test_1",
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          amount_cents: 500,
          bundle_id: null,
          refunded_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
        // A completely unrelated purchase (different payment intent) --
        // must never be touched by a refund of PAYMENT_INTENT_ID.
        {
          id: "purchase-unrelated",
          book_id: "book-2",
          reader_id: "reader-2",
          stripe_checkout_session_id: "cs_test_unrelated",
          stripe_payment_intent_id: OTHER_PAYMENT_INTENT_ID,
          amount_cents: 700,
          bundle_id: null,
          refunded_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      bundle_checkout_snapshots: [
        {
          id: "snapshot-1",
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          refunded_at: null,
        },
      ],
      refund_requests:
        overrides.refund_requests ??
        [
          {
            id: REQUEST_ID,
            reader_id: READER_ID,
            stripe_payment_intent_id: PAYMENT_INTENT_ID,
            bundle_checkout_snapshot_id: null,
            amount_cents: 500,
            reason: "wrong edition",
            status: "requested",
            requested_at: "2026-01-01T00:00:00.000Z",
            reviewed_at: null,
            reviewed_by: null,
            admin_notes: null,
            refunded_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
    };
  }

  function fakeFailWebhookForRefund(): NextResponse {
    return { status: 500 } as unknown as NextResponse;
  }

  it("A: an approved request becomes refunded, preserving reviewed_at/reviewed_by/admin_notes", async () => {
    const tables = refundTables({
      refund_requests: [
        {
          id: REQUEST_ID,
          reader_id: READER_ID,
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          bundle_checkout_snapshot_id: null,
          amount_cents: 500,
          reason: "wrong edition",
          status: "approved",
          requested_at: "2026-01-01T00:00:00.000Z",
          reviewed_at: "2026-01-02T00:00:00.000Z",
          reviewed_by: ADMIN_ID,
          admin_notes: "looks legitimate",
          refunded_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    const result = await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();

    const request = tables.refund_requests[0];
    expect(request.status).toBe("refunded");
    expect(request.refunded_at).not.toBeNull();
    expect(request.reviewed_at).toBe("2026-01-02T00:00:00.000Z");
    expect(request.reviewed_by).toBe(ADMIN_ID);
    expect(request.admin_notes).toBe("looks legitimate");
  });

  it("B: a still-requested request becomes refunded via a direct Stripe refund, leaving reviewed_at/reviewed_by null", async () => {
    const tables = refundTables(); // default fixture: status "requested"
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    const request = tables.refund_requests[0];
    expect(request.status).toBe("refunded");
    expect(request.refunded_at).not.toBeNull();
    expect(request.reviewed_at).toBeNull();
    expect(request.reviewed_by).toBeNull();
  });

  it("C: no matching refund_requests row is a successful no-op; purchases refund still occurs", async () => {
    const tables = refundTables({ refund_requests: [] });
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    const result = await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.refund_requests).toHaveLength(0);

    const purchase = tables.purchases.find((r) => r.id === "purchase-1");
    expect(purchase?.refunded_at).not.toBeNull();
  });

  it("D: a duplicate webhook delivery does not rewrite an already-refunded request's refunded_at", async () => {
    const tables = refundTables();
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);
    const event = { id: "evt_1" } as Stripe.Event;

    await processChargeRefund(supabase as never, event, PAYMENT_INTENT_ID, true, failWebhook);
    const firstRefundedAt = tables.refund_requests[0].refunded_at;
    expect(firstRefundedAt).not.toBeNull();

    const secondResult = await processChargeRefund(
      supabase as never,
      event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(secondResult).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.refund_requests[0].refunded_at).toBe(firstRefundedAt);
    expect(tables.refund_requests[0].status).toBe("refunded");
  });

  it("E: a cancelled request is never moved to refunded", async () => {
    const tables = refundTables({
      refund_requests: [
        {
          id: REQUEST_ID,
          reader_id: READER_ID,
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          bundle_checkout_snapshot_id: null,
          amount_cents: 500,
          reason: null,
          status: "cancelled",
          requested_at: "2026-01-01T00:00:00.000Z",
          reviewed_at: null,
          reviewed_by: null,
          admin_notes: null,
          refunded_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.refund_requests[0].status).toBe("cancelled");
    expect(tables.refund_requests[0].refunded_at).toBeNull();
  });

  it("F: a rejected request is never moved to refunded", async () => {
    const tables = refundTables({
      refund_requests: [
        {
          id: REQUEST_ID,
          reader_id: READER_ID,
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          bundle_checkout_snapshot_id: null,
          amount_cents: 500,
          reason: null,
          status: "rejected",
          requested_at: "2026-01-01T00:00:00.000Z",
          reviewed_at: "2026-01-02T00:00:00.000Z",
          reviewed_by: ADMIN_ID,
          admin_notes: "not eligible",
          refunded_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    const request = tables.refund_requests[0];
    expect(request.status).toBe("rejected");
    expect(request.refunded_at).toBeNull();
    expect(request.admin_notes).toBe("not eligible");
  });

  it("G: a real database error updating refund_requests fails the webhook delivery for retry", async () => {
    const tables = refundTables();
    const supabase = makeFakeSupabase(tables, {
      refund_requests: { message: "connection reset by peer", code: "08006" },
    });
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    const result = await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(result).not.toBeNull();
    expect(failWebhook).toHaveBeenCalledTimes(1);
    // The entitlement write (purchases) already completed before this
    // failure -- confirms the ordering/retry-safety this phase relies
    // on: a retry only needs to redo the step that actually failed.
    const purchase = tables.purchases.find((r) => r.id === "purchase-1");
    expect(purchase?.refunded_at).not.toBeNull();
    // The refund_requests row itself must be untouched by the failed
    // update, not left in some partially-written state.
    expect(tables.refund_requests[0].status).toBe("requested");
  });

  it("H: an unrelated purchase under a different payment intent is never refunded", async () => {
    const tables = refundTables();
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    const unrelated = tables.purchases.find((r) => r.id === "purchase-unrelated");
    expect(unrelated?.refunded_at).toBeNull();
  });

  // -------------------------------------------------------------------
  // Full-vs-partial refund guard. charge.refunded fires for partial
  // refunds too (verified against the installed stripe@22.5.0 SDK's own
  // Charge type: amount_refunded "can be less than the amount attribute
  // ... if a partial refund was issued"; refunded "Whether the charge
  // has been fully refunded. If the charge is only partially refunded,
  // this attribute will still be false.") -- isFullyRefunded is exactly
  // that `refunded` boolean, passed straight through from POST()'s own
  // `charge.refunded` field access, never derived from an amount here.
  // -------------------------------------------------------------------

  it("partial refund: isFullyRefunded=false leaves all three tables untouched and still succeeds", async () => {
    const tables = refundTables();
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    const result = await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      false,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.purchases.find((r) => r.id === "purchase-1")?.refunded_at).toBeNull();
    expect(tables.bundle_checkout_snapshots[0].refunded_at).toBeNull();
    expect(tables.refund_requests[0].status).toBe("requested");
    expect(tables.refund_requests[0].refunded_at).toBeNull();
  });

  it("full refund: isFullyRefunded=true runs the normal three-table processing", async () => {
    const tables = refundTables();
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    const result = await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.purchases.find((r) => r.id === "purchase-1")?.refunded_at).not.toBeNull();
    expect(tables.bundle_checkout_snapshots[0].refunded_at).not.toBeNull();
    expect(tables.refund_requests[0].status).toBe("refunded");
  });

  it("cumulative refund: an early partial delivery no-ops, and a later delivery reporting fully-refunded performs the transition", async () => {
    const tables = refundTables();
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    // Delivery 1: charge partially refunded so far (e.g. Stripe's
    // cumulative amount_refunded is still less than amount).
    const firstResult = await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      false,
      failWebhook,
    );
    expect(firstResult).toBeNull();
    expect(tables.purchases.find((r) => r.id === "purchase-1")?.refunded_at).toBeNull();
    expect(tables.refund_requests[0].status).toBe("requested");

    // Delivery 2: a later refund brings the cumulative amount_refunded
    // up to the full charge amount -- Stripe now reports this charge as
    // fully refunded.
    const secondResult = await processChargeRefund(
      supabase as never,
      { id: "evt_2" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(secondResult).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.purchases.find((r) => r.id === "purchase-1")?.refunded_at).not.toBeNull();
    expect(tables.bundle_checkout_snapshots[0].refunded_at).not.toBeNull();
    expect(tables.refund_requests[0].status).toBe("refunded");
  });

  it("duplicate full-refund delivery after the cumulative transition remains idempotent", async () => {
    const tables = refundTables();
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);
    const event = { id: "evt_full" } as Stripe.Event;

    await processChargeRefund(supabase as never, event, PAYMENT_INTENT_ID, true, failWebhook);
    const refundedAtAfterFirst = tables.refund_requests[0].refunded_at;
    expect(refundedAtAfterFirst).not.toBeNull();

    const secondResult = await processChargeRefund(
      supabase as never,
      event,
      PAYMENT_INTENT_ID,
      true,
      failWebhook,
    );

    expect(secondResult).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.refund_requests[0].refunded_at).toBe(refundedAtAfterFirst);
    expect(tables.refund_requests[0].status).toBe("refunded");
  });

  it("a partial refund is never promoted to full processing merely because its amount_refunded is nonzero", async () => {
    // processChargeRefund never sees a raw amount at all -- it only
    // ever receives the pre-computed isFullyRefunded boolean (POST()'s
    // own `charge.refunded` field access), so there is no code path
    // here that could mistake "some amount was refunded" (nonzero) for
    // "the full amount was refunded". This asserts that contract
    // directly: passing false processes nothing, regardless of how
    // large a hypothetical partial refund might have been.
    const tables = refundTables();
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhookForRefund);

    await processChargeRefund(
      supabase as never,
      { id: "evt_1" } as Stripe.Event,
      PAYMENT_INTENT_ID,
      false,
      failWebhook,
    );

    expect(tables.purchases.find((r) => r.id === "purchase-1")?.refunded_at).toBeNull();
    expect(tables.bundle_checkout_snapshots[0].refunded_at).toBeNull();
    expect(tables.refund_requests[0].status).toBe("requested");
    expect(failWebhook).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------
// REFUND-1B Step 5, second correction: the terminal-success invariant.
// "Librum finalizes only after a terminal successful Stripe Refund" must
// hold for EVERY trigger path -- refund.updated/refund.created
// (processRefundLifecycleEvent) AND charge.refunded
// (processChargeRefundedEvent) -- not just the newer one. Both functions
// now go through the exact same isChargeFullyRefundedBySucceededRefunds
// check (not exported/tested directly; its behavior is exhaustively
// exercised through both callers below) before ever calling the
// unchanged processChargeRefund.
//
// A single fake Stripe client covers both: `charges.retrieve` (only
// processRefundLifecycleEvent calls this, to look up the charge behind a
// refund it was handed) and `refunds.list` (both call this, to get
// Stripe's live, authoritative view of every refund on a charge -- shaped
// as an object with `.autoPagingToArray`, mirroring the real SDK's
// ApiListPromise so the production code under test needs no special-
// casing for the fake).
// ---------------------------------------------------------------------
describe("terminal-success invariant: processRefundLifecycleEvent and processChargeRefundedEvent", () => {
  const PAYMENT_INTENT_ID = "pi_test_lifecycle";
  const CHARGE_ID = "ch_test_lifecycle";
  const REQUEST_ID = "refund-request-lifecycle-1";
  const READER_ID = "reader-1";
  const CHARGE_AMOUNT = 500;

  function lifecycleTables(overrides: { refund_requests?: Row[] } = {}): Tables {
    return {
      purchases: [
        {
          id: "purchase-1",
          book_id: "book-1",
          reader_id: READER_ID,
          stripe_checkout_session_id: "cs_test_1",
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          amount_cents: CHARGE_AMOUNT,
          bundle_id: null,
          refunded_at: null,
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      bundle_checkout_snapshots: [
        {
          id: "snapshot-1",
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          refunded_at: null,
        },
      ],
      refund_requests:
        overrides.refund_requests ??
        [
          {
            id: REQUEST_ID,
            reader_id: READER_ID,
            stripe_payment_intent_id: PAYMENT_INTENT_ID,
            bundle_checkout_snapshot_id: null,
            amount_cents: CHARGE_AMOUNT,
            reason: null,
            status: "approved",
            requested_at: "2026-01-01T00:00:00.000Z",
            reviewed_at: "2026-01-02T00:00:00.000Z",
            reviewed_by: "admin-1",
            admin_notes: null,
            refunded_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
    };
  }

  function makeFakeCharge(overrides: Partial<Stripe.Charge> = {}): Stripe.Charge {
    return {
      id: CHARGE_ID,
      object: "charge",
      amount: CHARGE_AMOUNT,
      payment_intent: PAYMENT_INTENT_ID,
      ...overrides,
    } as Stripe.Charge;
  }

  function makeRefund(overrides: Partial<Stripe.Refund>): Stripe.Refund {
    return {
      id: "re_test_1",
      object: "refund",
      status: "succeeded",
      amount: CHARGE_AMOUNT,
      charge: CHARGE_ID,
      payment_intent: PAYMENT_INTENT_ID,
      ...overrides,
    } as Stripe.Refund;
  }

  // params.charge is what charges.retrieve() resolves with (only used by
  // processRefundLifecycleEvent). params.refunds is Stripe's live,
  // authoritative refund list for the charge -- the single source of
  // truth both functions ultimately gate finalization on.
  function makeFakeStripeClient(params: {
    charge?: Partial<Stripe.Charge> | null;
    chargeError?: Error;
    refunds?: Partial<Stripe.Refund>[];
    refundsListError?: Error;
  }) {
    const chargesRetrieve = vi.fn(() => {
      if (params.chargeError) return Promise.reject(params.chargeError);
      return Promise.resolve(params.charge as Stripe.Charge);
    });
    const refundsList = vi.fn(() => ({
      autoPagingToArray: () => {
        if (params.refundsListError) return Promise.reject(params.refundsListError);
        return Promise.resolve((params.refunds ?? []) as Stripe.Refund[]);
      },
    }));
    return {
      charges: { retrieve: chargesRetrieve },
      refunds: { list: refundsList },
    };
  }

  function fakeFailWebhookForLifecycle(): NextResponse {
    return { status: 500 } as unknown as NextResponse;
  }

  // ---------------------------------------------------------------
  // processRefundLifecycleEvent (refund.updated / refund.created)
  // ---------------------------------------------------------------
  describe("processRefundLifecycleEvent", () => {
    it("full + succeeded: finalizes when the live refund list confirms a succeeded refund covers the full amount", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        charge: makeFakeCharge(),
        refunds: [makeRefund({ status: "succeeded", amount: CHARGE_AMOUNT })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processRefundLifecycleEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeRefund({ status: "succeeded" }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.purchases[0].refunded_at).not.toBeNull();
      expect(tables.bundle_checkout_snapshots[0].refunded_at).not.toBeNull();
      expect(tables.refund_requests[0].status).toBe("refunded");
    });

    it("full + pending: never even lists refunds -- the Refund itself hasn't reached succeeded", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({ charge: makeFakeCharge(), refunds: [] });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processRefundLifecycleEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeRefund({ status: "pending" }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(stripeClient.charges.retrieve).not.toHaveBeenCalled();
      expect(stripeClient.refunds.list).not.toHaveBeenCalled();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.purchases[0].refunded_at).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");
    });

    it("full + requires_action: no finalization, no Stripe lookups", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({ charge: makeFakeCharge(), refunds: [] });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processRefundLifecycleEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeRefund({ status: "requires_action" }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(stripeClient.refunds.list).not.toHaveBeenCalled();
      expect(tables.purchases[0].refunded_at).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");
    });

    it("full + failed: no finalization -- a failed attempt never revokes entitlement", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({ charge: makeFakeCharge(), refunds: [] });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processRefundLifecycleEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeRefund({ status: "failed" }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(stripeClient.refunds.list).not.toHaveBeenCalled();
      expect(tables.purchases[0].refunded_at).toBeNull();
      expect(tables.bundle_checkout_snapshots[0].refunded_at).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");
    });

    it("partial succeeded: this refund succeeded, but the live refund list doesn't yet cover the full charge amount", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        charge: makeFakeCharge(),
        // Only 200 of 500 has actually succeeded.
        refunds: [makeRefund({ status: "succeeded", amount: 200 })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processRefundLifecycleEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeRefund({ status: "succeeded", amount: 200 }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(stripeClient.refunds.list).toHaveBeenCalledTimes(1);
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.purchases[0].refunded_at).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");
    });

    it("cumulative: multiple partial refunds whose SUCCEEDED total reaches the full amount finalize on the delivery that completes it", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      // Delivery 1: a first partial refund succeeded (200 of 500).
      const stripeClientPartial = makeFakeStripeClient({
        charge: makeFakeCharge(),
        refunds: [makeRefund({ id: "re_partial_1", status: "succeeded", amount: 200 })],
      });
      const firstResult = await processRefundLifecycleEvent(
        supabase as never,
        stripeClientPartial as never,
        { id: "evt_1" } as Stripe.Event,
        makeRefund({ id: "re_partial_1", status: "succeeded", amount: 200 }),
        failWebhook,
      );
      expect(firstResult).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");

      // Delivery 2: a second refund succeeds, and Stripe's live refund
      // list for the charge now shows BOTH succeeded refunds, summing to
      // the full amount.
      const stripeClientFull = makeFakeStripeClient({
        charge: makeFakeCharge(),
        refunds: [
          makeRefund({ id: "re_partial_1", status: "succeeded", amount: 200 }),
          makeRefund({ id: "re_partial_2", status: "succeeded", amount: 300 }),
        ],
      });
      const secondResult = await processRefundLifecycleEvent(
        supabase as never,
        stripeClientFull as never,
        { id: "evt_2" } as Stripe.Event,
        makeRefund({ id: "re_partial_2", status: "succeeded", amount: 300 }),
        failWebhook,
      );

      expect(secondResult).toBeNull();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.purchases[0].refunded_at).not.toBeNull();
      expect(tables.refund_requests[0].status).toBe("refunded");
    });

    it("duplicate refund.updated deliveries for an already-finalized transaction are idempotent", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        charge: makeFakeCharge(),
        refunds: [makeRefund({ status: "succeeded", amount: CHARGE_AMOUNT })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);
      const refund = makeRefund({ status: "succeeded" });

      await processRefundLifecycleEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        refund,
        failWebhook,
      );
      const refundedAtAfterFirst = tables.refund_requests[0].refunded_at;
      expect(refundedAtAfterFirst).not.toBeNull();

      const secondResult = await processRefundLifecycleEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_2" } as Stripe.Event,
        refund,
        failWebhook,
      );

      expect(secondResult).toBeNull();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.refund_requests[0].refunded_at).toBe(refundedAtAfterFirst);
      expect(tables.refund_requests[0].status).toBe("refunded");
    });

    it("a Stripe error listing refunds fails the webhook delivery for retry, without finalizing", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        charge: makeFakeCharge(),
        refundsListError: new Error("connection reset"),
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processRefundLifecycleEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeRefund({ status: "succeeded" }),
        failWebhook,
      );

      expect(result).not.toBeNull();
      expect(failWebhook).toHaveBeenCalledTimes(1);
      expect(tables.refund_requests[0].status).toBe("approved");
    });
  });

  // ---------------------------------------------------------------
  // processChargeRefundedEvent (charge.refunded) -- the exact function
  // Blocker 1 required be brought under the same invariant.
  // ---------------------------------------------------------------
  describe("processChargeRefundedEvent", () => {
    it("charge.refunded(full=true) while the associated Refund is still 'pending' MUST NOT finalize", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      // Stripe's live refund list shows the sole refund still pending --
      // charge.refunded firing with a cumulative-amount boolean of true
      // must not be trusted on its own.
      const stripeClient = makeFakeStripeClient({
        refunds: [makeRefund({ status: "pending", amount: CHARGE_AMOUNT })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ refunded: true }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.purchases[0].refunded_at).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");
    });

    it("charge.refunded(full=true) while the associated Refund is 'requires_action' MUST NOT finalize", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        refunds: [makeRefund({ status: "requires_action", amount: CHARGE_AMOUNT })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ refunded: true }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(tables.purchases[0].refunded_at).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");
    });

    it("charge.refunded(full=true) whose associated Refund is 'failed' MUST NOT finalize", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        refunds: [makeRefund({ status: "failed", amount: CHARGE_AMOUNT })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ refunded: true }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(tables.purchases[0].refunded_at).toBeNull();
      expect(tables.bundle_checkout_snapshots[0].refunded_at).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");
    });

    it("charge.refunded whose live refund list confirms a succeeded refund covering the full amount finalizes", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        refunds: [makeRefund({ status: "succeeded", amount: CHARGE_AMOUNT })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ refunded: true }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.purchases[0].refunded_at).not.toBeNull();
      expect(tables.refund_requests[0].status).toBe("refunded");
    });

    it("partial successful refund via charge.refunded: no finalization", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        refunds: [makeRefund({ status: "succeeded", amount: 200 })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ refunded: false }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(tables.purchases[0].refunded_at).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");
    });

    it("manual Stripe Dashboard full successful refund: finalizes via the exact same path, no admin action involved", async () => {
      const tables = lifecycleTables({
        refund_requests: [
          {
            id: REQUEST_ID,
            reader_id: READER_ID,
            stripe_payment_intent_id: PAYMENT_INTENT_ID,
            bundle_checkout_snapshot_id: null,
            amount_cents: CHARGE_AMOUNT,
            reason: null,
            status: "requested",
            requested_at: "2026-01-01T00:00:00.000Z",
            reviewed_at: null,
            reviewed_by: null,
            admin_notes: null,
            refunded_at: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        refunds: [makeRefund({ status: "succeeded", amount: CHARGE_AMOUNT })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ refunded: true }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(tables.purchases[0].refunded_at).not.toBeNull();
      expect(tables.refund_requests[0].status).toBe("refunded");
    });

    it("no resolvable payment intent on the charge: safely no-ops, no Stripe lookup attempted", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({ refunds: [] });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ payment_intent: null }),
        failWebhook,
      );

      expect(result).toBeNull();
      expect(stripeClient.refunds.list).not.toHaveBeenCalled();
    });

    it("a Stripe error listing refunds fails the webhook delivery for retry, without finalizing", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        refundsListError: new Error("connection reset"),
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const result = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ refunded: true }),
        failWebhook,
      );

      expect(result).not.toBeNull();
      expect(failWebhook).toHaveBeenCalledTimes(1);
      expect(tables.refund_requests[0].status).toBe("approved");
    });
  });

  // ---------------------------------------------------------------
  // Cross-path: event ordering between charge.refunded and
  // refund.created/refund.updated must not matter -- both converge on
  // the same live Stripe read and the same idempotent finalizer.
  // ---------------------------------------------------------------
  describe("event ordering across charge.refunded and refund.* is immaterial", () => {
    it("charge.refunded arriving BEFORE refund.created: first delivery no-ops (refund not yet succeeded), second finalizes once it does", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      // charge.refunded arrives while the refund is still pending at
      // Stripe's side -- live refund list confirms nothing succeeded yet.
      const stripeClientPending = makeFakeStripeClient({
        refunds: [makeRefund({ status: "pending", amount: CHARGE_AMOUNT })],
      });
      const chargeResult = await processChargeRefundedEvent(
        supabase as never,
        stripeClientPending as never,
        { id: "evt_1" } as Stripe.Event,
        makeFakeCharge({ refunded: true }),
        failWebhook,
      );
      expect(chargeResult).toBeNull();
      expect(tables.refund_requests[0].status).toBe("approved");

      // refund.created/updated arrives once the SAME refund has actually
      // settled -- live refund list now confirms it succeeded.
      const stripeClientSucceeded = makeFakeStripeClient({
        charge: makeFakeCharge(),
        refunds: [makeRefund({ status: "succeeded", amount: CHARGE_AMOUNT })],
      });
      const refundResult = await processRefundLifecycleEvent(
        supabase as never,
        stripeClientSucceeded as never,
        { id: "evt_2" } as Stripe.Event,
        makeRefund({ status: "succeeded" }),
        failWebhook,
      );

      expect(refundResult).toBeNull();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.refund_requests[0].status).toBe("refunded");
    });

    it("refund.created arriving BEFORE charge.refunded: first delivery finalizes, second (charge.refunded) is a harmless idempotent duplicate", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);

      const stripeClientSucceeded = makeFakeStripeClient({
        charge: makeFakeCharge(),
        refunds: [makeRefund({ status: "succeeded", amount: CHARGE_AMOUNT })],
      });
      const refundResult = await processRefundLifecycleEvent(
        supabase as never,
        stripeClientSucceeded as never,
        { id: "evt_1" } as Stripe.Event,
        makeRefund({ status: "succeeded" }),
        failWebhook,
      );
      expect(refundResult).toBeNull();
      const refundedAtAfterFirst = tables.refund_requests[0].refunded_at;
      expect(refundedAtAfterFirst).not.toBeNull();

      // charge.refunded for the same, already-settled transaction
      // arrives second (Stripe does not guarantee ordering) -- must not
      // create a second finalization or overwrite refunded_at.
      const chargeResult = await processChargeRefundedEvent(
        supabase as never,
        stripeClientSucceeded as never,
        { id: "evt_2" } as Stripe.Event,
        makeFakeCharge({ refunded: true }),
        failWebhook,
      );

      expect(chargeResult).toBeNull();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.refund_requests[0].refunded_at).toBe(refundedAtAfterFirst);
      expect(tables.refund_requests[0].status).toBe("refunded");
    });

    it("duplicate charge.refunded deliveries after finalization remain idempotent", async () => {
      const tables = lifecycleTables();
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeStripeClient({
        refunds: [makeRefund({ status: "succeeded", amount: CHARGE_AMOUNT })],
      });
      const failWebhook = vi.fn(fakeFailWebhookForLifecycle);
      const charge = makeFakeCharge({ refunded: true });

      await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_1" } as Stripe.Event,
        charge,
        failWebhook,
      );
      const refundedAtAfterFirst = tables.refund_requests[0].refunded_at;
      expect(refundedAtAfterFirst).not.toBeNull();

      const secondResult = await processChargeRefundedEvent(
        supabase as never,
        stripeClient as never,
        { id: "evt_2" } as Stripe.Event,
        charge,
        failWebhook,
      );

      expect(secondResult).toBeNull();
      expect(failWebhook).not.toHaveBeenCalled();
      expect(tables.refund_requests[0].refunded_at).toBe(refundedAtAfterFirst);
      expect(tables.refund_requests[0].status).toBe("refunded");
    });
  });
});

// ---------------------------------------------------------------------
// LAUNCH-1 P1-7A: processDisputeEvent -- the sole write path for
// public.payment_disputes. All five charge.dispute.* event types route
// through this one function (see route.ts's own documentation for why
// one handler correctly covers all five); these tests exercise it
// directly with a fake Stripe disputes.retrieve client and the same
// in-memory Supabase fake used throughout this file.
// ---------------------------------------------------------------------
describe("processDisputeEvent", () => {
  const DISPUTE_ID = "dp_test_lifecycle";
  const PAYMENT_INTENT_ID = "pi_test_dispute";

  function makeFakeDispute(overrides: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
    return {
      id: DISPUTE_ID,
      object: "dispute",
      status: "needs_response",
      reason: "fraudulent",
      amount: 500,
      payment_intent: PAYMENT_INTENT_ID,
      charge: "ch_test_dispute",
      ...overrides,
    } as Stripe.Dispute;
  }

  function makeFakeDisputeClient(params: { dispute?: Stripe.Dispute; retrieveError?: Error }) {
    const retrieve = vi.fn(() => {
      if (params.retrieveError) return Promise.reject(params.retrieveError);
      return Promise.resolve(params.dispute as Stripe.Dispute);
    });
    return { disputes: { retrieve } };
  }

  function fakeFailWebhookForDispute(): NextResponse {
    return { status: 500 } as unknown as NextResponse;
  }

  it("created: upserts a new payment_disputes row with the live-retrieved status", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({ dispute: makeFakeDispute({ status: "needs_response" }) });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    const result = await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_1" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(stripeClient.disputes.retrieve).toHaveBeenCalledWith(DISPUTE_ID);
    expect(tables.payment_disputes).toHaveLength(1);
    expect(tables.payment_disputes[0]).toMatchObject({
      stripe_dispute_id: DISPUTE_ID,
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
      status: "needs_response",
      reason: "fraudulent",
      amount_cents: 500,
    });
  });

  it("won: the live-retrieved status is stored verbatim, never treated as an error", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({ dispute: makeFakeDispute({ status: "won" }) });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_won" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].status).toBe("won");
  });

  it("lost: stored verbatim -- this is the value user_owns_book()/the fulfillment guards gate on", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({ dispute: makeFakeDispute({ status: "lost" }) });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_lost" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].status).toBe("lost");
  });

  it("warning track (warning_needs_response): stored like any other recognized status, no special casing", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({
      dispute: makeFakeDispute({ status: "warning_needs_response" }),
    });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_warning" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].status).toBe("warning_needs_response");
    // Recognized status -- no "unrecognized status" warning logged.
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("unrecognized status"),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it("'prevented': stored and treated like any other recognized status, never given invented terminal meaning", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({ dispute: makeFakeDispute({ status: "prevented" }) });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_prevented" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].status).toBe("prevented");
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("unrecognized status"),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it("unknown/future status: stored verbatim, never rejected, logged prominently for investigation", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({
      dispute: makeFakeDispute({ status: "some_future_stripe_status" as Stripe.Dispute.Status }),
    });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_unknown" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].status).toBe("some_future_stripe_status");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("unrecognized status"),
      expect.objectContaining({ status: "some_future_stripe_status" }),
    );
    errorSpy.mockRestore();
  });

  it("duplicate delivery (same dispute.id, same event replayed): upsert is a clean no-op, no duplicate row", async () => {
    const tables: Tables = {
      payment_disputes: [
        {
          id: "existing-row",
          stripe_dispute_id: DISPUTE_ID,
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          status: "needs_response",
          reason: "fraudulent",
          amount_cents: 500,
        },
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({ dispute: makeFakeDispute({ status: "needs_response" }) });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_dup" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes).toHaveLength(1);
  });

  it("out-of-order delivery: a stale event for an earlier state still re-fetches and writes Stripe's CURRENT live status", async () => {
    // Simulates: .closed (status now 'won') already processed and
    // committed, then a stale, late-arriving .updated delivery for the
    // dispute's earlier 'under_review' state is processed next. Because
    // this function always re-fetches LIVE state rather than trusting
    // the event payload, it re-reads 'won' regardless of which event
    // triggered this call -- it can never regress the more-recent write.
    const tables: Tables = {
      payment_disputes: [
        {
          id: "existing-row",
          stripe_dispute_id: DISPUTE_ID,
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          status: "won",
          reason: "fraudulent",
          amount_cents: 500,
        },
      ],
    };
    const supabase = makeFakeSupabase(tables);
    // The live Stripe state is 'won' -- this function has no way to see
    // the stale event's own (irrelevant) payload; it always retrieves
    // live state, which is exactly what's being verified here.
    const stripeClient = makeFakeDisputeClient({ dispute: makeFakeDispute({ status: "won" }) });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_stale_updated" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].status).toBe("won");
  });

  it("funds_withdrawn / funds_reinstated events: same handler, same live re-sync, no special casing", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({ dispute: makeFakeDispute({ status: "lost" }) });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_funds_withdrawn" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].status).toBe("lost");
  });

  it("no resolvable payment intent: logged and skipped, not failed (retrying can never help)", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({
      dispute: makeFakeDispute({ payment_intent: null }),
    });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_no_pi" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("Stripe retrieve failure: fails the webhook (forces a retry), writes nothing", async () => {
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({ retrieveError: new Error("network error") });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    const result = await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_retrieve_fail" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(result).not.toBeNull();
    expect(failWebhook).toHaveBeenCalledOnce();
    expect(tables.payment_disputes).toHaveLength(0);
  });

  it("Supabase upsert failure: fails the webhook", async () => {
    const supabase = makeFakeSupabase({ payment_disputes: [] }, { payment_disputes: { message: "db down" } });
    const stripeClient = makeFakeDisputeClient({ dispute: makeFakeDispute() });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    const result = await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_dispute_db_fail" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(result).not.toBeNull();
    expect(failWebhook).toHaveBeenCalledOnce();
  });

  it("single-book payment intent: no bundle-path code exercised, dispute recorded the same way", async () => {
    // processDisputeEvent has no book/bundle-specific branching at all --
    // it writes exactly one payment_disputes row keyed by payment
    // intent, regardless of what kind of purchase that intent paid for.
    // This test exists to make that property explicit, not because the
    // function's behavior differs from the "created" test above.
    const tables: Tables = { payment_disputes: [] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeDisputeClient({
      dispute: makeFakeDispute({ payment_intent: "pi_single_book_only" }),
    });
    const failWebhook = vi.fn(fakeFailWebhookForDispute);

    await processDisputeEvent(
      supabase as never,
      stripeClient as never,
      { id: "evt_single_book" } as Stripe.Event,
      DISPUTE_ID,
      failWebhook,
    );

    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].stripe_payment_intent_id).toBe("pi_single_book_only");
  });
});
