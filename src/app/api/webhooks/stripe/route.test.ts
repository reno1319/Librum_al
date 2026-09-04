import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type Stripe from "stripe";
import RealStripe from "stripe";
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
  reverseAuthorTransferForLostDispute,
  buildTransferReversalIdempotencyKey,
  processAccountUpdatedEvent,
  constructStripeEventFromApprovedSecrets,
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

// LAUNCH-1 P1-8: table-level column defaults, applied ONLY to a
// genuinely NEW row on upsert (never to an update of an existing row)
// -- mirrors real Postgres INSERT semantics (a column omitted from the
// INSERT's column list gets its table default) for the columns this
// test double has no schema awareness of otherwise. Needed because
// processDisputeEvent's own upsert payload deliberately never sets
// transfer_reversal_* (that would clobber existing reversal state on
// every routine dispute-status refresh -- see route.ts's own
// documentation) -- migration 036's real DEFAULTs are what supply
// 'not_attempted'/0/null for a brand-new payment_disputes row in
// production; this is the fake's equivalent.
const TABLE_DEFAULTS: Record<string, Row> = {
  payment_disputes: {
    transfer_reversal_status: "not_attempted",
    transfer_reversal_attempt_count: 0,
    stripe_transfer_id: null,
    stripe_transfer_reversal_id: null,
    transfer_reversal_amount_cents: null,
    transfer_reversal_attempted_at: null,
    transfer_reversal_succeeded_at: null,
    transfer_reversal_failure_code: null,
    transfer_reversal_failure_message: null,
  },
};

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; val: unknown; op: "eq" | "in" | "lt" }[] = [];
  private op: "select" | "update" | "upsert" | "delete" = "select";
  private payload: Row | undefined;
  private upsertOnConflict: string | undefined;
  private wantReturnRows = false;
  private orderSpec: { col: string; ascending: boolean } | undefined;
  private limitCount: number | undefined;

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

  // LAUNCH-1 P1-8: used only by the reconciliation route's stale-
  // 'attempting' candidate scan (transfer_reversal_attempted_at <
  // cutoff). String/ISO-timestamp comparison, matching how the real
  // column is actually compared (timestamptz vs. an ISO string).
  lt(col: string, val: unknown) {
    this.filters.push({ col, val, op: "lt" });
    return this;
  }

  // LAUNCH-1 P1-8: no-op beyond recording the spec -- applied at
  // execute() time, after filtering, for the reconciliation route's
  // oldest-first candidate ordering.
  order(col: string, options?: { ascending?: boolean }) {
    this.orderSpec = { col, ascending: options?.ascending ?? true };
    return this;
  }

  limit(count: number) {
    this.limitCount = count;
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
    return this.filters.every((f) => {
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      if (f.op === "lt") {
        const rowVal = row[f.col];
        if (rowVal === null || rowVal === undefined) return false;
        return String(rowVal) < String(f.val);
      }
      return row[f.col] === f.val;
    });
  }

  private execute(): { data: unknown; error: unknown } {
    const rows = this.rows();

    if (this.op === "select") {
      let result = rows.filter((r) => this.matches(r));
      if (this.orderSpec) {
        const { col, ascending } = this.orderSpec;
        result = [...result].sort((a, b) => {
          const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
          return ascending ? cmp : -cmp;
        });
      }
      if (this.limitCount !== undefined) {
        result = result.slice(0, this.limitCount);
      }
      return { data: result, error: null };
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
      rows.push({ ...(TABLE_DEFAULTS[this.table] ?? {}), ...this.payload });
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
// LAUNCH-1 P2-4: fulfillLegacyBundle email idempotency. This path is
// unreachable for new purchases (buyBundle's checkout creation always
// sets metadata.snapshot_id, which fulfillLegacyBundle's own caller
// checks first -- see the P2-4 audit) -- these tests exercise it purely
// as the historical-redelivery handler it now is. Unlike
// fulfillBundleSnapshot, this legacy shape has no durable per-checkout
// fulfillment claim (no fulfilled_at-equivalent row) to gate the email
// on, so the fix reuses eligibleItems -- the same classification this
// function already computes for its own allocation -- as the signal:
// email only when this delivery actually wrote at least one newly-
// eligible legacy purchase.
// ---------------------------------------------------------------------
describe("fulfillLegacyBundle: email idempotency (LAUNCH-1 P2-4)", () => {
  let tables: Tables;

  beforeEach(async () => {
    tables = freshLegacyTables();
    vi.mocked((await import("@/lib/email")).sendBundlePurchaseEmails).mockClear();
  });

  it("first legacy fulfillment (fresh bundle/reader, no prior purchase history): sends the bundle emails exactly once, with the correct bundleId/readerId/amountCents", async () => {
    tables.purchases = []; // no prior history at all -- both books eligible
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_p24_first" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const sendBundlePurchaseEmails = vi.mocked((await import("@/lib/email")).sendBundlePurchaseEmails);
    expect(sendBundlePurchaseEmails).toHaveBeenCalledTimes(1);
    expect(sendBundlePurchaseEmails).toHaveBeenCalledWith(
      supabase,
      { bundleId: BUNDLE_ID_LEGACY, readerId: READER_ID_LEGACY, amountCents: 599 },
    );
  });

  it("exact sequential redelivery: the second delivery sends zero additional emails and writes zero additional/duplicate purchases -- total email count stays exactly 1, allocated amounts stay unchanged", async () => {
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);
    const event = { id: "evt_p24_redelivery" } as Stripe.Event;
    const session = { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session;
    const sendBundlePurchaseEmails = vi.mocked((await import("@/lib/email")).sendBundlePurchaseEmails);

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
    expect(first).toBeNull();
    expect(sendBundlePurchaseEmails).toHaveBeenCalledTimes(1);

    const purchasesAfterFirst = tables.purchases.map((row) => ({ ...row }));

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

    expect(second).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    // No additional email on the redelivery -- total remains exactly 1.
    expect(sendBundlePurchaseEmails).toHaveBeenCalledTimes(1);
    // Purchase idempotency: no new/duplicate rows, no changed amounts.
    expect(tables.purchases).toHaveLength(purchasesAfterFirst.length);
    expect(tables.purchases).toEqual(purchasesAfterFirst);
  });

  it("mixed same-session + eligible (a book already committed by an earlier partial delivery of THIS session, another still eligible): exactly one email attempt when fulfillment completes, purchases reconcile to the full charged amount", async () => {
    // Simulates recovering from an earlier delivery that partially wrote
    // book A (this exact session) before failing on book B -- book A's
    // amount is FIXED/authoritative (same_session), only the remaining
    // 299 is allocated to book B.
    tables.purchases = [
      {
        id: "purchase-legacy-a-same-session",
        book_id: BOOK_A_LEGACY,
        reader_id: READER_ID_LEGACY,
        stripe_checkout_session_id: NEW_SESSION_ID_LEGACY,
        stripe_payment_intent_id: NEW_PAYMENT_INTENT_ID_LEGACY,
        amount_cents: 300,
        bundle_id: BUNDLE_ID_LEGACY,
        refunded_at: null,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_p24_mixed" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const sendBundlePurchaseEmails = vi.mocked((await import("@/lib/email")).sendBundlePurchaseEmails);
    expect(sendBundlePurchaseEmails).toHaveBeenCalledTimes(1);

    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A_LEGACY);
    const bookBRow = tables.purchases.find((r) => r.book_id === BOOK_B_LEGACY);
    expect(bookARow?.amount_cents).toBe(300); // unchanged, fixed same_session amount
    expect(bookBRow?.amount_cents).toBe(299); // remaining 599-300 allocated to the newly-eligible book
    expect(bookBRow?.stripe_checkout_session_id).toBe(NEW_SESSION_ID_LEGACY);
  });

  it("active-other-session + eligible (reader already owns one title via an unrelated purchase, another title newly eligible): email still sends exactly once", async () => {
    // freshLegacyTables() already sets this shape up: book A owned via
    // an unrelated OLD session, book B with no prior purchase at all.
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_p24_active_other" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const sendBundlePurchaseEmails = vi.mocked((await import("@/lib/email")).sendBundlePurchaseEmails);
    expect(sendBundlePurchaseEmails).toHaveBeenCalledTimes(1);

    // Book A (active_other_session) is completely untouched -- still the
    // OLD, unrelated transaction's own values.
    const bookARow = tables.purchases.find((r) => r.book_id === BOOK_A_LEGACY);
    expect(bookARow?.stripe_checkout_session_id).toBe(OLD_SESSION_ID_LEGACY);
    // Book B is freshly granted via this new legacy transaction.
    const bookBRow = tables.purchases.find((r) => r.book_id === BOOK_B_LEGACY);
    expect(bookBRow?.stripe_checkout_session_id).toBe(NEW_SESSION_ID_LEGACY);
  });

  // LAUNCH-1 P2-4, ACCEPTED HISTORICAL TRADE-OFF (approved, not a bug):
  // a historical legacy checkout where the reader already actively
  // owned every book in the bundle through unrelated purchases has
  // eligibleItems.length === 0 even on its first (and only) delivery --
  // no purchases row is ever written under this checkout's own
  // session_id, so nothing in the purchases table can distinguish
  // "first delivery" from "the Nth redelivery" for this shape. Under
  // this fix, no bundle email is sent for it. Approved because: this
  // path is unreachable for new purchases (see the P2-4 audit's
  // reachability proof), no entitlement or financial state is affected
  // either way, and adding a new schema mechanism solely to email a
  // reader about an already-fully-owned historical bundle is not
  // warranted.
  it("all-active-other-session historical edge case: reader already owns every book in the bundle via unrelated purchases -- eligibleItems is empty, no email is sent (accepted trade-off, not a regression)", async () => {
    tables.purchases = [
      {
        id: "purchase-legacy-a-preowned",
        book_id: BOOK_A_LEGACY,
        reader_id: READER_ID_LEGACY,
        stripe_checkout_session_id: OLD_SESSION_ID_LEGACY,
        stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID_LEGACY,
        amount_cents: 300,
        bundle_id: null,
        refunded_at: null,
      },
      {
        id: "purchase-legacy-b-preowned",
        book_id: BOOK_B_LEGACY,
        reader_id: READER_ID_LEGACY,
        stripe_checkout_session_id: OLD_SESSION_ID_LEGACY,
        stripe_payment_intent_id: OLD_PAYMENT_INTENT_ID_LEGACY,
        amount_cents: 299,
        bundle_id: null,
        refunded_at: null,
      },
    ];
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await fulfillLegacyBundle(
      supabase as never,
      { id: "evt_p24_all_preowned" } as Stripe.Event,
      { id: NEW_SESSION_ID_LEGACY } as Stripe.Checkout.Session,
      BUNDLE_ID_LEGACY,
      READER_ID_LEGACY,
      NEW_PAYMENT_INTENT_ID_LEGACY,
      599,
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    const sendBundlePurchaseEmails = vi.mocked((await import("@/lib/email")).sendBundlePurchaseEmails);
    expect(sendBundlePurchaseEmails).not.toHaveBeenCalled();
    // Neither pre-existing row is touched -- no new entitlement, no
    // financial state changed by this accepted trade-off.
    expect(tables.purchases).toHaveLength(2);
    expect(tables.purchases.find((r) => r.book_id === BOOK_A_LEGACY)?.stripe_checkout_session_id).toBe(
      OLD_SESSION_ID_LEGACY,
    );
    expect(tables.purchases.find((r) => r.book_id === BOOK_B_LEGACY)?.stripe_checkout_session_id).toBe(
      OLD_SESSION_ID_LEGACY,
    );
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

  const DEFAULT_CHARGE_ID = "ch_test_dispute";
  const DEFAULT_TRANSFER_ID = "tr_test_dispute";

  // LAUNCH-1 P1-8: extended to also fake charges/transfers -- every
  // "lost" dispute now also drives reverseAuthorTransferForLostDispute
  // (see processDisputeEvent's own new call site), which needs
  // charges.retrieve/transfers.retrieve/transfers.listReversals/
  // transfers.createReversal on top of the pre-existing disputes.
  // retrieve. Defaults describe a clean, fully-resolvable
  // destination-charge transfer with nothing reversed yet and no
  // existing reversal -- realistic enough that every PRE-EXISTING test
  // in this describe block (which only cares about dispute-status
  // recording, not reversal outcome) continues to exercise a coherent,
  // non-erroring path through the new code, not an incidental
  // TypeError swallowed by processDisputeEvent's own try/catch.
  function makeFakeDisputeClient(params: {
    dispute?: Stripe.Dispute;
    retrieveError?: Error;
    charge?: Partial<Stripe.Charge> | "not_found";
    transfer?: Partial<Stripe.Transfer> | "not_found";
    reversals?: Partial<Stripe.TransferReversal>[];
    reversalsListError?: Error;
    createReversalResult?: Partial<Stripe.TransferReversal>;
    createReversalError?: Error;
  }) {
    const retrieve = vi.fn(() => {
      if (params.retrieveError) return Promise.reject(params.retrieveError);
      return Promise.resolve(params.dispute as Stripe.Dispute);
    });

    const chargesRetrieve = vi.fn(() => {
      if (params.charge === "not_found") {
        return Promise.reject(new Error("No such charge"));
      }
      return Promise.resolve({
        id: DEFAULT_CHARGE_ID,
        object: "charge",
        amount: 500,
        transfer: DEFAULT_TRANSFER_ID,
        ...params.charge,
      } as Stripe.Charge);
    });

    const transfersRetrieve = vi.fn(() => {
      if (params.transfer === "not_found") {
        return Promise.reject(new Error("No such transfer"));
      }
      return Promise.resolve({
        id: DEFAULT_TRANSFER_ID,
        object: "transfer",
        amount: 400,
        amount_reversed: 0,
        ...params.transfer,
      } as Stripe.Transfer);
    });

    const reversalsArray = (params.reversals ?? []) as Stripe.TransferReversal[];
    const listReversals = vi.fn(() => ({
      autoPagingToArray: () =>
        params.reversalsListError
          ? Promise.reject(params.reversalsListError)
          : Promise.resolve(reversalsArray),
    }));

    const createReversal = vi.fn(() => {
      if (params.createReversalError) return Promise.reject(params.createReversalError);
      return Promise.resolve({
        id: "trr_test_default",
        object: "transfer_reversal",
        amount: 0,
        currency: "usd",
        metadata: {},
        ...params.createReversalResult,
      } as Stripe.TransferReversal);
    });

    return {
      disputes: { retrieve },
      charges: { retrieve: chargesRetrieve },
      transfers: { retrieve: transfersRetrieve, listReversals, createReversal },
    };
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

// ---------------------------------------------------------------------
// LAUNCH-1 P1-8: reverseAuthorTransferForLostDispute -- the lost-dispute
// author-transfer recovery mechanism. Drives the function directly with
// a fake Supabase client (payment_disputes pre-seeded to a specific
// reversal state per test, mirroring the exact shape migration 036's
// real column defaults produce -- see TABLE_DEFAULTS above) and a fake
// Stripe client exposing charges/transfers alongside disputes.
// ---------------------------------------------------------------------
describe("reverseAuthorTransferForLostDispute", () => {
  const DISPUTE_ID = "dp_test_reversal";
  const PAYMENT_INTENT_ID = "pi_test_reversal";
  const CHARGE_ID = "ch_test_reversal";
  const TRANSFER_ID = "tr_test_reversal";

  function makeFakeDispute(overrides: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
    return {
      id: DISPUTE_ID,
      object: "dispute",
      status: "lost",
      reason: "fraudulent",
      amount: 500,
      payment_intent: PAYMENT_INTENT_ID,
      charge: CHARGE_ID,
      ...overrides,
    } as Stripe.Dispute;
  }

  function makeFakeReversalClient(params: {
    charge?: Partial<Stripe.Charge> | "not_found";
    // Controls the resolved application_fee field on the fake charge.
    // Omitted (default): auto-derive a valid, fully-expanded
    // ApplicationFee from application_fee_amount whenever the charge
    // sets a non-null application_fee_amount, with amount_refunded
    // defaulting to 0 unless overridden via a partial object here.
    // "unexpanded": simulate Stripe returning only the fee's id string
    // (expansion somehow failed/was dropped) -- must fail closed.
    // "missing": simulate a null application_fee despite a non-null
    // application_fee_amount -- must fail closed.
    // "mismatched_charge": the expanded fee object's own .charge points
    // at a DIFFERENT charge id -- must fail closed.
    applicationFee?:
      | Partial<Stripe.ApplicationFee>
      | "unexpanded"
      | "missing"
      | "mismatched_charge";
    transfer?: Partial<Stripe.Transfer> | "not_found";
    reversals?: Partial<Stripe.TransferReversal>[];
    createReversalResult?: Partial<Stripe.TransferReversal>;
    createReversalError?: Error;
  }) {
    const chargeOverrides = params.charge === "not_found" ? {} : (params.charge ?? {});
    const applicationFeeAmount: number | null =
      "application_fee_amount" in chargeOverrides
        ? (chargeOverrides.application_fee_amount ?? null)
        : null;

    let resolvedApplicationFee: Stripe.Charge["application_fee"] = null;
    if (applicationFeeAmount !== null) {
      if (params.applicationFee === "unexpanded") {
        resolvedApplicationFee = "fee_test_reversal";
      } else if (params.applicationFee === "missing") {
        resolvedApplicationFee = null;
      } else {
        const feeOverrides =
          params.applicationFee === "mismatched_charge"
            ? { charge: "ch_some_other_unrelated_charge" }
            : (params.applicationFee ?? {});
        resolvedApplicationFee = {
          id: "fee_test_reversal",
          object: "fee",
          amount: applicationFeeAmount,
          amount_refunded: 0,
          charge: CHARGE_ID,
          ...feeOverrides,
        } as Stripe.ApplicationFee;
      }
    }

    const chargesRetrieve = vi.fn(() => {
      if (params.charge === "not_found") return Promise.reject(new Error("No such charge"));
      return Promise.resolve({
        id: CHARGE_ID,
        object: "charge",
        amount: 500,
        transfer: TRANSFER_ID,
        application_fee_amount: null,
        ...chargeOverrides,
        application_fee: resolvedApplicationFee,
      } as Stripe.Charge);
    });

    const transfersRetrieve = vi.fn(() => {
      if (params.transfer === "not_found") return Promise.reject(new Error("No such transfer"));
      return Promise.resolve({
        id: TRANSFER_ID,
        object: "transfer",
        amount: 400,
        amount_reversed: 0,
        ...params.transfer,
      } as Stripe.Transfer);
    });

    const reversalsArray = (params.reversals ?? []) as Stripe.TransferReversal[];
    const listReversals = vi.fn(() => ({
      autoPagingToArray: () => Promise.resolve(reversalsArray),
    }));

    const createReversal = vi.fn<
      (
        transferId: string,
        params: { amount: number; metadata: Record<string, string> },
      ) => Promise<Stripe.TransferReversal>
    >(() => {
      if (params.createReversalError) return Promise.reject(params.createReversalError);
      return Promise.resolve({
        id: "trr_test_reversal",
        object: "transfer_reversal",
        amount: 400,
        currency: "usd",
        metadata: {},
        ...params.createReversalResult,
      } as Stripe.TransferReversal);
    });

    return {
      charges: { retrieve: chargesRetrieve },
      transfers: { retrieve: transfersRetrieve, listReversals, createReversal },
    };
  }

  function freshDisputeRow(overrides: Row = {}): Row {
    return {
      stripe_dispute_id: DISPUTE_ID,
      stripe_payment_intent_id: PAYMENT_INTENT_ID,
      status: "lost",
      reason: "fraudulent",
      amount_cents: 500,
      ...TABLE_DEFAULTS.payment_disputes,
      ...overrides,
    };
  }

  it("lost dispute -> successful reversal: correct amount, metadata, idempotency key, and durable state", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
    );

    expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 400 });
    // Exact (not objectContaining) match -- this also proves
    // refund_application_fee is never included in the params object at
    // all (LAUNCH-1 P1 REOPEN requirement #3/#14): any extra key here
    // would break this exact-match assertion.
    expect(stripeClient.transfers.createReversal).toHaveBeenCalledWith(
      TRANSFER_ID,
      {
        amount: 400,
        metadata: {
          librum_operation: "lost_dispute_recovery",
          stripe_dispute_id: DISPUTE_ID,
          stripe_payment_intent_id: PAYMENT_INTENT_ID,
          recovery_formula_version: "2",
        },
      },
      { idempotencyKey: buildTransferReversalIdempotencyKey(DISPUTE_ID, 1) },
    );

    const row = tables.payment_disputes[0];
    expect(row.transfer_reversal_status).toBe("succeeded");
    expect(row.stripe_transfer_id).toBe(TRANSFER_ID);
    expect(row.stripe_transfer_reversal_id).toBe("trr_test_reversal");
    expect(row.transfer_reversal_amount_cents).toBe(400);
    expect(row.transfer_reversal_attempt_count).toBe(1);
    expect(row.transfer_reversal_succeeded_at).not.toBeNull();
  });

  it("won dispute -> zero reversal: not_lost outcome, no Stripe or DB writes attempted", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow({ status: "won" })] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ status: "won" }),
    );

    expect(outcome).toEqual({ kind: "not_lost" });
    expect(stripeClient.charges.retrieve).not.toHaveBeenCalled();
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("not_attempted");
  });

  it("open/needs_response dispute -> zero reversal", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow({ status: "needs_response" })] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ status: "needs_response" }),
    );

    expect(outcome).toEqual({ kind: "not_lost" });
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("duplicate lost webhook: second delivery is a clean no-op once already succeeded", async () => {
    const tables: Tables = {
      payment_disputes: [
        freshDisputeRow({
          transfer_reversal_status: "succeeded",
          stripe_transfer_id: TRANSFER_ID,
          stripe_transfer_reversal_id: "trr_already_done",
          transfer_reversal_amount_cents: 400,
          transfer_reversal_attempt_count: 1,
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
    );

    expect(outcome).toEqual({ kind: "not_claimed" });
    expect(stripeClient.charges.retrieve).not.toHaveBeenCalled();
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].stripe_transfer_reversal_id).toBe("trr_already_done");
  });

  it("concurrent duplicate handling: a row another worker already claimed ('attempting', fresh) is left untouched", async () => {
    const tables: Tables = {
      payment_disputes: [
        freshDisputeRow({
          transfer_reversal_status: "attempting",
          transfer_reversal_attempted_at: new Date().toISOString(),
          transfer_reversal_attempt_count: 1,
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
      // No staleAttemptingCutoff -- the immediate webhook path never
      // reclaims an 'attempting' row, regardless of its age.
    );

    expect(outcome).toEqual({ kind: "not_claimed" });
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("exact Stripe metadata correlation: an existing reversal with matching metadata is found and reconciled, no new call made", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      reversals: [
        {
          id: "trr_already_exists",
          amount: 400,
          metadata: {
            librum_operation: "lost_dispute_recovery",
            stripe_dispute_id: DISPUTE_ID,
            stripe_payment_intent_id: PAYMENT_INTENT_ID,
            // Deliberately still "1" -- represents a reversal a PRIOR
            // deploy already created in Stripe before the LAUNCH-1 P1
            // REOPEN formula fix shipped. findExistingLostDisputeReversal
            // matches on librum_operation + stripe_dispute_id only, never
            // on this version tag, so a pre-fix reversal must still be
            // found and reconciled as-is by the corrected code -- never
            // re-attempted, never rewritten.
            recovery_formula_version: "1",
          },
        },
      ],
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
    );

    expect(outcome).toEqual({
      kind: "reconciled_existing",
      reversalId: "trr_already_exists",
      amountCents: 400,
    });
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("succeeded");
    expect(tables.payment_disputes[0].stripe_transfer_reversal_id).toBe("trr_already_exists");
  });

  it("a refund-caused reversal on the same transfer is NEVER mistaken for a dispute recovery -- a genuine new reversal is still created", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      reversals: [
        {
          id: "trr_from_a_refund",
          amount: 200,
          metadata: {}, // a reverse_transfer:true refund reversal never carries this metadata
          source_refund: "re_test_unrelated_refund",
        },
      ],
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
    );

    expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 400 });
    expect(stripeClient.transfers.createReversal).toHaveBeenCalledOnce();
  });

  it("Stripe timeout after successful reversal: reconciliation discovers the exact reversal and records success without a second call", async () => {
    const staleAttemptedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const tables: Tables = {
      payment_disputes: [
        freshDisputeRow({
          transfer_reversal_status: "attempting",
          transfer_reversal_attempted_at: staleAttemptedAt,
          transfer_reversal_attempt_count: 1,
          stripe_transfer_id: TRANSFER_ID,
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      reversals: [
        {
          id: "trr_created_before_the_crash",
          amount: 400,
          metadata: {
            librum_operation: "lost_dispute_recovery",
            stripe_dispute_id: DISPUTE_ID,
            stripe_payment_intent_id: PAYMENT_INTENT_ID,
            // Deliberately still "1" -- see the identical note on the
            // metadata-correlation test above.
            recovery_formula_version: "1",
          },
        },
      ],
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
      new Date(Date.now() - 10 * 60 * 1000), // 10-minute stale cutoff
    );

    expect(outcome).toEqual({
      kind: "reconciled_existing",
      reversalId: "trr_created_before_the_crash",
      amountCents: 400,
    });
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("succeeded");
    // Reused the SAME attempt count as the original -- no new attempt
    // was minted merely to reconcile an unknown-outcome retry.
    expect(tables.payment_disputes[0].transfer_reversal_attempt_count).toBe(1);
  });

  it("stale 'attempting' row (no existing reversal found) is reconciled by making a genuine attempt under the SAME attempt count/key", async () => {
    const staleAttemptedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const tables: Tables = {
      payment_disputes: [
        freshDisputeRow({
          transfer_reversal_status: "attempting",
          transfer_reversal_attempted_at: staleAttemptedAt,
          transfer_reversal_attempt_count: 1,
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
      new Date(Date.now() - 10 * 60 * 1000),
    );

    expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 400 });
    expect(stripeClient.transfers.createReversal).toHaveBeenCalledWith(
      TRANSFER_ID,
      expect.anything(),
      { idempotencyKey: buildTransferReversalIdempotencyKey(DISPUTE_ID, 1) }, // SAME attempt count, not bumped
    );
    expect(tables.payment_disputes[0].transfer_reversal_attempt_count).toBe(1);
  });

  it("fresh 'attempting' row (inside the stale window) is left completely untouched by the reconciliation path too", async () => {
    const freshAttemptedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 minutes ago
    const tables: Tables = {
      payment_disputes: [
        freshDisputeRow({
          transfer_reversal_status: "attempting",
          transfer_reversal_attempted_at: freshAttemptedAt,
          transfer_reversal_attempt_count: 1,
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
      new Date(Date.now() - 10 * 60 * 1000), // 10-minute cutoff -- 2 minutes ago is NOT stale
    );

    expect(outcome).toEqual({ kind: "not_claimed" });
    expect(stripeClient.charges.retrieve).not.toHaveBeenCalled();
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
  });

  it("'failed' row is retried with a NEW attempt count and a NEW idempotency key", async () => {
    const tables: Tables = {
      payment_disputes: [
        freshDisputeRow({
          transfer_reversal_status: "failed",
          transfer_reversal_attempt_count: 1,
          transfer_reversal_failure_code: "balance_insufficient",
          transfer_reversal_failure_message: "a previous, unrelated failure",
        }),
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
    );

    expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 400 });
    expect(stripeClient.transfers.createReversal).toHaveBeenCalledWith(
      TRANSFER_ID,
      expect.anything(),
      { idempotencyKey: buildTransferReversalIdempotencyKey(DISPUTE_ID, 2) }, // bumped from 1 -> 2
    );
    expect(tables.payment_disputes[0].transfer_reversal_attempt_count).toBe(2);
    expect(tables.payment_disputes[0].transfer_reversal_failure_code).toBeNull();
  });

  it("insufficient-balance-style rejection: persisted as 'failed' with Stripe's own code/message verbatim, never represented as success", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const rejection = Object.assign(new Error("Your card's balance is insufficient."), {
      code: "balance_insufficient",
    });
    const stripeClient = makeFakeReversalClient({ createReversalError: rejection });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
    );

    expect(outcome).toEqual({ kind: "failed", message: "Your card's balance is insufficient." });
    const row = tables.payment_disputes[0];
    expect(row.transfer_reversal_status).toBe("failed");
    expect(row.transfer_reversal_failure_code).toBe("balance_insufficient");
    expect(row.transfer_reversal_failure_message).toBe("Your card's balance is insufficient.");
    expect(row.stripe_transfer_reversal_id).toBeNull();
  });

  it("charge.amount <= 0: fails safely with an explicit reason rather than guessing an amount", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({ charge: { amount: 0 } });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  // ---------------------------------------------------------------------
  // LAUNCH-1 P1 REOPEN -- malformed-economic-shape guards. Every one of
  // these represents a Stripe object shape that should be impossible for
  // a charge Librum itself created, but the function must fail closed
  // (return null / persist 'failed') rather than derive a guessed amount
  // from inconsistent data, exactly like the pre-existing charge.amount
  // <= 0 guard above.
  // ---------------------------------------------------------------------
  it("application_fee_amount < 0: fails closed rather than guessing an amount", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: -1 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  it("application_fee_amount > charge.amount: fails closed rather than guessing an amount", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 1001 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  it("transfer.amount_reversed > transfer.amount: an invalid/inverted reversal state fails closed", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 1001 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  it("transfer.amount < 0: fails closed rather than guessing an amount", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: -1, amount_reversed: 0 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  it("dispute.amount <= 0: fails closed rather than guessing an amount", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 0 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  // LAUNCH-1 P1 REOPEN, live-Stripe-state ceiling -- dispute.amount can
  // legitimately exceed charge.amount per Stripe's own documentation
  // (e.g. currency fluctuation on a currency-converted charge). Rather
  // than clamp the ratio in that case, fail closed: this is an
  // intentional product policy, not a Stripe guarantee being relied on.
  it("dispute.amount > charge.amount: fails closed rather than clamping the ratio", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1001 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  // ---------------------------------------------------------------------
  // LAUNCH-1 P1 REOPEN -- malformed/unresolvable ApplicationFee state.
  // Every one of these represents a Stripe response shape that should be
  // impossible for a charge Librum itself created with a non-null
  // application_fee_amount, but the function must fail closed rather
  // than silently assume amount_refunded=0 (which would be the WRONG
  // direction to guess in: it would let a real fee refund go unaccounted
  // for, letting a later dispute over-debit the author).
  // ---------------------------------------------------------------------
  it("application fee resolved but not expanded (still a raw id string): fails closed rather than assuming zero fee refund", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
      applicationFee: "unexpanded",
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  it("application fee missing entirely despite a non-null application_fee_amount: fails closed", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
      applicationFee: "missing",
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  it("expanded application fee belongs to a DIFFERENT charge (inconsistent Stripe state): fails closed", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
      applicationFee: "mismatched_charge",
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  it("applicationFee.amount_refunded < 0: fails closed rather than guessing an amount", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
      applicationFee: { amount_refunded: -1 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  it("applicationFee.amount_refunded > applicationFee.amount: fails closed rather than guessing an amount", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
      applicationFee: { amount: 200, amount_refunded: 201 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(outcome.kind).toBe("failed");
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("failed");
  });

  // LAUNCH-1 P1 REOPEN -- confirms the exact expand array requested from
  // Stripe includes application_fee (not just transfer), and that this
  // is asserted against the actual call arguments the code sent, not
  // just against downstream fake object shapes that could pass even if
  // the real expand parameter were wrong.
  it("requests both transfer and application_fee expansion on the disputed charge retrieval", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
    });

    await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 1000 }),
    );

    expect(stripeClient.charges.retrieve).toHaveBeenCalledWith(CHARGE_ID, {
      expand: ["transfer", "application_fee"],
    });
  });

  it("fully-reversed transfer -> zero additional reversal, no Stripe mutation call", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      transfer: { amount: 400, amount_reversed: 400 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute(),
    );

    expect(outcome).toEqual({ kind: "nothing_to_reverse" });
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_status).toBe("succeeded");
    expect(tables.payment_disputes[0].transfer_reversal_amount_cents).toBe(0);
  });

  // LAUNCH-1 P1 REOPEN, live-Stripe-state ceiling formula:
  // originalAuthorEconomicShare = min(transfer.amount, charge.amount -
  // applicationFeeAmount) = 800. remainingAuthorEconomicProceeds =
  // max(0, originalAuthorEconomicShare - transfer.amount_reversed +
  // applicationFeeAmountRefunded) = max(0, 800 - 200 + 0) = 600 (the
  // prior 200-cent reversal is assumed, absent any recorded
  // ApplicationFee refund, to have come entirely out of the author's own
  // remaining share -- the worst case for the author, and the only one
  // the live Stripe state actually attests to). proportionalTarget =
  // round(800*800/1000) = 640. remainingTransfer = 1000-200 = 800.
  // amountToReverseNow = min(640, 800, 600) = 600 -- the economic
  // ceiling, not the proportional target, is what actually binds here.
  // This supersedes an earlier (uncommitted, never-shipped) intermediate
  // formula that lacked this ceiling and would have reversed 640 here --
  // over-debiting the author by 40 cents beyond their true remaining
  // proceeds whenever a prior reversal wasn't accompanied by a matching
  // application-fee refund.
  it("prior partial reversal (any cause, no fee refund) + dispute on the remainder: reverses only the author's true remaining economic proceeds, not the naive proportional target", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 200 },
      createReversalResult: { amount: 600 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 800 }),
    );

    expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 600 });
    expect(stripeClient.transfers.createReversal).toHaveBeenCalledWith(
      TRANSFER_ID,
      expect.objectContaining({ amount: 600 }),
      expect.anything(),
    );
  });

  // Same shape as the old (pre-ceiling) "clamped to the live remaining
  // transfer balance" scenario, but now demonstrates why that raw
  // transfer-balance clamp was never sufficient on its own: charge=1000,
  // fee=200 -> originalAuthorEconomicShare=800. A prior reversal of 900
  // (again, no recorded fee refund) already exceeds the author's entire
  // 800-cent share by 100 -- meaning that excess 100 was, in live-Stripe
  // terms, clawed back from Librum's own fee margin, not from the
  // author. remainingAuthorEconomicProceeds = max(0, 800-900+0) = 0. A
  // further dispute must reverse nothing more, even though naive
  // remainingTransfer (1000-900=100) alone would still allow 100 --
  // reversing that 100 would over-debit the author a second time.
  it("author's remaining economic proceeds already exhausted by a prior reversal: a further dispute reverses nothing, even though live remaining transfer balance is still positive", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 900 },
    });

    const outcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      stripeClient as never,
      makeFakeDispute({ amount: 900 }),
    );

    expect(outcome).toEqual({ kind: "nothing_to_reverse" });
    expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
    expect(tables.payment_disputes[0].transfer_reversal_amount_cents).toBe(0);
  });

  // LAUNCH-1 P1-8: Stripe can exceptionally create multiple distinct
  // disputes for one payment -- each is claimed/idempotency-guarded
  // independently by its OWN stripe_dispute_id, but both share one
  // aggregate ceiling (the live remaining transfer balance), which is
  // what prevents them from cumulatively over-reversing the transfer.
  // Realistic fixture: charge=1000, application_fee_amount=200 (author's
  // true total economic share = 800), two disputes each independently
  // claiming half the original charge (500 + 500 = 1000, the full
  // charge, split across two dispute records) -- cumulative reversal
  // must total exactly 800, never more, matching the author's true
  // total economic entitlement across BOTH disputes combined.
  it("multiple disputes on the same PaymentIntent/transfer cannot cumulatively reverse more than the author's true economic proceeds", async () => {
    const SECOND_DISPUTE_ID = "dp_test_reversal_second";
    const tables: Tables = {
      payment_disputes: [
        freshDisputeRow(),
        freshDisputeRow({ stripe_dispute_id: SECOND_DISPUTE_ID }),
      ],
    };
    const supabase = makeFakeSupabase(tables);

    // First dispute: nothing reversed yet, disputed 500 (50% of the
    // charge) -> authorEconomicShare=800, target=round(800*500/1000)
    // =400, remaining=1000, reverse=400.
    const firstStripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 0 },
      createReversalResult: { id: "trr_first_dispute", amount: 400 },
    });
    await reverseAuthorTransferForLostDispute(
      supabase as never,
      firstStripeClient as never,
      makeFakeDispute({ amount: 500 }),
    );
    expect(tables.payment_disputes[0].transfer_reversal_amount_cents).toBe(400);

    // Second, DISTINCT dispute on the same transfer: the transfer's
    // LIVE amount_reversed now correctly reflects the first dispute's
    // own reversal (400). Disputed 500 again -> target=round(800*500/
    // 1000)=400, remaining=1000-400=600, reverse=min(400,600)=400.
    const secondStripeClient = makeFakeReversalClient({
      charge: { amount: 1000, application_fee_amount: 200 },
      transfer: { amount: 1000, amount_reversed: 400 },
      createReversalResult: { id: "trr_second_dispute", amount: 400 },
    });
    const secondOutcome = await reverseAuthorTransferForLostDispute(
      supabase as never,
      secondStripeClient as never,
      makeFakeDispute({ id: SECOND_DISPUTE_ID, amount: 500 }),
    );

    expect(secondOutcome).toEqual({ kind: "reversed", reversalId: "trr_second_dispute", amountCents: 400 });
    expect(secondStripeClient.transfers.createReversal).toHaveBeenCalledWith(
      TRANSFER_ID,
      expect.objectContaining({ amount: 400 }),
      expect.anything(),
    );
    // Cumulative across both disputes: 400 + 400 = 800 -- exactly the
    // author's true total economic share, never more.
    expect(400 + 400).toBe(800);
    // Each dispute claimed and keyed independently -- attempt_count=1
    // on EACH row, not shared/accumulated across the two disputes.
    expect(tables.payment_disputes[0].transfer_reversal_attempt_count).toBe(1);
    expect(tables.payment_disputes[1].transfer_reversal_attempt_count).toBe(1);
  });

  it("reader entitlement state (payment_disputes.status) is untouched by a reversal failure -- entitlement never depends on reversal success", async () => {
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({
      createReversalError: new Error("simulated rejection"),
    });

    await reverseAuthorTransferForLostDispute(supabase as never, stripeClient as never, makeFakeDispute());

    // status (the column payment_intent_has_lost_dispute()/
    // user_owns_book() actually key off) is never written by this
    // function at all -- only the transfer_reversal_* columns are.
    expect(tables.payment_disputes[0].status).toBe("lost");
  });

  it("bundle context: a single dispute produces a single reversal attempt regardless of how many books the underlying transaction covered -- no bundle-specific branching exists in this function", async () => {
    // reverseAuthorTransferForLostDispute never reads purchases/
    // bundle_checkout_snapshots at all -- it operates purely on
    // dispute -> charge -> transfer, which is a property of the
    // PAYMENT, not of how many books it happened to cover. This test
    // exists to make that structural fact explicit.
    const tables: Tables = { payment_disputes: [freshDisputeRow()] };
    const supabase = makeFakeSupabase(tables);
    const stripeClient = makeFakeReversalClient({});

    await reverseAuthorTransferForLostDispute(supabase as never, stripeClient as never, makeFakeDispute());

    expect(stripeClient.transfers.createReversal).toHaveBeenCalledOnce();
    expect(tables.payment_disputes).toHaveLength(1);
  });

  // ---------------------------------------------------------------------
  // LAUNCH-1 P1 REOPEN -- the economic-correctness suite. Every fixture
  // below is a REALISTIC Librum destination charge (transfer.amount <=
  // charge.amount), unlike the impossible charge=100/transfer=800
  // shapes this suite used before this correction. Production impact
  // was manually verified before this turn: 0 lost disputes exist in
  // production, so this is a forward-only correctness fix with no
  // historical data to remediate.
  // ---------------------------------------------------------------------
  describe("economic correctness of the reversal amount (LAUNCH-1 P1 REOPEN)", () => {
    it("never reverses Librum's application-fee share from the connected author -- full lost dispute on a 1000/200 sale reverses exactly the author's 800 net proceeds, not the 1000 gross transfer", async () => {
      // This is the exact regression this correction exists for: the
      // OLD (round-4) formula multiplied transfer.amount (1000, gross)
      // directly by the dispute proportion, reversing the full 1000 --
      // debiting the author for the 200 cents of Librum's own platform
      // fee they never net-received. This test fails against that old
      // implementation and passes only against the corrected one.
      const tables: Tables = { payment_disputes: [freshDisputeRow()] };
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 0 },
        createReversalResult: { amount: 800 },
      });

      const outcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        stripeClient as never,
        makeFakeDispute({ amount: 1000 }),
      );

      expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 800 });
      expect(stripeClient.transfers.createReversal).toHaveBeenCalledWith(
        TRANSFER_ID,
        expect.objectContaining({ amount: 800 }),
        expect.anything(),
      );
      const calledAmount = stripeClient.transfers.createReversal.mock.calls[0][1].amount;
      expect(calledAmount).toBe(800);
      expect(calledAmount).not.toBe(1000);
    });

    it("50% dispute on a 1000/200 sale reverses exactly 400 -- half of the author's 800 net proceeds", async () => {
      const tables: Tables = { payment_disputes: [freshDisputeRow()] };
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 0 },
        createReversalResult: { amount: 400 },
      });

      const outcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        stripeClient as never,
        makeFakeDispute({ amount: 500 }),
      );

      expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 400 });
      expect(stripeClient.transfers.createReversal).toHaveBeenCalledWith(
        TRANSFER_ID,
        expect.objectContaining({ amount: 400 }),
        expect.anything(),
      );
    });

    it("zero application fee: reverses the full gross amount -- there is no fee to protect the author from", async () => {
      const tables: Tables = { payment_disputes: [freshDisputeRow()] };
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 0 },
        transfer: { amount: 1000, amount_reversed: 0 },
        createReversalResult: { amount: 1000 },
      });

      const outcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        stripeClient as never,
        makeFakeDispute({ amount: 1000 }),
      );

      expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 1000 });
      expect(stripeClient.transfers.createReversal).toHaveBeenCalledWith(
        TRANSFER_ID,
        expect.objectContaining({ amount: 1000 }),
        expect.anything(),
      );
    });

    it("null application_fee_amount (hypothetical transfer_data.amount-only charge): never reverses more than the transfer's own amount", async () => {
      // A charge that never used the application_fee_amount mechanism
      // at all -- application_fee_amount is null, and the Transfer was
      // created with an explicit, already-net amount (800) via a
      // hypothetical transfer_data.amount instead. authorEconomicShare
      // must fall back to min(transfer.amount, charge.amount - 0), which
      // correctly resolves to transfer.amount (800) here since it's the
      // smaller of the two.
      const tables: Tables = { payment_disputes: [freshDisputeRow()] };
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: null },
        transfer: { amount: 800, amount_reversed: 0 },
        createReversalResult: { amount: 800 },
      });

      const outcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        stripeClient as never,
        makeFakeDispute({ amount: 1000 }),
      );

      expect(outcome).toEqual({ kind: "reversed", reversalId: "trr_test_reversal", amountCents: 800 });
      const calledAmount = stripeClient.transfers.createReversal.mock.calls[0][1].amount;
      expect(calledAmount).toBeLessThanOrEqual(800);
    });

    it("fully-reversed transfer -- prior full refund already covered it: zero additional reversal even with a fee-bearing charge", async () => {
      const tables: Tables = { payment_disputes: [freshDisputeRow()] };
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 1000 },
      });

      const outcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        stripeClient as never,
        makeFakeDispute({ amount: 1000 }),
      );

      expect(outcome).toEqual({ kind: "nothing_to_reverse" });
      expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
      expect(tables.payment_disputes[0].transfer_reversal_status).toBe("succeeded");
      expect(tables.payment_disputes[0].transfer_reversal_amount_cents).toBe(0);
    });

    it("formula metadata reports version 2 on a newly-created reversal, and refund_application_fee is never included in the request params", async () => {
      const tables: Tables = { payment_disputes: [freshDisputeRow()] };
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 0 },
        createReversalResult: { amount: 800 },
      });

      await reverseAuthorTransferForLostDispute(
        supabase as never,
        stripeClient as never,
        makeFakeDispute({ amount: 1000 }),
      );

      const [, params] = stripeClient.transfers.createReversal.mock.calls[0];
      expect(params.metadata.recovery_formula_version).toBe("2");
      expect(params).not.toHaveProperty("refund_application_fee");
      expect(Object.keys(params)).toEqual(["amount", "metadata"]);
    });

    it("3-cent charge with a 1-cent application fee: repeated 1-cent-rounding partial disputes never cumulatively reverse more than the author's 2-cent economic share", async () => {
      const FIRST_ID = "dp_test_rounding_first";
      const SECOND_ID = "dp_test_rounding_second";
      const THIRD_ID = "dp_test_rounding_third";
      const tables: Tables = {
        payment_disputes: [
          freshDisputeRow({ stripe_dispute_id: FIRST_ID }),
          freshDisputeRow({ stripe_dispute_id: SECOND_ID }),
          freshDisputeRow({ stripe_dispute_id: THIRD_ID }),
        ],
      };
      const supabase = makeFakeSupabase(tables);

      // Round 1: nothing reversed yet. originalAuthorEconomicShare=2.
      // proportionalTarget = round(2*1/3) = round(0.667) = 1.
      const client1 = makeFakeReversalClient({
        charge: { amount: 3, application_fee_amount: 1 },
        transfer: { amount: 3, amount_reversed: 0 },
        createReversalResult: { id: "trr_round_1", amount: 1 },
      });
      await reverseAuthorTransferForLostDispute(
        supabase as never,
        client1 as never,
        makeFakeDispute({ id: FIRST_ID, amount: 1 }),
      );
      expect(tables.payment_disputes[0].transfer_reversal_amount_cents).toBe(1);

      // Round 2: live amount_reversed=1. proportionalTarget = round(2*1/
      // 3) = 1 again (rounding is applied per-dispute against the
      // ORIGINAL share, not against what's left). remainingAuthor
      // EconomicProceeds = max(0, 2-1+0) = 1 -- still enough to cover it.
      const client2 = makeFakeReversalClient({
        charge: { amount: 3, application_fee_amount: 1 },
        transfer: { amount: 3, amount_reversed: 1 },
        createReversalResult: { id: "trr_round_2", amount: 1 },
      });
      await reverseAuthorTransferForLostDispute(
        supabase as never,
        client2 as never,
        makeFakeDispute({ id: SECOND_ID, amount: 1 }),
      );
      expect(tables.payment_disputes[1].transfer_reversal_amount_cents).toBe(1);

      // Round 3: live amount_reversed=2. The same rounding would again
      // naively produce a target of 1, but remainingAuthorEconomicProceeds
      // = max(0, 2-2+0) = 0 -- the ceiling correctly reverses 0, not 1,
      // which is exactly what stops the three 1-cent roundings from
      // cumulatively exceeding the author's true 2-cent share.
      const client3 = makeFakeReversalClient({
        charge: { amount: 3, application_fee_amount: 1 },
        transfer: { amount: 3, amount_reversed: 2 },
      });
      const outcome3 = await reverseAuthorTransferForLostDispute(
        supabase as never,
        client3 as never,
        makeFakeDispute({ id: THIRD_ID, amount: 1 }),
      );

      expect(outcome3).toEqual({ kind: "nothing_to_reverse" });
      expect(client3.transfers.createReversal).not.toHaveBeenCalled();
      const cumulative =
        Number(tables.payment_disputes[0].transfer_reversal_amount_cents) +
        Number(tables.payment_disputes[1].transfer_reversal_amount_cents) +
        Number(tables.payment_disputes[2].transfer_reversal_amount_cents);
      expect(cumulative).toBe(2);
      expect(cumulative).toBeLessThanOrEqual(2);
    });

    it("two disputes whose amounts sum to MORE than the charge itself still cannot cumulatively reverse more than the author's true economic share", async () => {
      const FIRST_ID = "dp_test_oversum_first";
      const SECOND_ID = "dp_test_oversum_second";
      const tables: Tables = {
        payment_disputes: [
          freshDisputeRow({ stripe_dispute_id: FIRST_ID }),
          freshDisputeRow({ stripe_dispute_id: SECOND_ID }),
        ],
      };
      const supabase = makeFakeSupabase(tables);

      // First dispute: 800 of the 1000-cent charge (80%).
      // originalAuthorEconomicShare = 800. target = round(800*800/1000)
      // = 640. Nothing reversed yet -> reverse 640.
      const firstClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 0 },
        createReversalResult: { id: "trr_oversum_first", amount: 640 },
      });
      await reverseAuthorTransferForLostDispute(
        supabase as never,
        firstClient as never,
        makeFakeDispute({ id: FIRST_ID, amount: 800 }),
      );
      expect(tables.payment_disputes[0].transfer_reversal_amount_cents).toBe(640);

      // Second, DISTINCT dispute: another 500 cents (50%) -- 800+500=
      // 1300, more than the entire 1000-cent charge, and more than the
      // author's 800-cent true share on its own. Live amount_reversed is
      // now 640. proportionalTarget = round(800*500/1000) = 400, but
      // remainingAuthorEconomicProceeds = max(0, 800-640+0) = 160 -- the
      // ceiling, not the naive proportional target, is what correctly
      // binds here.
      const secondClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 640 },
        createReversalResult: { id: "trr_oversum_second", amount: 160 },
      });
      const secondOutcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        secondClient as never,
        makeFakeDispute({ id: SECOND_ID, amount: 500 }),
      );

      expect(secondOutcome).toEqual({
        kind: "reversed",
        reversalId: "trr_oversum_second",
        amountCents: 160,
      });
      expect(secondClient.transfers.createReversal).toHaveBeenCalledWith(
        TRANSFER_ID,
        expect.objectContaining({ amount: 160 }),
        expect.anything(),
      );
      const cumulative =
        Number(tables.payment_disputes[0].transfer_reversal_amount_cents) +
        Number(tables.payment_disputes[1].transfer_reversal_amount_cents);
      expect(cumulative).toBe(800);
    });

    it("full refund of both the transfer and its application fee: a later lost dispute reverses nothing further", async () => {
      const tables: Tables = { payment_disputes: [freshDisputeRow()] };
      const supabase = makeFakeSupabase(tables);
      const stripeClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 1000 },
        applicationFee: { amount: 200, amount_refunded: 200 },
      });

      const outcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        stripeClient as never,
        makeFakeDispute({ amount: 1000 }),
      );

      expect(outcome).toEqual({ kind: "nothing_to_reverse" });
      expect(stripeClient.transfers.createReversal).not.toHaveBeenCalled();
      expect(tables.payment_disputes[0].transfer_reversal_amount_cents).toBe(0);
    });

    // LAUNCH-1 P1 REOPEN Section 13 -- the dedicated business-invariant
    // regression test: the author's cumulative economic proceeds must
    // never be reduced below zero, across a mix of a prior refund (WITH
    // a matching application-fee refund) and two separate lost-dispute
    // reversals. This test fails against BOTH prior formulas:
    //  - the original P1-8 gross-transfer formula (reverses a proportion
    //    of transfer.amount directly, ignoring the fee and any live fee
    //    refund entirely) would compute, for the second dispute below,
    //    round(1000*500/1000)=500 clamped to remainingTransfer=160 -> 160.
    //  - the intermediate uncommitted formula (authorEconomicShare-aware,
    //    but with no live-Stripe-state ceiling) would compute
    //    round(800*500/1000)=400 clamped to remainingTransfer=160 -> 160.
    // Both wrongly reverse 160 more from an author whose true remaining
    // economic proceeds are already exactly zero. Only the corrected
    // formula (with remainingAuthorEconomicProceeds folded into the min())
    // correctly reverses 0.
    it("business invariant: cumulative author economic proceeds never goes below zero across a fee-refunding refund plus two lost-dispute reversals", async () => {
      const FIRST_ID = "dp_test_invariant_first";
      const SECOND_ID = "dp_test_invariant_second";
      const tables: Tables = {
        payment_disputes: [
          freshDisputeRow({ stripe_dispute_id: FIRST_ID }),
          freshDisputeRow({ stripe_dispute_id: SECOND_ID }),
        ],
      };
      const supabase = makeFakeSupabase(tables);

      // A prior 200-cent refund already reversed 200 of the transfer,
      // and correctly refunded 40 of the 200-cent application fee back
      // to the connected account (an ordinary Stripe refund proportionally
      // refunds the platform fee too, unlike Librum's own lost-dispute
      // recovery reversals, which deliberately never do).
      // remainingAuthorEconomicProceeds = max(0, 800-200+40) = 640.
      // First dispute (800): proportionalTarget = round(800*800/1000) =
      // 640. remainingTransfer = 800. reverse min(640,800,640) = 640.
      const firstClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 200 },
        applicationFee: { amount: 200, amount_refunded: 40 },
        createReversalResult: { id: "trr_invariant_first", amount: 640 },
      });
      const firstOutcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        firstClient as never,
        makeFakeDispute({ id: FIRST_ID, amount: 800 }),
      );
      expect(firstOutcome).toEqual({
        kind: "reversed",
        reversalId: "trr_invariant_first",
        amountCents: 640,
      });
      expect(tables.payment_disputes[0].transfer_reversal_amount_cents).toBe(640);

      // Live state after: transfer.amount_reversed = 200+640 = 840. The
      // application-fee refund total is unchanged (Librum's own reversal
      // never refunds any more of the fee). remainingAuthorEconomicProceeds
      // = max(0, 800-840+40) = 0 -- the author's entire economic share is
      // now exhausted between the refund and the first dispute reversal.
      const secondClient = makeFakeReversalClient({
        charge: { amount: 1000, application_fee_amount: 200 },
        transfer: { amount: 1000, amount_reversed: 840 },
        applicationFee: { amount: 200, amount_refunded: 40 },
      });
      const secondOutcome = await reverseAuthorTransferForLostDispute(
        supabase as never,
        secondClient as never,
        makeFakeDispute({ id: SECOND_ID, amount: 500 }),
      );

      expect(secondOutcome).toEqual({ kind: "nothing_to_reverse" });
      expect(secondClient.transfers.createReversal).not.toHaveBeenCalled();
      expect(tables.payment_disputes[1].transfer_reversal_amount_cents).toBe(0);
    });
  });
});

