import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  sendPurchaseEmails,
  sendBundlePurchaseEmails,
  sendSnapshotBundlePurchaseEmails,
} from "@/lib/email";

// Stripe's own type for both Checkout.Session.payment_intent and
// Charge.payment_intent is `string | Stripe.PaymentIntent | null` --
// which shape arrives depends on whether the object was expanded when
// fetched. Only the plain-string id case was previously handled here
// (an expanded object would have been silently treated as "missing"),
// which was harmless while a missing id was already tolerated
// everywhere it's used, but stops being harmless once the snapshot path
// starts REQUIRING a usable id for a paid transaction (see
// fulfillBundleSnapshot below). This never invents an id -- an object
// without a valid string `id` field still resolves to null, same as a
// bare null does.
function extractPaymentIntentId(
  paymentIntent: string | Stripe.PaymentIntent | null,
): string | null {
  if (typeof paymentIntent === "string") return paymentIntent;
  if (
    paymentIntent &&
    typeof paymentIntent === "object" &&
    typeof paymentIntent.id === "string"
  ) {
    return paymentIntent.id;
  }
  return null;
}

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

// Legacy-path counterpart to allocateBundleRevenue above, for bundle
// checkouts created before the migration-025 snapshot flow (metadata
// carries bundle_id + reader_id directly, not a snapshot_id). The
// original code here computed each item's share independently via
// Math.round(amountTotalCents * itemPrice / totalPrice), which is NOT
// guaranteed to sum to exactly amountTotalCents -- independent roundings
// can drift a cent in either direction depending on the exact inputs.
// Since this file is already being modified for the ownership-
// preservation fix below, this reuses the same floor-then-distribute-
// the-remainder technique as allocateBundleRevenue so retries of this
// path are exact and deterministic too. Ordered by book_id, not by any
// created_at/position column -- the query that produces `items` here
// has no ORDER BY and Postgres does not guarantee row order without
// one, so book_id (stable, always present) is the only value available
// to make the remainder-cent distribution reproducible identically
// across every retry of the same event.
function allocateLegacyBundleRevenue(
  items: { book_id: string; books: { price_cents: number } | null }[],
  amountTotalCents: number,
): Map<string, number> {
  const totalOriginalCents = items.reduce(
    (sum, item) => sum + (item.books?.price_cents ?? 0),
    0,
  );
  const orderedItems = [...items].sort((a, b) =>
    a.book_id < b.book_id ? -1 : a.book_id > b.book_id ? 1 : 0,
  );

  const shares = orderedItems.map((item) => {
    const exactShare =
      totalOriginalCents > 0
        ? (amountTotalCents * (item.books?.price_cents ?? 0)) / totalOriginalCents
        : amountTotalCents / orderedItems.length;
    return { bookId: item.book_id, amount: Math.floor(exactShare) };
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

  // A PAID snapshot transaction (amountCents > 0) must never be claimed
  // fulfilled without a usable Stripe payment intent id -- see migration
  // 027. bundle_checkout_snapshots is now this transaction's durable
  // payment record (independent of how many purchases rows, if any, it
  // produces), and a record with no payment intent can never be matched
  // by a later charge.refunded event -- exactly the accounting/refund
  // blind spot this fix exists to close. amountCents === 0 is exempt: a
  // genuinely free bundle never gets a Stripe PaymentIntent at all (Stripe
  // does not create one for a $0 total Checkout Session), so requiring
  // one here would make every free bundle unfulfillable.
  //
  // Placed here -- before the classification loop and before any
  // purchases write is even considered -- so that a missing payment
  // intent on a paid transaction fails this delivery before anything is
  // written, not after. Nothing above this point writes to purchases or
  // claims the snapshot, so this can never leave a partially-fulfilled
  // snapshot behind merely because of this check; a retry (once Stripe
  // resends an event carrying a resolvable payment intent, which for a
  // completed Checkout Session should always be the case) starts from
  // the same clean, unwritten state.
  if (amountCents > 0 && !paymentIntentId) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      reason:
        "paid snapshot checkout session has no usable Stripe payment intent id",
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

  // Classify every item's existing ownership BEFORE computing any
  // allocation or writing anything -- see the Phase 9B-2 bundle
  // fulfillment integrity audit. A prior version of this code
  // distinguished only "written by this same session" (leave alone)
  // from "everything else" (upsert fresh values) -- but "everything
  // else" wrongly included a book the reader already actively owns
  // through a completely unrelated transaction, and upserting into that
  // row silently overwrote its real purchase history (session, payment
  // intent, amount, bundle_id) with this bundle's values. The fix is
  // this three-way classification:
  //
  // - "same_session": already written by an earlier delivery of this
  //   exact event -- left untouched, exactly as before.
  // - "active_other_session": an existing, non-refunded row belonging
  //   to a DIFFERENT transaction -- the reader already owns this book
  //   for reasons that have nothing to do with this bundle checkout.
  //   Must be left completely untouched -- no field of that row may
  //   change -- and excluded entirely from this transaction's revenue
  //   allocation, since no new entitlement is being granted for it.
  // - "eligible": no existing row, or an existing row that's refunded
  //   (the reader does NOT currently own this book) -- gets a fresh
  //   write and is included in this transaction's allocation, exactly
  //   like every other purchase path in this file already does for a
  //   genuine new or renewed acquisition.
  //
  // Known, deliberately NOT addressed by this fix: because purchases has
  // unique(book_id, reader_id), a refunded row being reacquired here (a
  // "no existing row" or "refunded row" case above, both -> eligible)
  // upserts onto that SAME row rather than inserting a new one. The
  // original refunded acquisition's own transaction identity (its own
  // stripe_checkout_session_id/payment_intent/amount_cents) is
  // overwritten by the reacquisition -- there is no separate historical
  // record of the earlier, refunded purchase after this. This is an
  // existing architectural limitation of the one-row-per-(book,reader)
  // schema, not something introduced or fixed here; redesigning it is
  // out of scope for this correction.
  const classifications = new Map<
    string,
    "same_session" | "active_other_session" | "eligible"
  >();

  const existingAmountCentsByBookId = new Map<string, number>();

  for (const item of items) {
    const { data: existing, error: existingError } = await supabase
      .from("purchases")
      .select("stripe_checkout_session_id, refunded_at, amount_cents")
      .eq("book_id", item.bookId)
      .eq("reader_id", snapshot.reader_id)
      .maybeSingle();

    if (existingError) {
      // Allocation below depends on knowing every item's classification
      // up front -- proceeding with an unknown classification risks
      // either wrongly touching an active row or miscomputing the
      // split, so this fails the whole delivery here rather than
      // continuing with incomplete information. Nothing has been
      // written yet at this point, so this is fully retry-safe.
      return failWebhook({
        eventId: event.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        snapshotId,
        bookId: item.bookId,
        readerId: snapshot.reader_id,
        error: existingError,
      });
    }

    if (existing) {
      existingAmountCentsByBookId.set(item.bookId, existing.amount_cents);
    }

    if (existing && existing.stripe_checkout_session_id === session.id) {
      classifications.set(item.bookId, "same_session");
    } else if (existing && existing.refunded_at === null) {
      classifications.set(item.bookId, "active_other_session");
    } else {
      classifications.set(item.bookId, "eligible");
    }
  }

  const sameSessionItems = items.filter(
    (item) => classifications.get(item.bookId) === "same_session",
  );
  const eligibleItems = items.filter(
    (item) => classifications.get(item.bookId) === "eligible",
  );
  // active_other_session items are simply never referenced again below --
  // no array is needed for them, since "excluded from everything" is
  // exactly what not appearing in either array above already means.

  // SAME_SESSION rows are FIXED, already-committed amounts from an
  // earlier delivery of this exact event -- never recomputed, never
  // rewritten. alreadyAllocatedCents is the sum of what's already on
  // disk for them; remainingCents is what's left of THIS transaction's
  // charge to divide across whatever still needs a write. On a retry
  // following a partial failure (A written, B failed), this makes B
  // recover exactly its original share -- 599 - 349 = 250 -- without
  // ever touching A's committed 349, rather than re-deriving a fresh
  // ratio that could hand B the full 599 a second time.
  const alreadyAllocatedCents = sameSessionItems.reduce(
    (sum, item) => sum + (existingAmountCentsByBookId.get(item.bookId) ?? 0),
    0,
  );
  const remainingCents = amountCents - alreadyAllocatedCents;

  // Committed same_session amounts already exceeding what Stripe charged
  // for this transaction is not something any allocation choice here can
  // fix -- it means the amounts on disk are wrong by construction. Fail
  // loudly rather than deriving a nonsensical negative or zero-clamped
  // share for the remaining items.
  if (remainingCents < 0) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      snapshotId,
      reason:
        "already-committed same-session purchase amounts exceed this Stripe transaction's charged total",
      alreadyAllocatedCents,
      amountCents,
    });
  }

  if (eligibleItems.length === 0) {
    // Nothing left to write -- either every item was already actively
    // owned (alreadyAllocatedCents is 0, remainingCents === amountCents,
    // and that's fine: no revenue from THIS transaction was ever
    // claimed for any of them) or this is a full duplicate delivery
    // (every item is same_session). In the duplicate-delivery case,
    // remainingCents must be exactly 0 -- anything else means the
    // committed rows don't actually reconcile to what Stripe charged,
    // which must be surfaced, not silently tolerated as "already done."
    if (sameSessionItems.length > 0 && remainingCents !== 0) {
      return failWebhook({
        eventId: event.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        snapshotId,
        reason:
          "same-session purchase amounts do not reconcile to this Stripe transaction's charged total and there are no eligible items left to absorb the difference",
        alreadyAllocatedCents,
        amountCents,
      });
    }
  }

  let allocations = new Map<string, number>();

  if (eligibleItems.length > 0) {
    const eligibleFrozenPriceCents = eligibleItems.reduce(
      (sum, item) => sum + item.priceCentsAtCheckout,
      0,
    );

    // A positive remaining amount with nothing but zero-priced eligible
    // items to divide it across has no ratio to derive shares from --
    // treated as inconsistent commercial data rather than inventing an
    // allocation, same posture as every other allocation path in this
    // file. A remainingCents of 0 (see below) is unaffected either way.
    if (eligibleFrozenPriceCents === 0 && remainingCents > 0) {
      return failWebhook({
        eventId: event.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        snapshotId,
        reason:
          "eligible snapshot item prices sum to zero but a positive remaining amount must still be allocated",
      });
    }

    // Only the remaining, not-yet-committed amount is divided across
    // eligibleItems -- allocateBundleRevenue's floor+remainder-
    // distribution still guarantees this sums to EXACTLY remainingCents,
    // so alreadyAllocatedCents + sum(these shares) === amountCents
    // always holds. remainingCents === 0 here (all revenue already
    // committed to same_session rows, or a genuinely free bundle) is
    // handled without a special case: every eligible item's exact share
    // is 0 * price / total = 0, so each legitimately receives $0 --
    // correct entitlement (ownership is still granted) with correct
    // accounting (adds nothing to the sum).
    allocations = allocateBundleRevenue(eligibleItems, remainingCents);
  }

  let bundleWriteFailed = false;

  for (const item of eligibleItems) {
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
      stripe_payment_intent_id: paymentIntentId,
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
    const paymentIntentId = extractPaymentIntentId(session.payment_intent);
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

      // Same ownership-preservation fix as the snapshot-based path above
      // -- this legacy path upserts on the exact same (book_id,
      // reader_id) conflict target, so it has the identical exposure: a
      // book the reader already actively owns through an unrelated
      // transaction must never be touched or counted into this
      // transaction's allocation. See the Phase 9B-2 bundle fulfillment
      // integrity audit.
      const classifications = new Map<
        string,
        "same_session" | "active_other_session" | "eligible"
      >();
      const existingAmountCentsByBookId = new Map<string, number>();

      for (const item of items) {
        const { data: existing, error: existingError } = await supabase
          .from("purchases")
          .select("stripe_checkout_session_id, refunded_at, amount_cents")
          .eq("book_id", item.book_id)
          .eq("reader_id", readerId)
          .maybeSingle();

        if (existingError) {
          return failWebhook({
            eventId: event.id,
            checkoutSessionId: session.id,
            paymentIntentId,
            bundleId,
            readerId,
            bookId: item.book_id,
            error: existingError,
          });
        }

        if (existing) {
          existingAmountCentsByBookId.set(item.book_id, existing.amount_cents);
        }

        if (existing && existing.stripe_checkout_session_id === session.id) {
          classifications.set(item.book_id, "same_session");
        } else if (existing && existing.refunded_at === null) {
          classifications.set(item.book_id, "active_other_session");
        } else {
          classifications.set(item.book_id, "eligible");
        }
      }

      const sameSessionItems = items.filter(
        (item) => classifications.get(item.book_id) === "same_session",
      );
      const eligibleItems = items.filter(
        (item) => classifications.get(item.book_id) === "eligible",
      );
      // active_other_session items are simply never referenced again --
      // no array needed for them; not appearing in either array above
      // already means "excluded from everything."

      // Fixed-committed-amount model, identical to the snapshot path
      // above: sameSessionItems' existing amount_cents is authoritative
      // and is never recomputed or rewritten. Only the amount NOT yet
      // committed to a same-session row is divided across eligibleItems.
      const alreadyAllocatedCents = sameSessionItems.reduce(
        (sum, item) => sum + (existingAmountCentsByBookId.get(item.book_id) ?? 0),
        0,
      );
      const remainingCents = amountCents - alreadyAllocatedCents;

      if (remainingCents < 0) {
        return failWebhook({
          eventId: event.id,
          checkoutSessionId: session.id,
          paymentIntentId,
          bundleId,
          readerId,
          reason:
            "already-committed same-session purchase amounts exceed this Stripe transaction's charged total",
          alreadyAllocatedCents,
          amountCents,
        });
      }

      if (
        eligibleItems.length === 0 &&
        sameSessionItems.length > 0 &&
        remainingCents !== 0
      ) {
        return failWebhook({
          eventId: event.id,
          checkoutSessionId: session.id,
          paymentIntentId,
          bundleId,
          readerId,
          reason:
            "same-session purchase amounts do not reconcile to this Stripe transaction's charged total and there are no eligible items left to absorb the difference",
          alreadyAllocatedCents,
          amountCents,
        });
      }

      let allocations = new Map<string, number>();

      if (eligibleItems.length > 0) {
        const eligibleOriginalCents = eligibleItems.reduce(
          (sum, item) => sum + (item.books?.price_cents ?? 0),
          0,
        );

        if (eligibleOriginalCents === 0 && remainingCents > 0) {
          return failWebhook({
            eventId: event.id,
            checkoutSessionId: session.id,
            paymentIntentId,
            bundleId,
            readerId,
            reason:
              "eligible legacy bundle item prices sum to zero but a positive remaining amount must still be allocated",
          });
        }

        // Only the remaining, not-yet-committed amount is divided --
        // allocateLegacyBundleRevenue's floor+remainder-distribution
        // guarantees this sums to exactly remainingCents, so
        // alreadyAllocatedCents + sum(these shares) === amountCents.
        allocations = allocateLegacyBundleRevenue(eligibleItems, remainingCents);
      }

      // Every item is attempted regardless of an earlier failure in this
      // same delivery -- upserts are independent and idempotent, so
      // letting book B persist even if book A just failed means less
      // work is left for the eventual retry, not more. Any failure still
      // blocks emails and the 200 below.
      let bundleWriteFailed = false;

      for (const item of eligibleItems) {
        const { error: purchaseError } = await supabase.from("purchases").upsert(
          {
            book_id: item.book_id,
            reader_id: readerId,
            stripe_checkout_session_id: session.id,
            stripe_payment_intent_id: paymentIntentId,
            amount_cents: allocations.get(item.book_id) ?? 0,
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
    const paymentIntentId = extractPaymentIntentId(charge.payment_intent);

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

      // Snapshot-level counterpart to the purchases update above -- see
      // migration 027. A snapshot bundle transaction where every item was
      // already actively owned through some unrelated purchase writes
      // ZERO purchases rows (see fulfillBundleSnapshot's zero-eligible
      // handling), so it has no row the update above could ever match --
      // without this, that payment's later refund would be entirely
      // unrepresented in Librum. Run unconditionally alongside the
      // purchases update (not only when it matched zero rows): a normal
      // bundle payment's snapshot also carries this same payment_intent,
      // and marking it refunded too keeps the transaction-level record
      // consistent with the entitlement-level one it fulfilled.
      //
      // Independently idempotent, same as the purchases update: its own
      // `refunded_at is null` guard means a duplicate delivery of this
      // event matches zero rows here, a clean no-op. If this update
      // errors after the purchases update already succeeded, failing the
      // whole delivery (rather than returning 200) is deliberate -- a
      // retry safely completes just this remaining half, since the
      // purchases update above is itself a no-op on that retry (already
      // refunded). Never silently acknowledge a refund event that only
      // partially persisted.
      const { error: snapshotRefundError } = await supabase
        .from("bundle_checkout_snapshots")
        .update({ refunded_at: new Date().toISOString() })
        .eq("stripe_payment_intent_id", paymentIntentId)
        .is("refunded_at", null);

      if (snapshotRefundError) {
        return failWebhook({
          eventId: event.id,
          paymentIntentId,
          error: snapshotRefundError,
        });
      }
    }
  }

  return NextResponse.json({ received: true });
}
