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
      const { data: bundleBooks } = await supabase
        .from("bundle_books")
        .select("book_id, books(price_cents)")
        .eq("bundle_id", bundleId)
        .returns<{ book_id: string; books: { price_cents: number } | null }[]>();

      const items = bundleBooks ?? [];
      const totalOriginalCents = items.reduce(
        (sum, item) => sum + (item.books?.price_cents ?? 0),
        0,
      );

      for (const item of items) {
        const share =
          totalOriginalCents > 0
            ? Math.round((amountCents * (item.books?.price_cents ?? 0)) / totalOriginalCents)
            : Math.round(amountCents / items.length);

        await supabase.from("purchases").upsert(
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
      }

      await sendBundlePurchaseEmails(supabase, { bundleId, readerId, amountCents });
    } else if (bookId && readerId) {
      const supabase = createAdminClient();

      await supabase.from("purchases").upsert(
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
      await supabase
        .from("purchases")
        .update({ refunded_at: new Date().toISOString() })
        .eq("stripe_payment_intent_id", paymentIntentId)
        .is("refunded_at", null);
    }
  }

  return NextResponse.json({ received: true });
}
