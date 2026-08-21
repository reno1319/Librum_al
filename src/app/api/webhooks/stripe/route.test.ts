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

const { fulfillBundleSnapshot } = await import("./route");

// ---------------------------------------------------------------------
// A minimal, in-memory fake of the Supabase query builder -- just
// enough of the fluent chain (.select/.eq/.is/.update/.upsert/.delete/
// .maybeSingle, and plain `await` on the builder itself) to exercise
// every Supabase call fulfillBundleSnapshot actually makes against
// `bundle_checkout_snapshots` and `purchases`. Not a general-purpose
// Supabase mock -- deliberately scoped to this one function's call
// shapes, since that's what these tests drive.
// ---------------------------------------------------------------------
type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: { col: string; val: unknown }[] = [];
  private op: "select" | "update" | "upsert" | "delete" = "select";
  private payload: Row | undefined;
  private upsertOnConflict: string | undefined;
  private wantReturnRows = false;

  constructor(
    private tables: Tables,
    private table: string,
  ) {}

  select() {
    if (this.op !== "select") this.wantReturnRows = true;
    return this;
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, val });
    return this;
  }

  is(col: string, val: unknown) {
    this.filters.push({ col, val });
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
    return this.filters.every((f) => row[f.col] === f.val);
  }

  private execute(): { data: unknown; error: unknown } {
    const rows = this.rows();

    if (this.op === "select") {
      return { data: rows.filter((r) => this.matches(r)), error: null };
    }

    if (this.op === "update") {
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

function makeFakeSupabase(tables: Tables) {
  return {
    from: (table: string) => new FakeQuery(tables, table),
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
