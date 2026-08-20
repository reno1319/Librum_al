import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendPurchaseEmails,
  sendBundlePurchaseEmails,
  sendSnapshotBundlePurchaseEmails,
} from "@/lib/email";

type SnapshotItem = {
  bookId: string;
  title: string;
  priceCentsAtCheckout: number;
  position: number;
};

// The frozen `items` column is jsonb -- it arrives here as `unknown`,
// and Stripe's metadata.snapshot_id (which points at the row it came
// from) is itself untrusted input, so the row it resolves to is
// validated defensively rather than cast and trusted. Migration 025's
// RPC is the only writer of this column and always produces exactly
// this shape -- if this ever fails, the snapshot is corrupt or wasn't
// written by that RPC, a critical condition no retry can fix, worth
// failing loudly on rather than limping through with malformed data.
function parseSnapshotItems(raw: unknown): SnapshotItem[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;

  const seenBookIds = new Set<string>();
  const items: SnapshotItem[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;

    const bookId = record.book_id;
    const title = record.title;
    const priceCentsAtCheckout = record.price_cents_at_checkout;
    const position = record.position;

    if (typeof bookId !== "string" || bookId.length === 0) return null;
    if (typeof title !== "string") return null;
    if (
      typeof priceCentsAtCheckout !== "number" ||
      !Number.isInteger(priceCentsAtCheckout) ||
      priceCentsAtCheckout < 0
    ) {
      return null;
    }
    if (typeof position !== "number" || !Number.isInteger(position)) return null;
    if (seenBookIds.has(bookId)) return null;
    seenBookIds.add(bookId);

    items.push({ bookId, title, priceCentsAtCheckout, position });
  }

  return items;
}

// Splits amountTotalCents across items in proportion to each item's own
// frozen price_cents_at_checkout, so the shares always sum to EXACTLY
// amountTotalCents (Stripe's actual paid total -- never the frozen
// bundle price). Every share is floored first; the cents lost to
// flooring are handed out one at a time in the items' own frozen
// `position` order -- deterministic and reproducible identically on
// every retry, since it depends only on the immutable snapshot's own
// item order, never on wall-clock time or anything else that could
// differ between a first attempt and a later retry of the same event.
//
// Requires the caller to have already ruled out the case where every
// item's frozen price is 0 while amountTotalCents is positive -- that
// combination has no meaningful ratio to derive shares from and is
// rejected as corrupt commercial data before this function is ever
// called (see fulfillBundleSnapshot). The only zero-total-price case
// this function itself handles is amountTotalCents also being 0, where
// every item legitimately gets zero -- no invented positive allocation
// is ever produced here.
function allocateBundleRevenue(
  items: SnapshotItem[],
  amountTotalCents: number,
): Map<string, number> {
  const totalFrozenPriceCents = items.reduce(
    (sum, item) => sum + item.priceCentsAtCheckout,
    0,
  );
  const orderedItems = [...items].sort((a, b) => a.position - b.position);

  if (totalFrozenPriceCents === 0) {
    return new Map(orderedItems.map((item) => [item.bookId, 0]));
  }

  const shares = orderedItems.map((item) => {
    const exactShare =
      (amountTotalCents * item.priceCentsAtCheckout) / totalFrozenPriceCents;
    return { bookId: item.bookId, amount: Math.floor(exactShare) };
  });

  let remainingCents =
    amountTotalCents - shares.reduce((sum, share) => sum + share.amount, 0);

  for (let i = 0; i < shares.length && remainingCents > 0; i++) {
    shares[i].amount += 1;
    remainingCents -= 1;
  }

  return new Map(shares.map((share) => [share.bookId, share.amount]));
}

type SnapshotRow = {
  id: string;
  reader_id: string | null;
  author_id: string | null;
  bundle_id: string | null;
  bundle_title: string;
  bundle_price_cents_at_checkout: number;
  items: unknown;
  protection_expires_at: string | null;
  fulfilled_at: string | null;
  stripe_checkout_session_id: string | null;
};