// LIBRUM 2.0 CONNECT-HARDEN-1: keeps profiles.stripe_payouts_enabled in
// sync with live Stripe connected-account state. Never the authority
// checkout relies on (checkConnectedAccountReadyForCheckout,
// src/lib/connect-account.ts, always re-verifies live) -- this is purely
// a display/cache sync, covered here for its own contract: it updates
// the right row, touches only the one column, degrades safely when
// nothing matches, and converges under replay. REVIEW CORRECTION: a DB
// write failure is no longer swallowed -- it now goes through
// failWebhook() (a non-2xx response) so Stripe retries a transient
// outage, exactly like every other critical handler in this file. Only
// the "no matching profile" case is NOT treated as a failure -- a retry
// can never produce a different outcome for that one.
describe("processAccountUpdatedEvent", () => {
  const FAKE_EVENT = { id: "evt_account_updated_1" } as Stripe.Event;

  // LIBRUM 2.0 CONNECT-HARDEN-1 REVIEW CORRECTION: capabilities.transfers
  // defaults to "active" here (Stripe's actual account shape) so every
  // pre-existing test below that doesn't care about it stays a
  // fully-ready fixture under the corrected predicate
  // (payouts_enabled && capabilities.transfers === "active").
  function makeFakeAccount(overrides: Partial<Stripe.Account> = {}): Stripe.Account {
    return {
      id: "acct_test",
      object: "account",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { transfers: "active" },
      ...overrides,
    } as Stripe.Account;
  }

  it("account.updated reports both capabilities enabled: sets stripe_payouts_enabled = true for the matching profile, webhook succeeds", async () => {
    const tables: Tables = {
      profiles: [{ id: "author-1", stripe_account_id: "acct_test", stripe_payouts_enabled: false }],
    };
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await processAccountUpdatedEvent(
      supabase as never,
      FAKE_EVENT,
      makeFakeAccount(),
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.profiles[0]).toMatchObject({ stripe_payouts_enabled: true });
  });

  it("account.updated reports payouts_enabled false: flips stripe_payouts_enabled back to false even if it was previously true", async () => {
    const tables: Tables = {
      profiles: [{ id: "author-1", stripe_account_id: "acct_test", stripe_payouts_enabled: true }],
    };
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await processAccountUpdatedEvent(
      supabase as never,
      FAKE_EVENT,
      makeFakeAccount({ payouts_enabled: false }),
      failWebhook,
    );

    expect(result).toBeNull();
    expect(tables.profiles[0]).toMatchObject({ stripe_payouts_enabled: false });
  });

  it("account.updated reports capabilities.transfers not active: not ready, stripe_payouts_enabled set to false", async () => {
    const tables: Tables = {
      profiles: [{ id: "author-1", stripe_account_id: "acct_test", stripe_payouts_enabled: true }],
    };
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await processAccountUpdatedEvent(
      supabase as never,
      FAKE_EVENT,
      makeFakeAccount({ capabilities: { transfers: "pending" } }),
      failWebhook,
    );

    expect(result).toBeNull();
    expect(tables.profiles[0]).toMatchObject({ stripe_payouts_enabled: false });
  });

  // LIBRUM 2.0 CONNECT-HARDEN-1 REVIEW CORRECTION regression: proves the
  // removed charges_enabled dependency stays removed in the webhook sync
  // too, not just at checkout.
  it("account.updated reports charges_enabled false but payouts_enabled + transfers=active: stripe_payouts_enabled set to TRUE", async () => {
    const tables: Tables = {
      profiles: [{ id: "author-1", stripe_account_id: "acct_test", stripe_payouts_enabled: false }],
    };
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await processAccountUpdatedEvent(
      supabase as never,
      FAKE_EVENT,
      makeFakeAccount({ charges_enabled: false }),
      failWebhook,
    );

    expect(result).toBeNull();
    expect(tables.profiles[0]).toMatchObject({ stripe_payouts_enabled: true });
  });

  it("only ever writes stripe_payouts_enabled -- every other profile column is untouched", async () => {
    const tables: Tables = {
      profiles: [
        {
          id: "author-1",
          stripe_account_id: "acct_test",
          stripe_payouts_enabled: false,
          display_name: "Renato Kalemi",
          email: "renato@example.com",
        },
      ],
    };
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);

    await processAccountUpdatedEvent(supabase as never, FAKE_EVENT, makeFakeAccount(), failWebhook);

    expect(tables.profiles[0]).toMatchObject({
      display_name: "Renato Kalemi",
      email: "renato@example.com",
    });
  });

  it("no profile currently references this account id: succeeds (webhook returns 2xx), logs a warning, never calls failWebhook", async () => {
    const tables: Tables = { profiles: [] };
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processAccountUpdatedEvent(
      supabase as never,
      FAKE_EVENT,
      makeFakeAccount(),
      failWebhook,
    );

    expect(result).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no matching profile"),
      expect.objectContaining({ stripeAccountId: "acct_test" }),
    );
    warnSpy.mockRestore();
  });

  it("idempotent: processing the same account.updated payload twice converges to the same stored value, both succeed", async () => {
    const tables: Tables = {
      profiles: [{ id: "author-1", stripe_account_id: "acct_test", stripe_payouts_enabled: false }],
    };
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);
    const account = makeFakeAccount();

    const firstResult = await processAccountUpdatedEvent(supabase as never, FAKE_EVENT, account, failWebhook);
    const secondResult = await processAccountUpdatedEvent(supabase as never, FAKE_EVENT, account, failWebhook);

    expect(firstResult).toBeNull();
    expect(secondResult).toBeNull();
    expect(failWebhook).not.toHaveBeenCalled();
    expect(tables.profiles[0]).toMatchObject({ stripe_payouts_enabled: true });
  });

  it("DB update error: propagates through failWebhook so Stripe receives a non-2xx and retries -- REVIEW CORRECTION, no longer swallowed", async () => {
    const tables: Tables = {
      profiles: [{ id: "author-1", stripe_account_id: "acct_test", stripe_payouts_enabled: false }],
    };
    const supabase = makeFakeSupabase(tables, { profiles: { message: "write failed" } });
    const failWebhook = vi.fn(fakeFailWebhook);

    const result = await processAccountUpdatedEvent(
      supabase as never,
      FAKE_EVENT,
      makeFakeAccount(),
      failWebhook,
    );

    expect(result).not.toBeNull();
    expect(failWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: FAKE_EVENT.id,
        stripeAccountId: "acct_test",
        reason: expect.stringContaining("failed to sync stripe_payouts_enabled"),
      }),
    );
    // The failed write must not have silently applied a partial state --
    // the row is untouched, exactly as a real failed UPDATE would leave
    // it, so Stripe's retry has a clean, unambiguous starting point.
    expect(tables.profiles[0]).toMatchObject({ stripe_payouts_enabled: false });
  });
});

