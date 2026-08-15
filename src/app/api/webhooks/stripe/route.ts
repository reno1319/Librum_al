import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendPurchaseEmails } from "@/lib/email";

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
    const readerId = session.metadata?.reader_id;

    if (bookId && readerId) {
      const supabase = createAdminClient();
      const amountCents = session.amount_total ?? 0;

      await supabase.from("purchases").upsert(
        {
          book_id: bookId,
          reader_id: readerId,
          stripe_checkout_session_id: session.id,
          stripe_payment_intent_id:
            typeof session.payment_intent === "string" ? session.payment_intent : null,
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