// Fulfills a NEW-shape bundle checkout (metadata.snapshot_id) from the
// durable, checkout-time-frozen bundle_checkout_snapshots row -- never
// from live bundles/bundle_books, and never trusting book ids, prices,
// or reader identity from Stripe metadata itself. Returns a
// NextResponse if the request should end early (a failure, or an
// already-fulfilled short-circuit); returns null to let the caller fall
// through to the normal `{ received: true }` response.
async function fulfillBundleSnapshot(
  supabase: ReturnType<typeof createAdminClient>,
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  snapshotId: string,
  paymentIntentId: string | null,
  amountCents: number,
  failWebhook: (context: Record<string, unknown>) => NextResponse,
): Promise<NextResponse | null> {
  const { data: snapshot, error: snapshotError } = await supabase
    .from("bundle_checkout_snapshots")
    .select(
      "id, reader_id, author_id, bundle_id, bundle_title, bundle_price_cents_at_checkout, items, protection_expires_at, fulfilled_at, stripe_checkout_session_id",
    )
    .eq("id", snapshotId)
    .maybeSingle<SnapshotRow>();

  if (snapshotError) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      error: snapshotError,
    });
  }

  if (!snapshot) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      reason: "snapshot not found",
    });
  }

  // A duplicate/replayed delivery of an already-fulfilled event must
  // never re-run the writes below -- doing so would risk re-clearing a
  // refunded_at a legitimate refund set in the meantime, and would send
  // a second purchase email for an already-granted entitlement. This
  // runs before any purchase write is attempted.
  if (snapshot.fulfilled_at) {
    return null;
  }

  if (!snapshot.reader_id) {
    // Only reachable if the reader's account was deleted after this
    // snapshot's protection window had already lapsed (the reader-hold
    // trigger only clears an EXPIRED hold) -- no live profile exists to
    // attach a purchases row to. Unrecoverable by retrying, but still
    // correct to fail loudly here rather than silently return 200 over
    // a paid-but-permanently-unentitlable session.
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      reason: "snapshot reader_id is null",
    });
  }

  if (
    typeof snapshot.bundle_price_cents_at_checkout !== "number" ||
    !Number.isInteger(snapshot.bundle_price_cents_at_checkout) ||
    snapshot.bundle_price_cents_at_checkout < 0
  ) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      reason: "snapshot bundle_price_cents_at_checkout is unusable",
    });
  }

  if (!snapshot.protection_expires_at) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      reason: "snapshot protection_expires_at is missing",
    });
  }

  const items = parseSnapshotItems(snapshot.items);
  if (!items) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      reason: "snapshot items failed structural validation",
    });
  }

  // Stripe's own charged total is authoritative for what was actually
  // paid -- bundle_price_cents_at_checkout is only ever used to derive
  // allocation RATIOS between books, never as proof of payment. Once a
  // later stage makes Stripe's unit_amount come directly from this same
  // frozen value, the two should always be equal by construction -- a
  // mismatch here would indicate a bug in that wiring, a manually
  // constructed test event, or some other integrity anomaly, not normal
  // variance. Logged for investigation, but does not block fulfillment:
  // refusing entitlement over a value that isn't proof of payment would
  // risk the "charged without entitlement" failure this track exists to
  // prevent.
  if (amountCents !== snapshot.bundle_price_cents_at_checkout) {
    console.error("Stripe webhook: bundle snapshot price mismatch", {
      eventId: event.id,
      checkoutSessionId: session.id,
      snapshotId,
      amountTotalCents: amountCents,
      bundlePriceCentsAtCheckout: snapshot.bundle_price_cents_at_checkout,
    });
  }

  // A bundle whose books all price out to 0 has no ratio to split a
  // POSITIVE Stripe total across -- unlike the legacy path (which falls
  // back to an equal split for this same condition), the new path
  // treats it as inconsistent commercial data rather than inventing an
  // allocation: 0 total item price with a real charge behind it should
  // never occur once Stage 2B prices Stripe's checkout directly from
  // this same frozen bundle price, so it's failed loudly here instead
  // of silently guessed at. A genuinely free bundle (amountCents also
  // 0) is unaffected -- allocateBundleRevenue below still correctly
  // gives every item a $0 share in that case.
  const totalFrozenPriceCents = items.reduce(
    (sum, item) => sum + item.priceCentsAtCheckout,
    0,
  );
  if (totalFrozenPriceCents === 0 && amountCents > 0) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      reason:
        "snapshot item prices sum to zero but Stripe charged a positive amount",
    });
  }

  const allocations = allocateBundleRevenue(items, amountCents);

  let bundleWriteFailed = false;

  for (const item of items) {
    // A retry (Stripe redelivering this same event after an earlier
    // partial failure, or a second concurrent delivery) must never
    // clear a refunded_at that was legitimately set on this row in the
    // meantime -- distinct from a genuine NEW purchase of a book this
    // reader previously owned and had refunded, which correctly SHOULD
    // clear a stale refunded_at. The two are told apart by whether the
    // existing row (if any) already belongs to THIS checkout session:
    // same session id -> this row was already written by an earlier
    // delivery of this exact event, so it's left completely untouched,
    // refunded_at included. Different session id (or no row at all) ->
    // this is either the first write ever, or a separate, later
    // purchase superseding old history -- both correctly get a fresh
    // refunded_at: null, exactly like every other purchase path in this
    // file already does.
    const { data: existing, error: existingError } = await supabase
      .from("purchases")
      .select("id, stripe_checkout_session_id")
      .eq("book_id", item.bookId)
      .eq("reader_id", snapshot.reader_id)
      .maybeSingle();

    if (existingError) {
      bundleWriteFailed = true;
      console.error("Stripe webhook: snapshot bundle purchase lookup failed", {
        eventId: event.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        snapshotId,
        bookId: item.bookId,
        readerId: snapshot.reader_id,
        error: existingError,
      });
      continue;
    }

    if (existing && existing.stripe_checkout_session_id === session.id) {
      continue;
    }

    const { error: purchaseError } = await supabase.from("purchases").upsert(
      {
        book_id: item.bookId,
        reader_id: snapshot.reader_id,
        stripe_checkout_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId,
        amount_cents: allocations.get(item.bookId) ?? 0,
        bundle_id: snapshot.bundle_id,
        refunded_at: null,
      },
      { onConflict: "book_id,reader_id" },
    );

    if (purchaseError) {
      bundleWriteFailed = true;
      console.error("Stripe webhook: snapshot bundle purchase upsert failed", {
        eventId: event.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        snapshotId,
        bookId: item.bookId,
        readerId: snapshot.reader_id,
        error: purchaseError,
      });
    }
  }

  if (bundleWriteFailed) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
    });
  }

  // Only now that every entitlement row for this snapshot exists does
  // this delivery attempt to claim fulfillment -- this WHERE clause is
  // what actually decides "did I win," not the earlier fulfilled_at
  // read above (which is only a fast-path optimization to skip
  // redundant upsert work on an obviously-already-done delivery).
  const { data: claimedRows, error: claimError } = await supabase
    .from("bundle_checkout_snapshots")
    .update({
      fulfilled_at: new Date().toISOString(),
      total_amount_cents: amountCents,
    })
    .eq("id", snapshotId)
    .is("fulfilled_at", null)
    .select("id");

  if (claimError) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      error: claimError,
    });
  }

  const wonClaim = (claimedRows?.length ?? 0) > 0;
  if (!wonClaim) {
    // A concurrent delivery already claimed fulfillment between this
    // request's snapshot read and this UPDATE -- the entitlement rows
    // this delivery just upserted are the same ones the winner already
    // wrote (idempotent, same deterministic allocation), so there's
    // nothing left to do.
    return null;
  }

  // Everything past this point is best-effort bookkeeping, not
  // entitlement -- purchases.book_id/reader_id's own FKs already
  // protect these books/this reader permanently, independent of
  // whether any of the following succeeds.
  const { error: reservationCleanupError } = await supabase
    .from("bundle_checkout_reservations")
    .delete()
    .eq("snapshot_id", snapshotId);
  if (reservationCleanupError) {
    console.error(
      "Stripe webhook: failed to clean up bundle reservations after fulfillment",
      { eventId: event.id, snapshotId, error: reservationCleanupError },
    );
  }

  const { error: holdCleanupError } = await supabase
    .from("bundle_checkout_reader_holds")
    .delete()
    .eq("snapshot_id", snapshotId);
  if (holdCleanupError) {
    console.error(
      "Stripe webhook: failed to clean up bundle reader hold after fulfillment",
      { eventId: event.id, snapshotId, error: holdCleanupError },
    );
  }

  if (
    snapshot.stripe_checkout_session_id &&
    snapshot.stripe_checkout_session_id !== session.id
  ) {
    // Two different Stripe sessions both referencing the same
    // snapshot_id should never happen -- the RPC generates a fresh
    // random id per call -- but this is exactly the kind of anomaly
    // worth surfacing loudly rather than silently overwriting whichever
    // session id happened to arrive first.
    console.error(
      "Stripe webhook: bundle snapshot already linked to a different checkout session -- not overwriting",
      {
        eventId: event.id,
        snapshotId,
        existingSessionId: snapshot.stripe_checkout_session_id,
        incomingSessionId: session.id,
      },
    );
  } else if (!snapshot.stripe_checkout_session_id) {
    const { error: linkBackError } = await supabase
      .from("bundle_checkout_snapshots")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", snapshotId);
    if (linkBackError) {
      console.error(
        "Stripe webhook: failed to link snapshot to its checkout session",
        { eventId: event.id, snapshotId, error: linkBackError },
      );
    }
  }

  await sendSnapshotBundlePurchaseEmails(supabase, {
    bundleId: snapshot.bundle_id,
    bundleTitle: snapshot.bundle_title,
    authorId: snapshot.author_id,
    readerId: snapshot.reader_id,
    amountCents,
  });

  return null;
}

