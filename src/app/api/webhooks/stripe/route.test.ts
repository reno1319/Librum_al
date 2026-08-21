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
  processChargeRefund,
  processRefundLifecycleEvent,
  processChargeRefundedEvent,
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
