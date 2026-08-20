import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPurchaseEmails, sendBundlePurchaseEmails } from "@/lib/email";

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
    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : null;
    const amountCents = session.amount_total ?? 0;

    if (bundleId && readerId) {
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