// Stripe calls this URL directly (not a browser), so it must read the
// raw request body to verify the signature — no cookies/session involved.
export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // A failure here means Stripe was paid but Librum failed to persist the
  // entitlement/refund it's supposed to represent -- that must never be
  // acknowledged as a 2xx, or Stripe will never redeliver the event and
  // the gap becomes permanent and invisible. Returning 500 tells Stripe
  // to retry; the (book_id, reader_id) upsert and the refunded_at guard
  // below are both already safe to run again once the underlying failure
  // clears.
  const failWebhook = (context: Record<string, unknown>) => {
    console.error("Stripe webhook: critical entitlement write failed", context);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  };

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookId = session.metadata?.book_id;
    const bundleId = session.metadata?.bundle_id;
    const readerId = session.metadata?.reader_id;
    const snapshotId = session.metadata?.snapshot_id;
    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : null;
    const amountCents = session.amount_total ?? 0;

    // NEW bundle checkouts (created once buyBundle is updated to use
    // the migration-025 snapshot RPC) carry metadata.snapshot_id and
    // are fulfilled entirely from that durable, frozen row. Checkout
    // Sessions created before that change carry the LEGACY
    // metadata.bundle_id + reader_id shape instead, and must keep being
    // fulfilled by the unchanged branch below for as long as any of
    // them could still be open -- see the Phase 9B-2 rollout plan for
    // when that legacy branch can eventually be removed.
    if (snapshotId) {
      const supabase = createAdminClient();
      const failureResponse = await fulfillBundleSnapshot(
        supabase,
        event,
        session,
        snapshotId,
        paymentIntentId,
        amountCents,
        failWebhook,
      );
      if (failureResponse) {
        return failureResponse;
      }
    } else if (bundleId && readerId) {
      const supabase = createAdminClient();

      // A bundle checkout is one session that has to grant every book in
      // the bundle — each gets its own purchases row (so all the existing
      // per-book ownership/download/review logic keeps working
      // unmodified), with amount_cents split proportionally to that
      // book's own price so per-book revenue reporting stays meaningful.
      const { data: bundleBooks, error: bundleBooksError } = await supabase
        .from("bundle_books")
        .select("book_id, books(price_cents)")
        .eq("bundle_id", bundleId)
        .returns<{ book_id: string; books: { price_cents: number } | null }[]>();

      // This read is required to know which books to grant -- an empty
      // result from a FAILED read looks identical, in shape, to a
      // legitimately empty bundle unless the error itself is checked. If
      // this failed, there is no reliable list of books to upsert at
      // all, so the same "never acknowledge success over a failure to
      // persist the entitlement" rule applies here as it does to the
      // upserts themselves -- fail before attempting any write, rather
      // than silently proceeding as if the bundle had zero books.
      if (bundleBooksError) {
        return failWebhook({
          eventId: event.id,
          checkoutSessionId: session.id,
          paymentIntentId,
          bundleId,
          readerId,
          error: bundleBooksError,
        });
      }

      const items = bundleBooks ?? [];
      const totalOriginalCents = items.reduce(
        (sum, item) => sum + (item.books?.price_cents ?? 0),
        0,
      );

      // Every item is attempted regardless of an earlier failure in this
      // same delivery -- upserts are independent and idempotent, so
      // letting book B persist even if book A just failed means less
      // work is left for the eventual retry, not more. Any failure still
      // blocks emails and the 200 below.
      let bundleWriteFailed = false;

      for (const item of items) {
        const share =
          totalOriginalCents > 0
            ? Math.round((amountCents * (item.books?.price_cents ?? 0)) / totalOriginalCents)
            : Math.round(amountCents / items.length);

        const { error: purchaseError } = await supabase.from("purchases").upsert(
          {
            book_id: item.book_id,
            reader_id: readerId,
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: paymentIntentId,
            amount_cents: share,
            bundle_id: bundleId,
            refunded_at: null,
          },
          { onConflict: "book_id,reader_id" },
        );

        if (purchaseError) {
          bundleWriteFailed = true;
          console.error("Stripe webhook: bundle purchase upsert failed", {
            eventId: event.id,
            checkoutSessionId: session.id,
            paymentIntentId,
            bundleId,
            bookId: item.book_id,
            readerId,
            error: purchaseError,
          });
        }
      }

      if (bundleWriteFailed) {
        return failWebhook({
          eventId: event.id,
          checkoutSessionId: session.id,
          paymentIntentId,
          bundleId,
          readerId,
        });
      }

      await sendBundlePurchaseEmails(supabase, { bundleId, readerId, amountCents });
    } else if (bookId && readerId) {
      const supabase = createAdminClient();

      const { error: purchaseError } = await supabase.from("purchases").upsert(
        {
          book_id: bookId,
          reader_id: readerId,
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id: paymentIntentId,
          amount_cents: amountCents,
          discount_code_id: session.metadata?.discount_code_id ?? null,
          // Explicit, not just omitted: on a re-purchase after an earlier
          // refund, the unique(book_id, reader_id) constraint means this
          // upsert updates that same row — without resetting this, it'd
          // keep the stale refund timestamp from the previous purchase.
          refunded_at: null,
        },
        { onConflict: "book_id,reader_id" },
      );

      if (purchaseError) {
        return failWebhook({
          eventId: event.id,
          checkoutSessionId: session.id,
          paymentIntentId,
          bookId,
          readerId,
          error: purchaseError,
        });
      }

      await sendPurchaseEmails(supabase, { bookId, readerId, amountCents });
    }
  }

  // Revokes the reader's access. Only purchases made after
  // stripe_payment_intent_id started being recorded can be matched here —
  // see the note in migrations/011_add_refunds.sql.
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const paymentIntentId =
      typeof charge.payment_intent === "string" ? charge.payment_intent : null;

    if (paymentIntentId) {
      const supabase = createAdminClient();
      const { error: refundError } = await supabase
        .from("purchases")
        .update({ refunded_at: new Date().toISOString() })
        .eq("stripe_payment_intent_id", paymentIntentId)
        .is("refunded_at", null);

      if (refundError) {
        return failWebhook({
          eventId: event.id,
          paymentIntentId,
          error: refundError,
        });
      }
    }
  }

  return NextResponse.json({ received: true });
}
