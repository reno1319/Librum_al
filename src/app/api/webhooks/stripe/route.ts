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
// Exported (only) so the transaction-integrity test suite
// (src/app/api/webhooks/stripe/route.test.ts) can drive this function
// directly with a fake Supabase client and assert its classification/
// allocation/idempotency behavior in isolation -- POST() remains the
// actual route handler and is not itself exported or changed.
export async function fulfillBundleSnapshot(
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

  // LAUNCH-1 P1-7A: dispute-before-fulfillment guarantee for the bundle
  // path. Scoped identically to every other lookup in this function --
  // by stripe_payment_intent_id alone -- and skipped entirely when
  // there is no payment intent to check (a genuinely free, $0 bundle:
  // no real charge, so no dispute can exist against it). Mirrors
  // finalize_book_checkout_intent's own guard (migration 035): a
  // dispute already reached 'lost' for this exact payment intent must
  // block entitlement from being granted at all.
  if (paymentIntentId) {
    const { data: lostDispute, error: disputeCheckError } = await supabase
      .from("payment_disputes")
      .select("id")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .eq("status", "lost")
      .maybeSingle();

    if (disputeCheckError) {
      return failWebhook({
        eventId: event.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        snapshotId,
        error: disputeCheckError,
      });
    }

    if (lostDispute) {
      // Not retried -- Stripe redelivering this exact event will never
      // produce a different outcome, since the dispute is already
      // durably lost. Logged for manual reconciliation instead, the
      // same posture fulfillSingleBookPurchase already uses for its own
      // non-retryable blocked outcomes (see 'blocked_disputed_lost'
      // below). Nothing is written: no purchases rows, and the snapshot
      // itself is left completely unclaimed (fulfilled_at stays null)
      // so it remains visible as "paid but not fulfilled" to any future
      // reconciliation query.
      console.error(
        "Stripe webhook: bundle snapshot checkout paid but blocked by an already-lost dispute -- needs manual reconciliation",
        { eventId: event.id, checkoutSessionId: session.id, paymentIntentId, snapshotId },
      );
      return null;
    }
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
  //
  // LAUNCH-1 P1-7A correction: "active_other_session" originally meant
  // only "an existing, non-refunded row" -- but a lost-disputed
  // purchase is ALSO non-refunded (a dispute never sets refunded_at).
  // Left uncorrected, a reader who legitimately buys this exact book
  // again via a bundle, after an earlier lost dispute on it, would have
  // that old row classified active_other_session -- excluded from this
  // transaction's allocation and left untouched -- so they'd pay for
  // the bundle (including this book) and still end up not owning it:
  // the same "charged without entitlement" failure class the dispute-
  // tracking work exists to prevent. A row is now only "active" if it
  // is neither refunded NOR disputed-lost; this mirrors the exact same
  // correction made to finalize_book_checkout_intent's own
  // active_other_session check (migration 035) and to user_owns_book()
  // itself.
  const classifications = new Map<
    string,
    "same_session" | "active_other_session" | "eligible"
  >();

  const existingAmountCentsByBookId = new Map<string, number>();

  for (const item of items) {
    const { data: existing, error: existingError } = await supabase
      .from("purchases")
      .select("stripe_checkout_session_id, stripe_payment_intent_id, refunded_at, amount_cents")
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
      let hasLostDispute = false;
      if (existing.stripe_payment_intent_id) {
        const { data: lostDispute, error: disputeCheckError } = await supabase
          .from("payment_disputes")
          .select("id")
          .eq("stripe_payment_intent_id", existing.stripe_payment_intent_id)
          .eq("status", "lost")
          .maybeSingle();

        if (disputeCheckError) {
          return failWebhook({
            eventId: event.id,
            checkoutSessionId: session.id,
            paymentIntentId,
            snapshotId,
            bookId: item.bookId,
            readerId: snapshot.reader_id,
            error: disputeCheckError,
          });
        }
        hasLostDispute = !!lostDispute;
      }
      classifications.set(item.bookId, hasLostDispute ? "eligible" : "active_other_session");
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

// Fulfills a LEGACY-shape bundle checkout (metadata.bundle_id +
// metadata.reader_id, no snapshot_id) -- the pre-migration-025 checkout
// shape, kept only for as long as any Checkout Session created before
// that rollout could still be open. See the Phase 9B-2 rollout plan for
// when this branch can eventually be removed. Structurally the same
// three-way same_session/active_other_session/eligible classification
// and proportional-allocation logic as fulfillBundleSnapshot above,
// just reading the bundle's book list live from bundle_books/books
// instead of from a frozen snapshot row (this legacy shape predates
// bundle_checkout_snapshots existing at all). Returns a NextResponse if
// the request should end early (a failure), or null to let the caller
// fall through to the normal `{ received: true }` response.
// Exported (only) so route.test.ts can drive this function directly with
// a fake Supabase client, the same spirit as fulfillBundleSnapshot's own
// test coverage -- POST() remains the actual route handler and is not
// itself exported or changed.
export async function fulfillLegacyBundle(
  supabase: ReturnType<typeof createAdminClient>,
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  bundleId: string,
  readerId: string,
  paymentIntentId: string | null,
  amountCents: number,
  failWebhook: (context: Record<string, unknown>) => NextResponse,
): Promise<NextResponse | null> {
  // LAUNCH-1 P1-7A: dispute-before-fulfillment guarantee for the LEGACY
  // bundle path -- mirrors fulfillBundleSnapshot's own guard above (see
  // "dispute-before-fulfillment guarantee for the bundle path" in that
  // function). Scoped identically: by this transaction's own
  // stripe_payment_intent_id alone, and skipped entirely when there is
  // no payment intent (a genuinely free, $0 bundle never gets a Stripe
  // PaymentIntent, so no dispute can exist against it). Placed before
  // the bundle's book list is even read, so nothing below this point --
  // the classification loop, any purchases write, the confirmation
  // email -- ever runs for a delivery blocked here.
  if (paymentIntentId) {
    const { data: lostDispute, error: disputeCheckError } = await supabase
      .from("payment_disputes")
      .select("id")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .eq("status", "lost")
      .maybeSingle();

    if (disputeCheckError) {
      return failWebhook({
        eventId: event.id,
        checkoutSessionId: session.id,
        paymentIntentId,
        bundleId,
        readerId,
        error: disputeCheckError,
      });
    }

    if (lostDispute) {
      // Not retried -- Stripe redelivering this exact event will never
      // produce a different outcome, since the dispute is already
      // durably lost. Logged for manual reconciliation instead, the
      // same posture fulfillBundleSnapshot and fulfillSingleBookPurchase
      // both already use for their own non-retryable blocked outcomes.
      // Nothing is written: no purchases rows for any book in the
      // bundle, and no confirmation email is sent.
      console.error(
        "Stripe webhook: legacy bundle checkout paid but blocked by an already-lost dispute -- needs manual reconciliation",
        {
          eventId: event.id,
          checkoutSessionId: session.id,
          paymentIntentId,
          bundleId,
          readerId,
        },
      );
      return null;
    }
  }

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
  //
  // LAUNCH-1 P1-7A correction: same fix as fulfillBundleSnapshot
  // above -- "active_other_session" must not match a row whose own
  // payment intent is disputed-lost (a dispute never sets
  // refunded_at), or a legitimate repurchase via this legacy path
  // would leave the reader having paid again with no entitlement.
  const classifications = new Map<
    string,
    "same_session" | "active_other_session" | "eligible"
  >();
  const existingAmountCentsByBookId = new Map<string, number>();

  for (const item of items) {
    const { data: existing, error: existingError } = await supabase
      .from("purchases")
      .select("stripe_checkout_session_id, stripe_payment_intent_id, refunded_at, amount_cents")
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
      let hasLostDispute = false;
      if (existing.stripe_payment_intent_id) {
        const { data: lostDispute, error: disputeCheckError } = await supabase
          .from("payment_disputes")
          .select("id")
          .eq("stripe_payment_intent_id", existing.stripe_payment_intent_id)
          .eq("status", "lost")
          .maybeSingle();

        if (disputeCheckError) {
          return failWebhook({
            eventId: event.id,
            checkoutSessionId: session.id,
            paymentIntentId,
            bundleId,
            readerId,
            bookId: item.book_id,
            error: disputeCheckError,
          });
        }
        hasLostDispute = !!lostDispute;
      }
      classifications.set(item.book_id, hasLostDispute ? "eligible" : "active_other_session");
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
  return null;
}

// Fulfills a single-book checkout (checkout.session.completed with
// metadata.intent_id, no snapshot/bundle). LAUNCH-1 P1-4: a thin wrapper
// around finalize_book_checkout_intent (migration 032), a SECURITY
// DEFINER RPC that does the classification, the purchases write, and the
// intent's own state transition as ONE atomic, advisory-lock-serialized
// Postgres transaction -- moved there deliberately, not left as
// separate read/classify/write steps from Node. Two truly concurrent
// webhook deliveries for two DIFFERENT, both-genuinely-paid intents of
// the same reader/book could otherwise both read purchases before either
// had written anything, both decide "eligible," and race to overwrite
// each other with neither ever being durably recorded as the loser --
// exactly the defect class this whole design exists to prevent, just
// relocated from buyBook to the webhook. See finalize_book_checkout_intent's
// own extensive comment in migration 032 for the full concurrency
// argument and its two independent locks (a row lock on the intent
// itself, plus the same (reader_id, book_id) advisory-lock namespace
// create_book_checkout_intent uses).
//
// metadata.intent_id (present in the Stripe session's own metadata since
// the moment buyBook created it) is sufficient on its own for this
// function to resolve and fulfill the purchase -- nothing here depends
// on book_checkout_intents.stripe_checkout_session_id (the buyBook
// link-back column) ever having been successfully written.
//
// Exported (only) so route.test.ts can drive this function directly with
// a mocked RPC call, the same spirit as fulfillBundleSnapshot's own fake
// Supabase client, without needing to fake finalize_book_checkout_intent's
// own SQL logic in TypeScript (there is nothing left to fake -- that
// logic no longer exists in TypeScript at all; see the committed SQL
// regression suite in supabase/tests/ for that).
export async function fulfillSingleBookPurchase(
  supabase: ReturnType<typeof createAdminClient>,
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  intentId: string,
  paymentIntentId: string | null,
  amountCents: number,
  failWebhook: (context: Record<string, unknown>) => NextResponse,
): Promise<NextResponse | null> {
  const { data: rows, error } = await supabase.rpc("finalize_book_checkout_intent", {
    p_intent_id: intentId,
    p_stripe_checkout_session_id: session.id,
    p_stripe_payment_intent_id: paymentIntentId,
    p_amount_cents: amountCents,
  });

  if (error) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      intentId,
      error,
    });
  }

  const result = (
    rows as { outcome: string; out_book_id: string | null; out_reader_id: string | null }[] | null
  )?.[0];

  if (!result) {
    return failWebhook({
      eventId: event.id,
      checkoutSessionId: session.id,
      paymentIntentId,
      intentId,
      error: "finalize_book_checkout_intent returned no row",
    });
  }

  const { outcome, out_book_id: bookId, out_reader_id: readerId } = result;

  if (outcome === "eligible_fulfilled" && bookId && readerId) {
    await sendPurchaseEmails(supabase, { bookId, readerId, amountCents });
    return null;
  }

  if (
    outcome === "active_other_session" ||
    outcome === "blocked_book_or_reader_deleted" ||
    outcome === "blocked_disputed_lost"
  ) {
    // The DB row is the durable record either way (see this migration's
    // own reconciliation query) -- this is immediate ops visibility, not
    // the source of truth.
    console.error(
      "Stripe webhook: single-book checkout paid but not fulfilled -- needs manual reconciliation",
      { eventId: event.id, checkoutSessionId: session.id, paymentIntentId, intentId, outcome },
    );
    return null;
  }

  // 'already_finalized' -- a duplicate delivery of an event already
  // settled by an earlier call. Complete no-op.
  return null;
}

// Fulfills a Stripe-confirmed FULL refund (charge.refunded) against
// every table that tracks refund state for the given PaymentIntent.
// Scoped ENTIRELY by stripe_payment_intent_id -- never reads or trusts
// anything else about which books/reader/amount are involved beyond
// what Stripe's own charge object already resolved to this id.
//
// isFullyRefunded is the caller's one required piece of authoritative
// refund data, and it is checked FIRST, before anything else. Originally
// (REFUND-1B Step 4) every call site passed Stripe.Charge.refunded
// straight through, on the reasoning that it's Stripe's own cumulative
// "fully refunded by amount" computation and therefore safer than
// re-deriving `amount_refunded >= amount` by hand. A later audit
// (REFUND-1B Step 5, second correction) found that reasoning necessary
// but not sufficient: `charge.refunded` alone says nothing about whether
// the refund(s) behind that amount have actually reached a terminal
// *successful* Stripe state (Refund.status can be `pending` or
// `requires_action`, not just `succeeded`/`failed`/`canceled` -- see
// isChargeFullyRefundedBySucceededRefunds's own documentation above for
// the full citation trail). Every call site into this function now
// passes the result of that stricter check instead of `charge.refunded`
// directly -- isFullyRefunded here means "Stripe confirms this charge is
// cumulatively fully refunded, entirely by refunds that have themselves
// reached `succeeded`," not merely "the amounts add up." This function's
// own logic is unchanged either way: it still just trusts whatever
// boolean its caller derived, first, before any write.
//
// Librum has no partial-refund concept anywhere in its design (see the
// approved Phase REFUND-1B decisions) -- a partial refund is therefore
// a deliberate, successful no-op here: none of purchases/
// bundle_checkout_snapshots/refund_requests are touched, entitlement is
// left completely alone, and the webhook still returns success (never
// failed merely because Librum doesn't yet model partial state).
//
// Cumulative partial refunds resolve correctly with no extra tracking:
// Stripe's `refunded` boolean on each charge.refunded delivery already
// reflects the charge's current CUMULATIVE state, not a delta for that
// one event -- so an early partial delivery no-ops here, and whichever
// later delivery finally reports the charge as fully refunded (because
// the cumulative amount_refunded has reached amount) runs the full
// three-table transition below, exactly once, via the same idempotency
// guards already in place for duplicate deliveries of that same
// fully-refunded state.
//
// Three independent, sequential updates once isFullyRefunded is true,
// none of which read from or depend on the others' outcome or row
// count:
//   1. purchases.refunded_at -- entitlement revocation (unchanged from
//      before this function existed).
//   2. bundle_checkout_snapshots.refunded_at -- transaction-level
//      record, needed because a zero-eligible-item bundle snapshot (see
//      fulfillBundleSnapshot above) can have no purchases row for this
//      payment intent at all (unchanged from before this function
//      existed; see migration 027).
//   3. refund_requests.status/refunded_at -- Phase REFUND-1B Step 4:
//      syncs Librum's own refund-request record (if one happens to
//      exist for this payment intent) to what Stripe has already
//      confirmed. New in this phase.
//
// Ordering: entitlement/transaction truth (1, 2) is written before the
// refund-request housekeeping record (3) that merely reports on it --
// on a partial failure, this means refund_requests.status = 'refunded'
// can never be observed before purchases/snapshot themselves already
// reflect the refund, never the other way around. This ordering is not
// required for eventual correctness (each step's own idempotency guard
// makes every step safe to retry regardless of which others already
// completed -- see below), but it's the more defensible invariant to
// hold when there's no other reason to pick an order, so it's kept
// consistent with how (2) was already ordered after (1) before this
// phase.
//
// Retry-safety: this is NOT one atomic transaction across the three
// Supabase calls -- a real failure between any two of them is possible.
// Each step is independently idempotent (its own WHERE clause only ever
// matches a row still in a "not yet refunded" state), so no matter which
// prior step(s) already committed before a later one fails and this
// function returns a failure response (Stripe redelivers the event):
//   - already-completed steps re-run as clean no-ops (their guard now
//     matches zero rows) -- purchases: `is("refunded_at", null)`;
//     snapshot: `is("refunded_at", null)`; refund_requests:
//     `in("status", ["requested", "approved"])`.
//   - the step that failed (or never got attempted before an earlier
//     one failed) reruns as a real, first-time write.
// The system therefore converges to full consistency after enough
// retries, regardless of exactly where a prior delivery's transient
// failure landed.
//
// refund_requests.status is only ever written here for a row still in
// 'requested' or 'approved' -- migration 029's own partial unique index
// (`unique ... where status in ('requested','approved')`) guarantees at
// most one such row can exist per payment intent, so this can never
// touch more than one row, and a 'cancelled'/'rejected' row (a
// different, terminal state) is never matched or touched by this
// update. A payment intent with no refund_requests row at all (the
// refund predates the request system, or was made directly in Stripe
// without ever going through a reader/admin request) matches zero rows
// here -- a successful no-op, not an error; the entitlement writes above
// are completely unaffected by whether a request row exists.
//
// Deliberately mirrors ONLY status and refunded_at -- reviewed_at,
// reviewed_by, and admin_notes are never touched here. A request that
// was still 'requested' (an operator refunded directly in Stripe
// without ever using the admin approve flow) ends up 'refunded' with
// reviewed_at/reviewed_by still null -- a legitimate, expected state,
// not a data gap: nothing in this app's UI (Step 2/3) requires a
// reviewed_at to correctly hide the Request/Cancel/Approve/Reject
// controls once status = 'refunded' (see deriveTransactionRefundState
// and canReview, both of which key off status alone).
//
// Exported (only) for the same reason as fulfillBundleSnapshot above:
// direct testability with a fake Supabase client
// (src/app/api/webhooks/stripe/route.test.ts). POST() remains the
// actual route handler and is not itself exported or changed beyond
// calling this function.
export async function processChargeRefund(
  supabase: ReturnType<typeof createAdminClient>,
  event: Stripe.Event,
  paymentIntentId: string,
  isFullyRefunded: boolean,
  failWebhook: (context: Record<string, unknown>) => NextResponse,
): Promise<NextResponse | null> {
  if (!isFullyRefunded) {
    console.warn(
      "Stripe webhook: charge.refunded event is a partial refund -- skipping full-refund processing",
      { eventId: event.id, paymentIntentId },
    );
    return null;
  }

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

  const { error: refundRequestError } = await supabase
    .from("refund_requests")
    .update({ status: "refunded", refunded_at: new Date().toISOString() })
    .eq("stripe_payment_intent_id", paymentIntentId)
    .in("status", ["requested", "approved"]);

  if (refundRequestError) {
    return failWebhook({
      eventId: event.id,
      paymentIntentId,
      error: refundRequestError,
    });
  }

  return null;
}

// REFUND-1B Step 5 correction: closes a gap the original charge.refunded-
// only design left completely unhandled. Confirmed against the installed
// stripe@22.5.0 SDK's own types (node_modules/stripe/cjs/resources/
// Refunds.d.ts): Refund.status is `pending | requires_action | succeeded |
// failed | canceled`, RefundResource.cancel()'s own doc comment ("Cancels
// a refund with a status of requires_action... only refunds for payment
// methods that require customer action can enter the requires_action
// state") proves requires_action is a real, reachable non-terminal return
// value from refunds.create() -- the SDK's create() doc comment only
// documents throwing for an already-fully-refunded charge or an
// over-large amount, never for a refund that will settle asynchronously.
// Refund.pending_reason and Refund.failure_reason/failure_balance_transaction
// exist specifically to describe those non-immediate-success outcomes.
//
// Before this correction, this webhook handled ONLY checkout.session.
// completed and charge.refunded -- refund.created/refund.updated/
// refund.failed were not handled at all. That is an unconditional gap
// regardless of any timing question about charge.refunded specifically: a
// refund that is created in `pending` or `requires_action` and settles to
// `succeeded` later had NO code path here that could ever finalize it,
// since nothing re-checked it after the fact. This function closes that
// gap by reacting directly to the Refund object's own lifecycle events.
//
// Additive alongside charge.refunded, not a replacement for it: a direct
// Stripe Dashboard refund, and the common synchronously-completing
// card-refund case, both still fire charge.refunded (or a refund.
// created/updated event with status already 'succeeded', or both) --
// Stripe's events carry no "who/what triggered this" distinction Librum
// could depend on instead, so both remain live triggers. What changed in
// a SECOND correction (below, and in POST()'s charge.refunded branch):
// charge.refunded is no longer an independent authority that can finalize
// on its own cumulative-amount boolean alone -- it now goes through the
// exact same isChargeFullyRefundedBySucceededRefunds gate this function
// uses, before either is allowed to call processChargeRefund. Both event
// families converge on the same, unchanged, already-idempotent
// processChargeRefund -- no new Librum-side state machine or rollback
// semantics were introduced (a refund.failed delivery is logged for
// operator visibility only; it never attempts to reverse a prior
// finalization, since nothing here can prove that's ever actually
// reachable in practice for a fully-settled card refund, and inventing
// that machinery speculatively would be a materially larger change than
// this gap warrants).
//
// Only proceeds once refund.status === 'succeeded' -- pending and
// requires_action both no-op here by design (a later refund.updated
// delivery, once the refund actually settles, is what completes it).
// 'failed'/'canceled' are handled by the sibling refund.failed branch in
// POST() (log-only, see there). A single refund reaching 'succeeded' is
// NOT by itself proof the full transaction is refunded -- Librum only
// ever finalizes a FULL refund, and a charge can have multiple partial
// refunds -- so this retrieves the charge fresh from Stripe and runs
// isChargeFullyRefundedBySucceededRefunds (see its own documentation
// above) before calling processChargeRefund. This mirrors the
// user-specified preferred design: inspect Refund.status, proceed only
// on succeeded, verify the cumulative charge is fully refunded BY
// terminal-successful refunds specifically, then run the existing
// three-table finalization unchanged.
function extractChargeId(charge: string | Stripe.Charge | null): string | null {
  if (typeof charge === "string") return charge;
  if (charge && typeof charge === "object" && typeof charge.id === "string") {
    return charge.id;
  }
  return null;
}

type StripeRefundVerificationClient = Pick<Stripe, "charges" | "refunds">;

// REFUND-1B Step 5, second correction: closes the gap the first
// correction left open. The first correction added refund.updated/
// refund.created handling gated on Refund.status === 'succeeded', but
// left the PRE-EXISTING charge.refunded branch calling
// processChargeRefund directly off `charge.refunded === true` alone --
// meaning that branch could still independently finalize Librum without
// ever confirming a Refund actually reached a terminal successful state.
// The invariant "Librum finalizes only after a terminal successful
// Stripe Refund" was therefore not enforced globally: the new, careful
// path could be bypassed entirely by the old one. This function is now
// the SOLE gate both `charge.refunded` and `refund.updated`/
// `refund.created` go through before either is allowed to call
// processChargeRefund -- see both call sites in POST() and in
// processRefundLifecycleEvent below.
//
// Re-audited what data charge.refunded/a Charge object actually expose
// (installed stripe@22.5.0 SDK, node_modules/stripe/cjs/resources/
// Charges.d.ts): `Charge.refunds?: ApiList<Refund> | null` -- "A list of
// refunds that have been applied to the charge" -- and
// RefundResource.list()'s own doc comment confirms "The 10 most recent
// refunds are always available by default on the Charge object."
// Rather than rely on that embedded, capped-at-10, possibly-stale
// snapshot, this calls `stripe.refunds.list({ charge })` directly --
// RefundListParams.charge?: string is a confirmed, real filter on the
// Refunds resource -- to get Stripe's own live, complete, paginated view
// of every refund on this charge, at the moment this event is processed.
//
// The invariant enforced is a single, self-contained condition that
// implies BOTH of the two the user asked for at once, rather than
// combining two separately-checked booleans (which could accidentally
// both be true without either one actually proving the full amount was
// returned by SUCCEEDED refunds specifically): sum the `amount` of every
// refund on this charge whose `status === 'succeeded'`, and require that
// sum to reach the charge's own `amount`. This depends on nothing but
// directly-typed, unambiguous fields (`Refund.status`, `Refund.amount`,
// `Charge.amount`) and sidesteps entirely the one question this audit
// could not resolve via the installed SDK or official docs (blocked by
// this environment's network egress proxy) -- whether `Charge.refunded`/
// `amount_refunded` themselves are gated on refund success or merely on
// refund creation. It does not matter here: only succeeded refunds are
// ever counted.
//
// Capped at 100 refunds (Stripe's own list max) via autoPagingToArray --
// Librum's product has no partial-refund concept of its own, so a real
// charge here will essentially always have a small handful of refunds at
// most; 100 is a generous, defensive ceiling against an unbounded loop,
// not a limit expected to ever bind in practice.
async function isChargeFullyRefundedBySucceededRefunds(
  stripeClient: StripeRefundVerificationClient,
  chargeId: string,
  chargeAmount: number,
): Promise<boolean> {
  const refunds = await stripeClient.refunds
    .list({ charge: chargeId, limit: 100 })
    .autoPagingToArray({ limit: 100 });

  const succeededTotal = refunds
    .filter((refund) => refund.status === "succeeded")
    .reduce((sum, refund) => sum + refund.amount, 0);

  return succeededTotal >= chargeAmount;
}

export async function processRefundLifecycleEvent(
  supabase: ReturnType<typeof createAdminClient>,
  stripeClient: StripeRefundVerificationClient,
  event: Stripe.Event,
  refund: Stripe.Refund,
  failWebhook: (context: Record<string, unknown>) => NextResponse,
): Promise<NextResponse | null> {
  if (refund.status !== "succeeded") {
    return null;
  }

  const chargeId = extractChargeId(refund.charge);

  if (!chargeId) {
    // No resolvable charge id on a succeeded refund shouldn't normally
    // happen for a card-based Checkout charge, but there is nothing
    // actionable to do here without one -- the charge.refunded path
    // remains a second, independent trigger for this same transaction if
    // it really is a full refund. Logged, not failed: retrying this same
    // event will never produce a different charge id.
    console.warn(
      "Stripe webhook: succeeded refund has no resolvable charge id -- skipping cumulative-refund verification",
      { eventId: event.id, refundId: refund.id },
    );
    return null;
  }

  let charge: Stripe.Charge;
  try {
    charge = await stripeClient.charges.retrieve(chargeId);
  } catch (error) {
    return failWebhook({
      eventId: event.id,
      refundId: refund.id,
      chargeId,
      reason: "failed to retrieve charge to verify cumulative refund state",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let fullyRefundedBySucceeded: boolean;
  try {
    fullyRefundedBySucceeded = await isChargeFullyRefundedBySucceededRefunds(
      stripeClient,
      chargeId,
      charge.amount,
    );
  } catch (error) {
    return failWebhook({
      eventId: event.id,
      refundId: refund.id,
      chargeId,
      reason: "failed to list refunds to verify terminal-success state",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!fullyRefundedBySucceeded) {
    // Either this refund is only a partial contribution (Librum has no
    // partial-refund concept -- same successful no-op posture as
    // processChargeRefund's own isFullyRefunded=false path), or Stripe's
    // own cumulative amount includes a refund that hasn't reached
    // 'succeeded' yet. Either way, a later refund.updated delivery (once
    // whatever's still settling actually does) re-runs this same check.
    return null;
  }

  const paymentIntentId =
    extractPaymentIntentId(refund.payment_intent) ?? extractPaymentIntentId(charge.payment_intent);

  if (!paymentIntentId) {
    return failWebhook({
      eventId: event.id,
      refundId: refund.id,
      chargeId,
      reason: "charge is fully refunded but no resolvable payment intent id was found",
    });
  }

  return processChargeRefund(supabase, event, paymentIntentId, true, failWebhook);
}

// REFUND-1B Step 5, second correction. Extracted out of POST() for the
// same reason as every other handler in this file (fulfillBundleSnapshot,
// processChargeRefund, processRefundLifecycleEvent): direct testability
// with fake Supabase/Stripe clients, no real HTTP request needed.
//
// This branch used to call processChargeRefund directly off
// `charge.refunded === true` -- Stripe's own cumulative "fully refunded
// by amount" boolean, with no check of whether the refund(s) behind that
// amount had actually reached a terminal successful state. That let this
// branch independently finalize Librum without ever confirming
// Refund.status, bypassing the exact invariant the refund.updated/
// refund.created path (processRefundLifecycleEvent) exists to enforce.
// It now goes through the SAME isChargeFullyRefundedBySucceededRefunds
// check as that path before ever calling processChargeRefund -- both
// event families are now equally strict, and neither can independently
// finalize on an unconfirmed/non-terminal refund. This keeps
// charge.refunded as a trigger (still fires for a direct Stripe
// Dashboard refund exactly like an API-initiated one), just no longer as
// an independent authority.
export async function processChargeRefundedEvent(
  supabase: ReturnType<typeof createAdminClient>,
  stripeClient: StripeRefundVerificationClient,
  event: Stripe.Event,
  charge: Stripe.Charge,
  failWebhook: (context: Record<string, unknown>) => NextResponse,
): Promise<NextResponse | null> {
  const paymentIntentId = extractPaymentIntentId(charge.payment_intent);

  if (!paymentIntentId) {
    return null;
  }

  let fullyRefundedBySucceeded: boolean;
  try {
    fullyRefundedBySucceeded = await isChargeFullyRefundedBySucceededRefunds(
      stripeClient,
      charge.id,
      charge.amount,
    );
  } catch (error) {
    return failWebhook({
      eventId: event.id,
      paymentIntentId,
      chargeId: charge.id,
      reason: "failed to list refunds to verify terminal-success state",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (!fullyRefundedBySucceeded) {
    // charge.refunded fired (Stripe's own cumulative-amount boolean),
    // but no refund on this charge has yet reached 'succeeded' for an
    // amount covering the full charge -- do not finalize. A later
    // refund.updated delivery, once the underlying refund actually
    // settles, re-runs this same verification (via
    // processRefundLifecycleEvent) and completes it then.
    console.warn(
      "Stripe webhook: charge.refunded received but no succeeded refunds yet cover the full charge amount -- awaiting terminal refund status",
      { eventId: event.id, paymentIntentId, chargeId: charge.id },
    );
    return null;
  }

  return processChargeRefund(supabase, event, paymentIntentId, true, failWebhook);
}

// LAUNCH-1 P1-8: widened from Pick<Stripe, "disputes"> to also cover
// "charges" and "transfers" -- the lost-dispute transfer-reversal
// recovery mechanism below needs to walk dispute -> charge -> transfer
// and to create/list transfer reversals, on top of the pre-existing
// dispute-status re-fetch.
type StripeDisputeVerificationClient = Pick<Stripe, "disputes" | "charges" | "transfers">;

// Every Dispute.status Stripe currently documents (installed
// stripe@22.5.0 SDK, node_modules/stripe/cjs/resources/Disputes.d.ts)
// -- used ONLY to decide whether to log an "unrecognized status"
// warning for operator investigation. Dispute.status is typed as an
// OPEN union (it includes `| OtherString`) precisely because Stripe can
// introduce new values -- this list is never used to gate any
// entitlement or fulfillment decision (user_owns_book(),
// finalize_book_checkout_intent, and the bundle guard below all test
// only `status === 'lost'` directly), so an unrecognized value here can
// never be silently misclassified as either safe or terminal.
// 'prevented' is included as a real, documented status (Stripe's own
// automatic dispute-prevention network programs) -- stored and logged
// like any other recognized value, never treated as equivalent to
// won/lost or given any invented terminal meaning (LAUNCH-1 P1-7A
// design decision: its exact real-world resolution semantics were not
// confirmed against Stripe's own docs in this environment -- network
// access to docs.stripe.com is blocked here).
const KNOWN_DISPUTE_STATUSES = new Set([
  "lost",
  "needs_response",
  "prevented",
  "under_review",
  "warning_closed",
  "warning_needs_response",
  "warning_under_review",
  "won",
]);

// LAUNCH-1 P1-7A: the sole write path for public.payment_disputes,
// Librum's sole authoritative record of Stripe dispute state -- see the
// P1-7A design audit for why this is NOT also denormalized onto
// purchases/bundle_checkout_snapshots. Handles all five
// charge.dispute.* event types identically (created, updated, closed,
// funds_withdrawn, funds_reinstated) -- each is just "something about
// this dispute changed, go re-sync it," so one function covers all
// five call sites in POST() below.
//
// Re-fetches the dispute LIVE via stripe.disputes.retrieve(), never
// trusts the event payload's own status as authoritative -- the same
// defensive posture already established for refunds
// (processRefundLifecycleEvent's own re-fetch-live-charge pattern).
// This is what makes duplicate delivery a clean no-op (re-writing
// identical values) and out-of-order delivery safe: a stale .updated
// arriving after .closed still re-fetches and re-writes Stripe's
// CURRENT state, so it can never regress a more-recent write -- there
// is no "trust whichever event arrived last" ordering dependency.
//
// Single-table upsert keyed on stripe_dispute_id (unique constraint) --
// Postgres's own ON CONFLICT ... DO UPDATE is natively atomic under
// concurrent/duplicate execution, so no advisory lock or RPC is needed
// here, unlike finalize_book_checkout_intent (which needs one because
// it performs a multi-table, row-locked transaction) -- this function
// performs exactly one table write.
//
// Exported (only) for the same reason as every other handler in this
// file: direct testability with fake Supabase/Stripe clients
// (src/app/api/webhooks/stripe/route.test.ts).
export async function processDisputeEvent(
  supabase: ReturnType<typeof createAdminClient>,
  stripeClient: StripeDisputeVerificationClient,
  event: Stripe.Event,
  disputeId: string,
  failWebhook: (context: Record<string, unknown>) => NextResponse,
): Promise<NextResponse | null> {
  let dispute: Stripe.Dispute;
  try {
    dispute = await stripeClient.disputes.retrieve(disputeId);
  } catch (error) {
    return failWebhook({
      eventId: event.id,
      disputeId,
      reason: "failed to retrieve live dispute state",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const paymentIntentId = extractPaymentIntentId(dispute.payment_intent);

  if (!paymentIntentId) {
    // No resolvable payment intent on a dispute shouldn't normally
    // happen for a card-based Checkout charge, but there is nothing
    // actionable to do without one -- retrying this same event will
    // never produce a different id. Logged, not failed.
    console.warn(
      "Stripe webhook: dispute has no resolvable payment intent id -- skipping",
      { eventId: event.id, disputeId },
    );
    return null;
  }

  if (!KNOWN_DISPUTE_STATUSES.has(dispute.status)) {
    console.error(
      "Stripe webhook: dispute has an unrecognized status -- stored verbatim, investigate",
      { eventId: event.id, disputeId, paymentIntentId, status: dispute.status },
    );
  }

  const { error } = await supabase.from("payment_disputes").upsert(
    {
      stripe_dispute_id: dispute.id,
      stripe_payment_intent_id: paymentIntentId,
      status: dispute.status,
      reason: dispute.reason,
      amount_cents: dispute.amount,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stripe_dispute_id" },
  );

  if (error) {
    return failWebhook({
      eventId: event.id,
      disputeId,
      paymentIntentId,
      error,
    });
  }

  // LAUNCH-1 P1-8: attempt author-transfer recovery only once this
  // event's own dispute-status upsert has committed -- the claim below
  // reads payment_disputes.status fresh, so it must never run against a
  // pre-upsert (possibly stale) row. Never gates the webhook's own
  // success/failure response: recording the dispute's status is this
  // handler's primary responsibility and has already succeeded above;
  // the recovery attempt is a separate, best-effort concern whose own
  // outcome (succeeded/failed/not-yet-claimable) is durably persisted on
  // payment_disputes itself, not surfaced as a webhook-level failure --
  // the same "entitlement/webhook success does not depend on reversal
  // success" invariant the Migration 036 design established for reader
  // entitlement, extended here to this handler's own return value.
  // Wrapped defensively: a bug in the recovery path must never take down
  // dispute-status recording, which is this function's actual contract.
  if (dispute.status === "lost") {
    try {
      await reverseAuthorTransferForLostDispute(supabase, stripeClient, dispute);
    } catch (recoveryError) {
      console.error(
        "Stripe webhook: lost-dispute transfer recovery threw unexpectedly -- needs manual reconciliation",
        { eventId: event.id, disputeId, paymentIntentId, error: recoveryError },
      );
    }
  }

  return null;
}

// ============================================================
// LAUNCH-1 P1-8: lost-dispute author-transfer recovery. Closes the P0
// finding from the P1-8 money-flow audit -- Librum's destination-charge
// model means Stripe debits a lost dispute's full amount (plus its own
// dispute fee) from Librum's PLATFORM balance, but never automatically
// claws back the matching share already transferred to the author's
// connected account at checkout time. See the three Migration 036
// design rounds for the full reasoning behind every decision below;
// summarized in each function's own comment only where needed.
//
// Approved policy: a reversal is attempted ONLY when a dispute's live
// status is exactly 'lost' -- never merely opened/under_review/etc, and
// a won dispute produces zero transfer movement. Application-fee refund
// policy on this reversal is left deliberately unset
// (refund_application_fee is never passed to createReversal()) -- a
// separate, undecided business-policy question, unchanged by this
// migration.
// ============================================================

const LOST_DISPUTE_RECOVERY_OPERATION = "lost_dispute_recovery";
const LOST_DISPUTE_RECOVERY_FORMULA_VERSION = "2";

// Deterministic idempotency key for a lost-dispute transfer-reversal
// attempt, mirroring buildRefundIdempotencyKey's own naming convention
// (src/app/admin/refunds/issue-refund.ts) but keyed off Librum's OWN
// row-locked-by-WHERE-clause attempt counter rather than a Stripe
// object id -- a rejected transfers.createReversal() call (e.g.
// insufficient connected-account balance) typically throws with no
// persisted TransferReversal object to chain a retry key off of, unlike
// a rejected refunds.create() call, which can still return a real
// Refund object with a terminal failed/canceled status. See the
// Migration 036 design report for the full asymmetry.
export function buildTransferReversalIdempotencyKey(
  disputeId: string,
  attemptCount: number,
): string {
  return `dispute-reversal-${disputeId}-attempt-${attemptCount}`;
}

type TransferReversalClaim = {
  attemptCount: number;
  existingTransferId: string | null;
  paymentIntentId: string;
};

// The sole DB-layer claim mechanism for a lost-dispute transfer-
// reversal attempt. A plain read (current status/attempt_count) then a
// conditional UPDATE re-checking `.eq("transfer_reversal_status",
// <the exact value just observed>)` -- this is a compare-and-swap via
// WHERE clause, not a dedicated PL/pgSQL RPC: Postgres always
// re-evaluates an UPDATE's WHERE clause against the row's CURRENT state
// at the moment it actually acquires the row lock, not against the
// client's possibly-stale read, so if a concurrent worker already
// claimed this row between our read and our write, our own UPDATE's
// WHERE no longer matches and we correctly get back zero rows -- the
// exact mechanism that makes overlapping claimants (a redelivered
// webhook racing the reconciliation route, or two overlapping
// reconciliation runs) safe with no distributed lock.
//
// staleAttemptingCutoff distinguishes the two legitimate claimants:
// - null (the webhook's own immediate path): matches only
//   'not_attempted' and 'failed' -- an 'attempting' row is left
//   strictly alone, since a concurrent delivery may still legitimately
//   be working on it and the webhook is never the recovery mechanism
//   for a stuck attempt.
// - a Date (the reconciliation route): additionally matches
//   'attempting' rows whose transfer_reversal_attempted_at is older
//   than the cutoff.
//
// attempt_count increments ONLY when entering 'attempting' from
// 'not_attempted' or 'failed' -- a stale-'attempting' re-claim leaves it
// untouched, so any retry that results reuses the exact same
// deterministic idempotency key as the original, possibly-still-
// in-flight attempt (buildTransferReversalIdempotencyKey above) -- a
// timeout alone can never mint a fresh key.
async function claimTransferReversalAttempt(
  supabase: ReturnType<typeof createAdminClient>,
  disputeId: string,
  staleAttemptingCutoff: Date | null,
): Promise<TransferReversalClaim | null> {
  const { data: current, error: readError } = await supabase
    .from("payment_disputes")
    .select(
      "status, transfer_reversal_status, transfer_reversal_attempt_count, transfer_reversal_attempted_at, stripe_transfer_id, stripe_payment_intent_id",
    )
    .eq("stripe_dispute_id", disputeId)
    .maybeSingle();

  if (readError || !current || current.status !== "lost") {
    return null;
  }

  const isStaleAttempting =
    staleAttemptingCutoff !== null &&
    current.transfer_reversal_status === "attempting" &&
    current.transfer_reversal_attempted_at !== null &&
    new Date(current.transfer_reversal_attempted_at) < staleAttemptingCutoff;

  const isClaimable =
    current.transfer_reversal_status === "not_attempted" ||
    current.transfer_reversal_status === "failed" ||
    isStaleAttempting;

  if (!isClaimable) {
    return null;
  }

  const nextAttemptCount = isStaleAttempting
    ? current.transfer_reversal_attempt_count
    : current.transfer_reversal_attempt_count + 1;

  const { data: claimed, error: claimError } = await supabase
    .from("payment_disputes")
    .update({
      transfer_reversal_status: "attempting",
      transfer_reversal_attempted_at: new Date().toISOString(),
      transfer_reversal_attempt_count: nextAttemptCount,
    })
    .eq("stripe_dispute_id", disputeId)
    .eq("transfer_reversal_status", current.transfer_reversal_status)
    .select("transfer_reversal_attempt_count, stripe_transfer_id, stripe_payment_intent_id")
    .maybeSingle();

  if (claimError || !claimed) {
    // Lost the race -- not an error, see this function's own
    // documentation above.
    return null;
  }

  return {
    attemptCount: claimed.transfer_reversal_attempt_count,
    existingTransferId: claimed.stripe_transfer_id,
    paymentIntentId: claimed.stripe_payment_intent_id,
  };
}

// Resolves the destination-charge Transfer that received the author's
// share of THIS dispute's charge. dispute.charge (not payment_intent.
// latest_charge) is used deliberately -- it is the exact,
// definitionally-unambiguous charge that was disputed, per Disputes.
// d.ts's own doc comment ("ID of the charge that's disputed"), with no
// "which charge" ambiguity a PaymentIntent's latest_charge could
// theoretically carry. Charge.transfer (Charges.d.ts: "ID of the
// transfer to the destination account... only applicable if the charge
// was created using the destination parameter") is exactly the
// destination-charge transfer id every checkout in this codebase
// produces (buyBook/buyBundle both set payment_intent_data.transfer_
// data.destination). Always re-resolved (even when stripe_transfer_id
// is already cached), since charge.amount is separately needed for the
// reversal-amount formula below and there is no cheaper way to get it
// alone -- a charge's own destination transfer id never changes once
// set, so re-deriving it here is always consistent with any cached
// value, never a source of drift.
async function resolveDisputeChargeAndTransfer(
  stripeClient: StripeDisputeVerificationClient,
  dispute: Stripe.Dispute,
): Promise<
  | { charge: Stripe.Charge; transferId: string; applicationFee: Stripe.ApplicationFee | null }
  | { error: string }
> {
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;

  let charge: Stripe.Charge;
  try {
    charge = await stripeClient.charges.retrieve(chargeId, {
      expand: ["transfer", "application_fee"],
    });
  } catch (error) {
    return {
      error: `failed to retrieve disputed charge: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const transferId =
    typeof charge.transfer === "string" ? charge.transfer : (charge.transfer?.id ?? null);

  if (!transferId) {
    return { error: "disputed charge has no destination transfer id" };
  }

  // The charge's application fee must resolve to a fully expanded object
  // whenever the charge claims one exists (application_fee_amount is a
  // genuine number) -- never silently treat an unexpanded id string, or
  // any other unusable shape, as "no fee refunded yet." A charge with no
  // fee at all (application_fee_amount null/absent) legitimately has no
  // ApplicationFee object either -- checked via typeof rather than
  // `!== null` so an absent field is never mistaken for "has a fee."
  let applicationFee: Stripe.ApplicationFee | null = null;
  if (typeof charge.application_fee_amount === "number") {
    if (!charge.application_fee || typeof charge.application_fee === "string") {
      return { error: "disputed charge has an application fee amount but no expanded application_fee object" };
    }
    applicationFee = charge.application_fee;
    const feeChargeId =
      typeof applicationFee.charge === "string" ? applicationFee.charge : applicationFee.charge?.id;
    if (feeChargeId !== charge.id) {
      return { error: "resolved application fee does not belong to the disputed charge" };
    }
  }

  return { charge, transferId, applicationFee };
}

// Identifies THIS Librum lost-dispute recovery's own TransferReversal,
// if one already exists on the transfer -- never "any reversal
// exists." Matched on metadata alone (librum_operation +
// stripe_dispute_id), which only a reversal Librum itself created via
// this same recovery mechanism ever carries -- a reversal caused by an
// admin refund's reverse_transfer:true was never created with this
// metadata (its own TransferReversal.source_refund would be set
// instead, and its metadata would be empty), so it can never be
// mistaken for a dispute-driven recovery, and a DIFFERENT dispute's
// reversal is excluded by the stripe_dispute_id match even in the
// structurally-impossible case of two disputes sharing a transfer.
// Lists Stripe's own live, complete, paginated reversal set
// (transfers.listReversals(), not the embedded, capped-at-10 Transfer.
// reversals snapshot), mirroring determineRefundAttempt's identical
// "always list live state" posture (src/app/admin/refunds/issue-refund.ts).
async function findExistingLostDisputeReversal(
  stripeClient: StripeDisputeVerificationClient,
  transferId: string,
  disputeId: string,
): Promise<Stripe.TransferReversal | null> {
  const reversals = await stripeClient.transfers
    .listReversals(transferId, { limit: 100 })
    .autoPagingToArray({ limit: 100 });

  return (
    reversals.find(
      (reversal) =>
        reversal.metadata?.librum_operation === LOST_DISPUTE_RECOVERY_OPERATION &&
        reversal.metadata?.stripe_dispute_id === disputeId,
    ) ?? null
  );
}

// The FINAL approved reversal-amount formula (Migration 036 design,
// ROUND 5 CORRECTION -- LAUNCH-1 P1 REOPEN). The round-4 formula below
// this comment used to multiply by transfer.amount directly, treating
// it as if it already represented the author's economic share. It does
// not: under Librum's destination-charge model (application_fee_amount
// + transfer_data.destination, no transfer_data.amount), Stripe
// transfers the FULL GROSS charge amount to the connected account and
// separately claws back application_fee_amount to the platform -- so
// transfer.amount is gross, not net (verified against the installed
// Stripe SDK's own doc comments: Charges.d.ts's application_fee_amount
// field, Refunds.d.ts's reverse_transfer/refund_application_fee text,
// and TransferCreateReversalParams.refund_application_fee's text --
// reconciled cent-by-cent, including the compound prior-partial-
// refund-then-dispute case, in the LAUNCH-1 P1 REOPEN audit). The old
// formula therefore reversed the author's own already-collected
// platform-fee share right along with their true economic proceeds --
// on a 1000/200 sale, a full dispute reversed 1000 from an author who
// had only ever net-received 800. Fixed by introducing
// authorEconomicShare below; everything else about this function's
// existing contract (live Stripe values only, never
// PLATFORM_FEE_PERCENT, remainingTransfer as a hard ceiling, returns
// null rather than a guessed amount on invalid input) is unchanged.
//
// authorEconomicShare: the author's true net proceeds from the ENTIRE
// original charge -- charge.amount minus the HISTORICAL, immutable
// application_fee_amount actually charged at sale time. Deliberately
// read from the Charge object itself, never recomputed from today's
// PLATFORM_FEE_PERCENT: a dispute can arrive long after the sale, and
// if the platform fee percentage ever changes in between, recomputing
// it now would silently apply the WRONG, current percentage to an OLD
// transaction instead of the one actually charged. Capped at
// transfer.amount itself so a hypothetical charge that used
// transfer_data.amount directly (no application_fee_amount at all,
// application_fee_amount null) degrades safely to reversing at most
// what the transfer itself ever carried.
//
// targetAmount: authorEconomicShare's own proportional share of what
// THIS dispute claims, computed against the transfer's ORIGINAL amount
// (fixed, never shrinks) -- not the current remaining balance, which
// would double-apply the dispute's proportion against an already-
// reduced base (see the design report's worked 800/200/50% example for
// why that alternative over-recovers). Note the denominator remains
// charge.amount, not authorEconomicShare -- dispute.amount is always
// expressed against the original charge, and this ratio is what
// authorEconomicShare itself is scaled by.
//
// remainingTransfer (transfer.amount - transfer.amount_reversed) is
// still used ONLY as a hard ceiling -- the same ceiling Stripe itself
// enforces (createReversal() "Can only reverse up to the unreversed
// amount remaining of the transfer") -- amount_reversed is NEVER
// subtracted from targetAmount itself, regardless of what caused a
// prior reversal (an earlier refund's reverse_transfer, or a distinct
// earlier dispute on the same PaymentIntent -- Stripe can exceptionally
// create multiple disputes for one payment; each is identified and
// idempotency-guarded independently by its own stripe_dispute_id via
// claimTransferReversalAttempt/buildTransferReversalIdempotencyKey
// above, but all of them share this ONE aggregate ceiling, which is
// exactly what prevents them from cumulatively over-reversing the
// transfer). Proven correct even after a prior partial refund's own
// reverse_transfer in the P1 REOPEN audit's worked ledger: since
// transfer.amount_reversed already reflects that reversal regardless of
// its source, and targetAmount's own fee-adjusted numerator is what
// keeps the pre-clamp value economically correct, the two compose
// exactly to the author's true remaining share -- no more, no less.
//
// Every input is validated before use -- a malformed Stripe shape (a
// negative or over-large application_fee_amount, a negative or
// inverted transfer/reversal pair, a non-positive dispute amount) fails
// closed (returns null, the caller persists 'failed' with an explicit
// reason) rather than deriving a guessed amount from inconsistent data.
function computeLostDisputeReversalAmountCents(
  transfer: Pick<Stripe.Transfer, "amount" | "amount_reversed">,
  dispute: Pick<Stripe.Dispute, "amount">,
  charge: Pick<Stripe.Charge, "amount" | "application_fee_amount">,
  applicationFee: Pick<Stripe.ApplicationFee, "amount" | "amount_refunded"> | null,
): number | null {
  if (!Number.isFinite(charge.amount) || charge.amount <= 0) {
    return null;
  }
  if (!Number.isFinite(transfer.amount) || !Number.isFinite(transfer.amount_reversed)) {
    return null;
  }
  if (transfer.amount < 0 || transfer.amount_reversed < 0) {
    return null;
  }
  if (transfer.amount_reversed > transfer.amount) {
    return null;
  }
  if (!Number.isFinite(dispute.amount) || dispute.amount <= 0) {
    return null;
  }
  // Stripe's own docs note a dispute's amount can differ from (and in
  // particular exceed) the disputed charge's amount, e.g. via currency
  // fluctuation on a currency-converted charge. Rather than clamp the
  // ratio in that case -- which would silently redefine what "fully
  // disputed" means -- fail closed. This is an intentional product
  // policy for now, not a Stripe guarantee we're relying on.
  if (dispute.amount > charge.amount) {
    return null;
  }

  const applicationFeeAmount = charge.application_fee_amount ?? 0;
  if (!Number.isFinite(applicationFeeAmount) || applicationFeeAmount < 0) {
    return null;
  }
  if (applicationFeeAmount > charge.amount) {
    return null;
  }

  if (applicationFee) {
    if (!Number.isInteger(applicationFee.amount) || applicationFee.amount < 0) {
      return null;
    }
    if (
      !Number.isInteger(applicationFee.amount_refunded) ||
      applicationFee.amount_refunded < 0 ||
      applicationFee.amount_refunded > applicationFee.amount
    ) {
      return null;
    }
  }

  // originalAuthorEconomicShare: what the author was ever entitled to
  // from this sale, in gross-transfer terms -- min() guards against a
  // legacy/foreign transfer whose amount is already net of the fee.
  const originalAuthorEconomicShare = Math.min(transfer.amount, charge.amount - applicationFeeAmount);
  // remainingAuthorEconomicProceeds: originalAuthorEconomicShare, minus
  // every dollar already clawed back via prior transfer reversals
  // (refunds and/or earlier dispute recoveries alike -- transfer.
  // amount_reversed is their live, cumulative, mechanism-agnostic
  // total), plus every dollar of platform-fee refund Librum has ever
  // credited back to the connected account for this charge (Application
  // Fee amount_refunded is likewise live and cumulative). This is the
  // authoritative live-Stripe-state ceiling: it can never be exceeded no
  // matter how many prior refunds/disputes/reversals already happened,
  // in any order, from any source.
  const applicationFeeAmountRefunded = applicationFee?.amount_refunded ?? 0;
  const remainingAuthorEconomicProceeds = Math.max(
    0,
    originalAuthorEconomicShare - transfer.amount_reversed + applicationFeeAmountRefunded,
  );
  const proportionalTarget = Math.round(
    (originalAuthorEconomicShare * dispute.amount) / charge.amount,
  );
  const remainingTransfer = transfer.amount - transfer.amount_reversed;
  const amountToReverseNow = Math.max(
    0,
    Math.min(proportionalTarget, remainingTransfer, remainingAuthorEconomicProceeds),
  );

  return amountToReverseNow;
}

async function succeedTransferReversalAttempt(
  supabase: ReturnType<typeof createAdminClient>,
  disputeId: string,
  reversalId: string | null,
  amountCents: number,
): Promise<void> {
  const { error } = await supabase
    .from("payment_disputes")
    .update({
      transfer_reversal_status: "succeeded",
      stripe_transfer_reversal_id: reversalId,
      transfer_reversal_amount_cents: amountCents,
      transfer_reversal_succeeded_at: new Date().toISOString(),
      transfer_reversal_failure_code: null,
      transfer_reversal_failure_message: null,
    })
    .eq("stripe_dispute_id", disputeId);

  if (error) {
    console.error(
      "Stripe webhook: failed to persist a succeeded lost-dispute transfer reversal -- needs manual reconciliation",
      { disputeId, reversalId, amountCents, error },
    );
  }
}

async function failTransferReversalAttempt(
  supabase: ReturnType<typeof createAdminClient>,
  disputeId: string,
  message: string,
  code?: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("payment_disputes")
    .update({
      transfer_reversal_status: "failed",
      transfer_reversal_failure_code: code ?? null,
      transfer_reversal_failure_message: message,
    })
    .eq("stripe_dispute_id", disputeId);

  if (error) {
    console.error(
      "Stripe webhook: failed to persist a failed lost-dispute transfer reversal -- needs manual reconciliation",
      { disputeId, message, error },
    );
  }
}

// The core orchestration: claim -> resolve charge/transfer -> check for
// an already-existing reversal (unconditionally, before any mutation
// call) -> compute the amount -> reverse -> persist. Shared by both the
// webhook's own immediate call (processDisputeEvent above,
// staleAttemptingCutoff omitted/null) and the reconciliation route
// (src/app/api/internal/reconcile-transfer-reversals/route.ts, which
// passes an actual cutoff) -- the exact same function, not a
// duplicated copy, so both call sites are guaranteed to apply identical
// claim/idempotency/amount/reconciliation logic.
//
// Exported (only) for the same reason as every other handler in this
// file: direct testability with fake Supabase/Stripe clients.
export type TransferReversalOutcome =
  | { kind: "not_lost" }
  | { kind: "not_claimed" }
  | { kind: "reconciled_existing"; reversalId: string; amountCents: number }
  | { kind: "reversed"; reversalId: string; amountCents: number }
  | { kind: "nothing_to_reverse" }
  | { kind: "failed"; message: string };

export async function reverseAuthorTransferForLostDispute(
  supabase: ReturnType<typeof createAdminClient>,
  stripeClient: StripeDisputeVerificationClient,
  dispute: Stripe.Dispute,
  staleAttemptingCutoff: Date | null = null,
): Promise<TransferReversalOutcome> {
  if (dispute.status !== "lost") {
    return { kind: "not_lost" };
  }

  const claim = await claimTransferReversalAttempt(supabase, dispute.id, staleAttemptingCutoff);
  if (!claim) {
    return { kind: "not_claimed" };
  }

  const resolved = await resolveDisputeChargeAndTransfer(stripeClient, dispute);
  if ("error" in resolved) {
    await failTransferReversalAttempt(supabase, dispute.id, resolved.error);
    return { kind: "failed", message: resolved.error };
  }
  const { charge, transferId, applicationFee } = resolved;

  if (!claim.existingTransferId) {
    const { error: linkError } = await supabase
      .from("payment_disputes")
      .update({ stripe_transfer_id: transferId })
      .eq("stripe_dispute_id", dispute.id);
    if (linkError) {
      console.error(
        "Stripe webhook: failed to cache the resolved transfer id for a lost dispute -- non-fatal, will be re-resolved next attempt",
        { disputeId: dispute.id, transferId, error: linkError },
      );
    }
  }

  // Unconditional, before ANY createReversal() call -- see
  // findExistingLostDisputeReversal's own documentation. Recovers an
  // unknown-outcome retry (a crash/timeout after Stripe already
  // processed the original call) without ever performing a second
  // Stripe mutation.
  const existing = await findExistingLostDisputeReversal(stripeClient, transferId, dispute.id);
  if (existing) {
    await succeedTransferReversalAttempt(supabase, dispute.id, existing.id, existing.amount);
    return { kind: "reconciled_existing", reversalId: existing.id, amountCents: existing.amount };
  }

  let transfer: Stripe.Transfer;
  try {
    transfer = await stripeClient.transfers.retrieve(transferId);
  } catch (error) {
    const message = `failed to retrieve destination transfer: ${
      error instanceof Error ? error.message : String(error)
    }`;
    await failTransferReversalAttempt(supabase, dispute.id, message);
    return { kind: "failed", message };
  }

  const amountToReverseNow = computeLostDisputeReversalAmountCents(
    transfer,
    dispute,
    charge,
    applicationFee,
  );
  if (amountToReverseNow === null) {
    const message = "unable to compute a safe reversal amount from live Stripe state";
    await failTransferReversalAttempt(supabase, dispute.id, message);
    return { kind: "failed", message };
  }

  if (amountToReverseNow === 0) {
    // Nothing left to recover -- either the transfer is already fully
    // reversed (e.g. an earlier full refund's reverse_transfer already
    // covered it), or the computed target itself rounds to zero.
    // Recorded succeeded with a zero amount and no reversal id, not
    // left 'attempting' forever, and not treated as an error.
    await succeedTransferReversalAttempt(supabase, dispute.id, null, 0);
    return { kind: "nothing_to_reverse" };
  }

  const idempotencyKey = buildTransferReversalIdempotencyKey(dispute.id, claim.attemptCount);

  let reversal: Stripe.TransferReversal;
  try {
    reversal = await stripeClient.transfers.createReversal(
      transferId,
      {
        amount: amountToReverseNow,
        metadata: {
          librum_operation: LOST_DISPUTE_RECOVERY_OPERATION,
          stripe_dispute_id: dispute.id,
          stripe_payment_intent_id: claim.paymentIntentId,
          recovery_formula_version: LOST_DISPUTE_RECOVERY_FORMULA_VERSION,
        },
      },
      { idempotencyKey },
    );
  } catch (error) {
    const stripeError = error as { code?: string; message?: string };
    const message = stripeError.message ?? String(error);
    await failTransferReversalAttempt(supabase, dispute.id, message, stripeError.code ?? null);
    return { kind: "failed", message };
  }

  await succeedTransferReversalAttempt(supabase, dispute.id, reversal.id, reversal.amount);
  return { kind: "reversed", reversalId: reversal.id, amountCents: reversal.amount };
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
    const bundleId = session.metadata?.bundle_id;
    const readerId = session.metadata?.reader_id;
    const snapshotId = session.metadata?.snapshot_id;
    // LAUNCH-1 P1-4: single-book checkouts carry metadata.intent_id
    // (book_checkout_intents.id, migration 032) since buyBook stopped
    // putting book_id/reader_id in Stripe metadata directly -- both are
    // now resolved server-side, inside finalize_book_checkout_intent,
    // from the intent row itself.
    const intentId = session.metadata?.intent_id;
    const paymentIntentId = extractPaymentIntentId(session.payment_intent);
    const amountCents = session.amount_total ?? 0;

    // NEW bundle checkouts (created once buyBundle is updated to use
    // the migration-025 snapshot RPC) carry metadata.snapshot_id and
    // are fulfilled entirely from that durable, frozen row. Checkout
    // Sessions created before that change carry the LEGACY
    // metadata.bundle_id + reader_id shape instead, and must keep being
    // fulfilled by fulfillLegacyBundle below for as long as any of them
    // could still be open -- see the Phase 9B-2 rollout plan for when
    // that legacy branch can eventually be removed.
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
      const failureResponse = await fulfillLegacyBundle(
        supabase,
        event,
        session,
        bundleId,
        readerId,
        paymentIntentId,
        amountCents,
        failWebhook,
      );
      if (failureResponse) {
        return failureResponse;
      }
    } else if (intentId) {
      const supabase = createAdminClient();
      const failureResponse = await fulfillSingleBookPurchase(
        supabase,
        event,
        session,
        intentId,
        paymentIntentId,
        amountCents,
        failWebhook,
      );
      if (failureResponse) {
        return failureResponse;
      }
    }
  }

  // Revokes the reader's access. Only purchases made after
  // stripe_payment_intent_id started being recorded can be matched here —
  // see the note in migrations/011_add_refunds.sql.
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    const supabase = createAdminClient();
    const failureResponse = await processChargeRefundedEvent(
      supabase,
      stripe,
      event,
      charge,
      failWebhook,
    );
    if (failureResponse) {
      return failureResponse;
    }
  }

  // REFUND-1B Step 5 correction: catches a refund that was still
  // pending/requires_action when (or if) charge.refunded fired, and has
  // now settled to succeeded/failed -- see processRefundLifecycleEvent's
  // own documentation above for the full rationale. refund.created is
  // included alongside refund.updated because a refund that resolves
  // synchronously can arrive already 'succeeded' on its very first event.
  if (event.type === "refund.updated" || event.type === "refund.created") {
    const refund = event.data.object as Stripe.Refund;
    const supabase = createAdminClient();
    const failureResponse = await processRefundLifecycleEvent(
      supabase,
      stripe,
      event,
      refund,
      failWebhook,
    );
    if (failureResponse) {
      return failureResponse;
    }
  }

  // Log-only: gives an operator visibility into a refund that failed
  // after being created, without attempting any automatic reversal of
  // Librum state. No rollback semantics are implemented here -- see
  // processRefundLifecycleEvent's own documentation for why building
  // that machinery isn't justified by anything confirmed reachable in
  // practice for a card-based Checkout charge.
  if (event.type === "refund.failed") {
    const refund = event.data.object as Stripe.Refund;
    console.error("Stripe webhook: a refund failed after being created", {
      eventId: event.id,
      refundId: refund.id,
      paymentIntentId: extractPaymentIntentId(refund.payment_intent),
      chargeId: extractChargeId(refund.charge),
      failureReason: refund.failure_reason ?? null,
    });
  }

  // LAUNCH-1 P1-7A: all five charge.dispute.* event types Stripe emits
  // (confirmed against the installed stripe@22.5.0 SDK's own Events.d.ts
  // union -- created, updated, closed, funds_withdrawn, funds_reinstated)
  // route into the same processDisputeEvent, which re-fetches the
  // dispute's live state and upserts public.payment_disputes. See that
  // function's own documentation for why one handler correctly covers
  // all five (each is just "something about this dispute changed, go
  // re-sync it") and why no event-ordering assumption is needed.
  if (
    event.type === "charge.dispute.created" ||
    event.type === "charge.dispute.updated" ||
    event.type === "charge.dispute.closed" ||
    event.type === "charge.dispute.funds_withdrawn" ||
    event.type === "charge.dispute.funds_reinstated"
  ) {
    const dispute = event.data.object as Stripe.Dispute;
    const supabase = createAdminClient();
    const failureResponse = await processDisputeEvent(
      supabase,
      stripe,
      event,
      dispute.id,
      failWebhook,
    );
    if (failureResponse) {
      return failureResponse;
    }
  }

  return NextResponse.json({ received: true });
}