// LIBRUM 2.0 CONNECT-HARDEN-2: this one URL now receives deliveries
// signed by two DIFFERENT Stripe event destinations (the pre-existing
// platform destination, and a second Connected-accounts destination
// required for account.updated -- see constructStripeEventFromApprovedSecrets's
// own documentation in route.ts for why a second destination is
// necessary at all). Every case below signs a REAL payload with a REAL
// HMAC signature via Stripe's own webhooks.generateTestHeaderString --
// deliberately not mocked -- so these tests exercise the actual
// cryptographic verification path, not a stand-in for it. A throwaway
// Stripe client (no real API key is ever used or needed -- signing/
// verifying a webhook payload is pure local HMAC, no network call) is
// used only to sign fixtures and as the stripeClient argument the
// function under test calls .webhooks.constructEvent on.
describe("constructStripeEventFromApprovedSecrets", () => {
  const PLATFORM_SECRET = "whsec_test_platform_secret_00000000000000000000";
  const CONNECT_SECRET = "whsec_test_connect_secret_0000000000000000000000";
  const WRONG_SECRET = "whsec_test_totally_unrelated_secret_00000000000000";

  // Real Stripe client used only for local HMAC signing/verification in
  // these tests -- never makes a network call.
  const signingClient = new RealStripe("sk_test_unused_signing_client_only");

  function sign(payloadObject: Record<string, unknown>, secret: string) {
    const payload = JSON.stringify(payloadObject);
    const header = signingClient.webhooks.generateTestHeaderString({ payload, secret });
    return { payload, header };
  }

  function makeCheckoutSessionCompletedPayload() {
    return {
      id: "evt_checkout_session_completed_1",
      object: "event",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_1", object: "checkout.session" } },
    };
  }

  function makeAccountUpdatedPayload() {
    return {
      id: "evt_account_updated_1",
      object: "event",
      type: "account.updated",
      data: {
        object: {
          id: "acct_test_1",
          object: "account",
          charges_enabled: true,
          payouts_enabled: true,
          capabilities: { transfers: "active" },
        },
      },
    };
  }

  beforeEach(() => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", PLATFORM_SECRET);
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", CONNECT_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("1. valid event signed with STRIPE_WEBHOOK_SECRET succeeds", () => {
    const { payload, header } = sign(makeCheckoutSessionCompletedPayload(), PLATFORM_SECRET);

    const result = constructStripeEventFromApprovedSecrets(signingClient, payload, header);

    expect(result.ok).toBe(true);
    expect(result.ok && result.event.id).toBe("evt_checkout_session_completed_1");
  });

  it("2. valid event signed with STRIPE_CONNECT_WEBHOOK_SECRET succeeds", () => {
    const { payload, header } = sign(makeAccountUpdatedPayload(), CONNECT_SECRET);

    const result = constructStripeEventFromApprovedSecrets(signingClient, payload, header);

    expect(result.ok).toBe(true);
    expect(result.ok && result.event.id).toBe("evt_account_updated_1");
  });

  it("3. invalid signature for both secrets fails", () => {
    const { payload, header } = sign(makeCheckoutSessionCompletedPayload(), WRONG_SECRET);

    const result = constructStripeEventFromApprovedSecrets(signingClient, payload, header);

    expect(result.ok).toBe(false);
  });

  it("4. first (platform) secret fails but second (connect) secret succeeds", () => {
    // Signed ONLY with the connect secret -- verification against
    // STRIPE_WEBHOOK_SECRET must fail first, then fall through and
    // succeed against STRIPE_CONNECT_WEBHOOK_SECRET.
    const { payload, header } = sign(makeAccountUpdatedPayload(), CONNECT_SECRET);

    const result = constructStripeEventFromApprovedSecrets(signingClient, payload, header);

    expect(result.ok).toBe(true);
    expect(result.ok && result.event.type).toBe("account.updated");
  });

  it("5a. second secret undefined: a valid platform-secret signature still succeeds", () => {
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
    const { payload, header } = sign(makeCheckoutSessionCompletedPayload(), PLATFORM_SECRET);

    const result = constructStripeEventFromApprovedSecrets(signingClient, payload, header);

    expect(result.ok).toBe(true);
  });

  it("5b. second secret undefined: an invalid platform-secret signature still fails safely (no crash)", () => {
    vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "");
    const { payload, header } = sign(makeCheckoutSessionCompletedPayload(), WRONG_SECRET);

    const result = constructStripeEventFromApprovedSecrets(signingClient, payload, header);

    expect(result.ok).toBe(false);
  });

  it("6. account.updated signed by the connect secret verifies to an event usable by the existing account.updated handler", async () => {
    const { payload, header } = sign(makeAccountUpdatedPayload(), CONNECT_SECRET);

    const result = constructStripeEventFromApprovedSecrets(signingClient, payload, header);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.event.type).toBe("account.updated");

    // Feeds straight into the existing, already-covered handler --
    // proves the verified event is the same shape processAccountUpdatedEvent
    // already expects, not just that verification alone succeeded.
    const tables: Tables = {
      profiles: [{ id: "author-1", stripe_account_id: "acct_test_1", stripe_payouts_enabled: false }],
    };
    const supabase = makeFakeSupabase(tables);
    const failWebhook = vi.fn(fakeFailWebhook);
    const account = result.event.data.object as Stripe.Account;

    const handlerResult = await processAccountUpdatedEvent(supabase as never, result.event, account, failWebhook);

    expect(handlerResult).toBeNull();
    expect(tables.profiles[0]).toMatchObject({ stripe_payouts_enabled: true });
  });

  it("7. checkout.session.completed signed by the original platform secret still verifies to an event usable by the existing fulfillment path", () => {
    const { payload, header } = sign(makeCheckoutSessionCompletedPayload(), PLATFORM_SECRET);

    const result = constructStripeEventFromApprovedSecrets(signingClient, payload, header);

    expect(result.ok).toBe(true);
    expect(result.ok && result.event.type).toBe("checkout.session.completed");
    // POST()'s own dispatch on event.type === "checkout.session.completed"
    // (unchanged by this correction) is what routes this on to
    // fulfillBundleSnapshot/fulfillLegacyBundle/fulfillSingleBookPurchase
    // -- all three are already covered by their own describe blocks
    // elsewhere in this file, using this exact event shape.
  });

  it("9. raw-body verification is preserved: a byte-for-byte re-serialized (but semantically identical) payload fails signature verification", () => {
    const original = makeCheckoutSessionCompletedPayload();
    const { payload, header } = sign(original, PLATFORM_SECRET);
    // Re-parsing and re-stringifying a JSON payload is not guaranteed to
    // reproduce the exact original byte sequence (key order, spacing) --
    // Stripe's HMAC is computed over the raw bytes actually sent, so a
    // route that ever parsed/re-stringified the body before verification
    // would silently break here. This proves the helper is exercising
    // real, byte-sensitive HMAC verification, not a loose type check.
    const reserialized = JSON.stringify(JSON.parse(payload));

    const resultOnOriginal = constructStripeEventFromApprovedSecrets(signingClient, payload, header);
    expect(resultOnOriginal.ok).toBe(true);

    if (reserialized !== payload) {
      const resultOnReserialized = constructStripeEventFromApprovedSecrets(
        signingClient,
        reserialized,
        header,
      );
      expect(resultOnReserialized.ok).toBe(false);
    }
  });
});
